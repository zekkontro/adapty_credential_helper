// Play Console content script. Drives the full invite flow:
//   1) If URL still has the `_` placeholder (account picker), wait for
//      the user to pick an account — Play Console fills the developer
//      id into the URL.
//   2) Once we have a developer id, navigate straight to
//      /users-and-permissions/invite.
//   3) On the invite form: auto-fill the service-account email → open
//      the "Account permissions" tab → tick the 7 required permissions
//      by their stable debug-ids → click Invite user.
//   4) Observe the redirect back to /users-and-permissions, then ask the
//      user for their Android package name and submit the full Play
//      credentials to the service worker for persistence.

import { Overlay } from "@/overlay/wizard";
import { PageDimmer } from "@/overlay/page-dimmer";
import type {
  CaptureState,
  ExtensionMessage,
  PlayStoreCaptured,
} from "@/shared/types";
import {
  AutomationStepError,
  buildUsersInviteUrl,
  classifyPlayPage,
  clickAccountPermissionsTab,
  clickInviteConfirmButton,
  clickInviteSubmit,
  fillInviteEmail,
  getDeveloperId,
  highlightAccountPickerCards,
  navigateTo,
  sleep,
  tickPermissionByDebugId,
  waitForInviteSent,
  type CleanupFn,
  type PlayPageKind,
} from "@/content/play-automate";

const STEP_DELAY_MS = 2000;
const STEP_INTRA_MS = 250;

// NOTE: "can-mange-public-listing" is a real typo in Play Console's
// debug-id (missing 'a') — keep exactly as-is.
const REQUIRED_PERMISSION_DEBUG_IDS: readonly string[] = [
  "developer-permission-can-view-non-financial-data-global",
  "developer-permission-can-mange-public-listing",
  "developer-permission-can-reply-to-reviews",
  "developer-permission-can-view-financial-data",
  "developer-permission-can-manage-orders",
  "developer-permission-can-manage-track-apks",
  "developer-permission-can-manage-public-apks",
];

const PACKAGE_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

type FlowStage =
  | "scanning"
  | "awaiting_account_pick"
  | "navigating_to_invite"
  | "automating_invite"
  | "awaiting_invite_completion"
  | "awaiting_package_name"
  | "saving"
  | "success"
  | "error";

type ProgressStep =
  | "nav_invite"
  | "fill_email"
  | "open_perms_tab"
  | "tick_permissions"
  | "submit_invite"
  | "confirm_invite"
  | "watch_invite_sent";

const PROGRESS_LABEL: Record<ProgressStep, string> = {
  nav_invite: "Opening the Invite user form",
  fill_email: "Pasting the service-account email",
  open_perms_tab: "Opening Account permissions tab",
  tick_permissions: "Granting required permissions",
  submit_invite: "Submitting the invitation",
  confirm_invite: "Confirming the invitation",
  watch_invite_sent: "Waiting for Play Console to confirm",
};

interface FlowState {
  stage: FlowStage;
  progress: ProgressStep | null;
  serviceAccountEmail: string | null;
  serviceAccountJson: string | null;
  projectId: string | null;
  packageName: string;
  packageNameError: string | null;
  manualHint: string | null;
  error: string | null;
}

const state: FlowState = {
  stage: "scanning",
  progress: null,
  serviceAccountEmail: null,
  serviceAccountJson: null,
  projectId: null,
  packageName: "",
  packageNameError: null,
  manualHint: null,
  error: null,
};

let overlay: Overlay | null = null;
let dimmer: PageDimmer | null = null;
let overlayActivated = false;
let captureState: CaptureState = { stage: "idle" };
let lastUrl: string = location.href;

let accountPickerCleanup: CleanupFn | null = null;
let inviteAutomationRunning = false;
let inviteCompletionWatcher: Promise<void> | null = null;

function clearAccountPickerHighlights(): void {
  accountPickerCleanup?.();
  accountPickerCleanup = null;
}

function packageNameValid(pkg: string): boolean {
  return PACKAGE_NAME_RE.test(pkg);
}

function render(): void {
  if (!overlay) return;
  const s = state;

  const steps = [
    {
      title: "Select your Play Console developer account",
      active: s.stage === "awaiting_account_pick",
      done:
        s.stage !== "awaiting_account_pick" &&
        s.stage !== "scanning",
    },
    {
      title:
        s.progress &&
        [
          "nav_invite",
          "fill_email",
          "open_perms_tab",
          "tick_permissions",
          "submit_invite",
          "watch_invite_sent",
        ].includes(s.progress)
          ? `<strong>${PROGRESS_LABEL[s.progress]}…</strong>`
          : "Invite the service account with required permissions",
      active:
        s.stage === "navigating_to_invite" ||
        s.stage === "automating_invite" ||
        s.stage === "awaiting_invite_completion",
      done: s.stage === "awaiting_package_name" || s.stage === "success",
    },
    {
      title: "Enter your app's package name",
      active: s.stage === "awaiting_package_name",
      done: s.stage === "success",
    },
    {
      title: "Send credentials back to Adapty",
      active: s.stage === "saving",
      done: s.stage === "success",
    },
  ];

  let alert: { kind: "info" | "error" | "success"; text: string } | undefined;
  if (s.stage === "success") {
    alert = {
      kind: "success",
      text: "Credentials captured. Returning to the Adapty onboarding tab.",
    };
  } else if (s.stage === "error") {
    alert = { kind: "error", text: s.error || "Something went wrong." };
  } else if (s.stage === "saving") {
    alert = { kind: "info", text: "Saving…" };
  } else if (s.stage === "awaiting_account_pick") {
    alert = {
      kind: "success",
      text: "👉 Pick the Play Console developer account for this app — we'll take over the rest.",
    };
  } else if (s.stage === "awaiting_invite_completion") {
    alert = {
      kind: "info",
      text:
        "Waiting for Play Console to confirm the invitation. If the page doesn't change, press Invite user manually.",
    };
  } else if (s.stage === "awaiting_package_name") {
    alert = {
      kind: "info",
      text:
        "One last thing: enter the Android package name of the app you want Adapty to manage.",
    };
  } else if (s.progress) {
    alert = { kind: "info", text: `${PROGRESS_LABEL[s.progress]}…` };
  } else if (s.manualHint) {
    alert = { kind: "success", text: `👉 ${s.manualHint}` };
  }

  const chips = [
    {
      label: "Service account",
      status: s.serviceAccountEmail ? ("ok" as const) : ("pending" as const),
      value: s.serviceAccountEmail ?? undefined,
    },
    {
      label: "Package name",
      status: packageNameValid(s.packageName)
        ? ("ok" as const)
        : ("pending" as const),
      value: packageNameValid(s.packageName) ? s.packageName : undefined,
    },
  ];

  const actions: Array<{
    id: string;
    label: string;
    primary?: boolean;
    disabled?: boolean;
  }> = [];

  if (s.stage === "awaiting_package_name") {
    actions.push({
      id: "save",
      label: "Save",
      primary: true,
      disabled: !packageNameValid(s.packageName),
    });
  } else if (s.stage === "success") {
    actions.push({ id: "close", label: "Done", primary: true });
  } else if (s.stage === "error") {
    actions.push({ id: "retry", label: "Try again", primary: true });
  }

  const fields = s.stage === "awaiting_package_name"
    ? [
        {
          id: "package_name",
          label: "Package name",
          placeholder: "com.yourcompany.app",
          value: s.packageName,
          pattern: "^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$",
          helpText:
            "Use the applicationId from your build.gradle (e.g. com.example.myapp).",
          errorText: s.packageNameError ?? undefined,
        },
      ]
    : undefined;

  overlay.render({
    title: "Adapty · Play Console",
    steps,
    alert,
    chips,
    fields,
    actions,
  });

  updateDimmer();
}

function updateDimmer(): void {
  if (!dimmer) return;
  const s = state;
  if (s.stage === "navigating_to_invite") {
    dimmer.show({
      title: "Opening the invite form",
      subtitle: "Taking you to the service-account invite page.",
    });
  } else if (s.stage === "automating_invite") {
    dimmer.show({
      title: "Automating the invite form",
      subtitle:
        "Pasting the email, picking Account permissions, ticking 7 required permissions, and clicking Invite user.",
    });
  } else if (
    s.stage === "awaiting_invite_completion" &&
    !s.manualHint
  ) {
    dimmer.show({
      title: "Finishing the invitation",
      subtitle:
        "Waiting for Play Console to confirm the invitation went out.",
    });
  } else if (s.stage === "saving") {
    dimmer.show({
      title: "Finalizing",
      subtitle: "Packing credentials to send back to Adapty.",
    });
  } else {
    dimmer.hide();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// URL routing
// ─────────────────────────────────────────────────────────────────────────────

function observeUrlChanges(): void {
  const check = (): void => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onUrlChange();
    }
  };
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    origPush.apply(history, args);
    check();
  };
  history.replaceState = function (...args) {
    origReplace.apply(history, args);
    check();
  };
  window.addEventListener("popstate", check);
  window.setInterval(check, 500);
}

function onUrlChange(): void {
  const page = classifyPlayPage();
  applyStageForPage(page);
  render();
}

function applyStageForPage(page: PlayPageKind): void {
  if (
    state.stage === "success" ||
    state.stage === "saving" ||
    state.stage === "awaiting_package_name"
  ) {
    return;
  }

  const devId = getDeveloperId();

  if (page === "account_picker" || !devId) {
    clearAccountPickerHighlights();
    state.stage = "awaiting_account_pick";
    state.progress = null;
    state.manualHint = null;
    window.setTimeout(() => {
      if (getDeveloperId()) return;
      accountPickerCleanup = highlightAccountPickerCards();
    }, 300);
    return;
  }

  clearAccountPickerHighlights();

  if (page === "invite_user") {
    state.stage = "automating_invite";
    state.progress = null;
    state.manualHint = null;
    startInviteCompletionWatcher();
    void runInviteAutomation();
    return;
  }

  if (
    page === "users_permissions_list" ||
    page === "app_list" ||
    page === "developer_home" ||
    page === "other"
  ) {
    state.stage = "navigating_to_invite";
    state.progress = "nav_invite";
    state.manualHint = null;
    window.setTimeout(() => {
      if (classifyPlayPage() === "invite_user") return;
      navigateTo(buildUsersInviteUrl(devId));
    }, 150);
  }
}

function startInviteCompletionWatcher(): void {
  if (inviteCompletionWatcher) return;
  inviteCompletionWatcher = waitForInviteSent()
    .then(() => {
      state.stage = "awaiting_package_name";
      state.progress = null;
      state.manualHint = null;
      render();
    })
    .catch(() => {
      // non-fatal
    })
    .finally(() => {
      inviteCompletionWatcher = null;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Invite automation
// ─────────────────────────────────────────────────────────────────────────────

async function runInviteAutomation(): Promise<void> {
  if (inviteAutomationRunning) return;
  if (!state.serviceAccountEmail) {
    state.stage = "error";
    state.error =
      "Service account email not found. Please restart the flow on Google Cloud first.";
    render();
    return;
  }
  inviteAutomationRunning = true;
  state.stage = "automating_invite";
  state.error = null;
  try {
    state.progress = "fill_email";
    render();
    await fillInviteEmail(state.serviceAccountEmail);
    await sleep(STEP_DELAY_MS);

    state.progress = "open_perms_tab";
    render();
    try {
      await clickAccountPermissionsTab();
    } catch {
      // continue
    }
    await sleep(STEP_DELAY_MS);

    state.progress = "tick_permissions";
    render();
    for (const debugId of REQUIRED_PERMISSION_DEBUG_IDS) {
      try {
        await tickPermissionByDebugId(debugId);
      } catch (err) {
        console.warn("[adapty/play] missing permission checkbox:", debugId, err);
      }
      await sleep(STEP_INTRA_MS);
    }
    await sleep(STEP_DELAY_MS);

    state.progress = "submit_invite";
    render();
    await clickInviteSubmit();
    await sleep(STEP_DELAY_MS);

    state.progress = "confirm_invite";
    render();
    try {
      await clickInviteConfirmButton();
    } catch (err) {
      console.warn("[adapty/play] invite confirm dialog not found:", err);
    }

    state.stage = "awaiting_invite_completion";
    state.progress = "watch_invite_sent";
    render();
    startInviteCompletionWatcher();
  } catch (err) {
    state.progress = null;
    state.stage = "awaiting_invite_completion";
    state.manualHint =
      err instanceof AutomationStepError
        ? `Finish the invite manually (stopped at "${err.step}"). We'll pick up when the invitation is sent.`
        : "Finish the invite manually. We'll pick up when the invitation is sent.";
    startInviteCompletionWatcher();
    render();
  } finally {
    inviteAutomationRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Save action
// ─────────────────────────────────────────────────────────────────────────────

async function runSave(): Promise<void> {
  if (!packageNameValid(state.packageName)) {
    state.packageNameError =
      "Use reverse-domain format (e.g. com.yourcompany.app).";
    render();
    return;
  }
  if (!state.serviceAccountJson) {
    state.stage = "error";
    state.error = "Service account JSON not found. Please restart the flow.";
    render();
    return;
  }
  state.stage = "saving";
  state.packageNameError = null;
  state.error = null;
  render();

  const projectId = state.projectId ?? "service-account";
  const creds: PlayStoreCaptured = {
    service_account_json: state.serviceAccountJson,
    package_name: state.packageName,
    service_account_filename: `${projectId}.json`,
    captured_at: Date.now(),
  };
  const msg: ExtensionMessage = {
    type: "OVERLAY_SUBMIT_CREDENTIALS",
    store_type: "playstore",
    credentials: creds,
  };
  try {
    const resp = await chrome.runtime.sendMessage(msg);
    if (!resp?.ok) {
      state.stage = "error";
      state.error = resp?.error || "Failed to store credentials";
    } else {
      state.stage = "success";
    }
  } catch (err) {
    state.stage = "error";
    state.error = err instanceof Error ? err.message : String(err);
  }
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

async function loadStashedCredentials(): Promise<void> {
  try {
    const entry = await chrome.storage.session.get([
      "adapty_gcp_service_account_email",
      "adapty_gcp_service_account_json",
      "adapty_gcp_project_id",
    ]);
    const email = entry["adapty_gcp_service_account_email"];
    const json = entry["adapty_gcp_service_account_json"];
    const projectId = entry["adapty_gcp_project_id"];
    state.serviceAccountEmail = typeof email === "string" ? email : null;
    state.serviceAccountJson = typeof json === "string" ? json : null;
    state.projectId = typeof projectId === "string" ? projectId : null;
  } catch (err) {
    console.warn("[adapty/play] session storage read failed:", err);
  }
}

async function refreshCaptureState(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "OVERLAY_GET_STATE",
      });
      captureState = (resp?.state as CaptureState) ?? { stage: "idle" };
      return;
    } catch {
      if (attempt === 2) {
        captureState = { stage: "idle" };
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function isActivePlayCapture(s: CaptureState): boolean {
  return s.stage === "capturing_playstore";
}

function ensureOverlayActivated(): void {
  if (overlayActivated) return;
  overlayActivated = true;

  overlay = new Overlay({ align: "right" });
  overlay.mount();
  dimmer = new PageDimmer();
  dimmer.onCancel(() => {
    state.stage = "awaiting_invite_completion";
    state.progress = null;
    state.manualHint =
      "Finish the invite on Play Console yourself — we'll pick up once the invitation is sent.";
    startInviteCompletionWatcher();
    render();
  });
  render();
  overlay.onAction((id) => {
    if (id === "__close__" || id === "close") {
      clearAccountPickerHighlights();
      overlay?.unmount();
      overlay = null;
      dimmer?.hide();
      dimmer = null;
      overlayActivated = false;
      return;
    }
    if (id === "save") {
      void runSave();
      return;
    }
    if (id === "retry") {
      state.error = null;
      state.packageNameError = null;
      applyStageForPage(classifyPlayPage());
      render();
    }
  });
  overlay.onInput((id, value) => {
    if (id === "package_name") {
      state.packageName = value.trim();
      state.packageNameError = null;
      render();
    }
  });

  observeUrlChanges();

  void (async () => {
    await loadStashedCredentials();
    applyStageForPage(classifyPlayPage());
    render();
  })();

  chrome.storage.session.onChanged.addListener((changes) => {
    try {
      if (
        "adapty_gcp_service_account_email" in changes ||
        "adapty_gcp_service_account_json" in changes ||
        "adapty_gcp_project_id" in changes
      ) {
        void loadStashedCredentials().then(() => render());
      }
    } catch (err) {
      console.warn("[adapty/play] storage listener error:", err);
    }
  });
}

async function init(): Promise<void> {
  chrome.storage.session.onChanged.addListener(async (changes) => {
    try {
      if ("adapty_capture_state" in changes) {
        await refreshCaptureState();
        if (isActivePlayCapture(captureState)) ensureOverlayActivated();
        render();
      }
    } catch (err) {
      console.warn("[adapty/play] capture listener error:", err);
    }
  });

  await refreshCaptureState();
  if (isActivePlayCapture(captureState)) {
    ensureOverlayActivated();
    return;
  }

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    await refreshCaptureState();
    if (isActivePlayCapture(captureState)) {
      ensureOverlayActivated();
      return;
    }
  }
}

init();
