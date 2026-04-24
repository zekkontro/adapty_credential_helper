// Google Cloud Console content script. Orchestrates service-account + JSON
// key creation across four URLs (project picker → SA list → create → keys),
// captures the JSON via blob-hook, and stashes it in session storage for the
// Play Console content script to pick up. The final save happens at the end
// of the Play Console flow once we also have the user's package name.

import { Overlay } from "@/overlay/wizard";
import { PageDimmer } from "@/overlay/page-dimmer";
import type { CaptureState } from "@/shared/types";
import {
  AutomationStepError,
  buildMarketplaceUrl,
  buildServiceAccountsUrl,
  classifyGcpPage,
  clickCreateAndContinue,
  clickCreateKeyButton,
  clickCreateNewKeyMenuItem,
  clickCreateServiceAccountToolbarButton,
  clickDone,
  clickEnableApiButton,
  clickKeysTab,
  clickServiceAccountRowByEmail,
  clickStep2Continue,
  fillServiceAccountForm,
  getGcpProjectId,
  getMarketplaceServiceName,
  highlightProjectPicker,
  isApiAlreadyEnabled,
  openAddKeyMenu,
  REQUIRED_PLAY_APIS,
  selectJsonRadio,
  selectPlayStoreRoles,
  sleep,
  snapshotServiceAccountEmails,
  waitFor,
  waitForNewServiceAccount,
  type GcpProgressStep,
} from "@/content/gcp-automate";

const STEP_DELAY_MS = 2000;
// Google's "Enable API" click completes server-side and usually swaps the
// button to "Manage" within 10-15 seconds. Give it the full 15 s so we don't
// advance while the API is still propagating and mis-classify the next page.
const API_ENABLE_WAIT_MS = 15_000;

interface ServiceAccountKey {
  type?: string;
  client_email?: string;
  private_key?: string;
  project_id?: string;
}

type FlowStage =
  | "scanning"
  | "await_project"
  | "enabling_apis"
  | "automating_sa"
  | "awaiting_user_action"
  | "creating_key"
  | "key_captured"
  | "error";

const PROGRESS_LABEL: Record<GcpProgressStep, string> = {
  await_project: "Waiting for project selection",
  check_api: "Checking Google Play API status",
  enabling_api: "Enabling Google Play API",
  return_to_sa: "Returning to service accounts",
  open_create_form: "Opening Create service account form",
  fill_sa_form: "Naming the service account",
  submit_create: "Creating the service account",
  select_role: "Granting Pub/Sub Admin + Monitoring Viewer roles",
  advance_step2: "Advancing through permissions",
  skip_optional_steps: "Finishing the form",
  open_sa_detail: "Opening the service account",
  open_keys_tab: "Opening the Keys tab",
  open_add_key_menu: "Opening Add Key menu",
  select_json: "Selecting JSON key type",
  submit_create_key: "Creating the JSON key",
};

const API_DISPLAY_NAMES: Record<string, string> = {
  "androidpublisher.googleapis.com": "Google Play Android Developer API",
  "playdeveloperreporting.googleapis.com":
    "Google Play Developer Reporting API",
};

function apisVerifiedKey(projectId: string): string {
  return `adapty_gcp_apis_verified:${projectId}`;
}

interface FlowState {
  stage: FlowStage;
  progress: GcpProgressStep | null;
  serviceAccountEmail: string | null;
  serviceAccountJson: string | null;
  projectId: string | null;
  apiIndex: number;
  apisVerified: boolean;
  currentApiName: string | null;
  manualHint: string | null;
  error: string | null;
}

const state: FlowState = {
  stage: "scanning",
  progress: null,
  serviceAccountEmail: null,
  serviceAccountJson: null,
  projectId: null,
  apiIndex: 0,
  apisVerified: false,
  currentApiName: null,
  manualHint: null,
  error: null,
};

let overlay: Overlay | null = null;
let dimmer: PageDimmer | null = null;
let overlayActivated = false;
let captureState: CaptureState = { stage: "idle" };
let lastUrl: string = location.href;
let saEmailsBeforeCreate: Set<string> | null = null;
let removeProjectHighlight: (() => void) | null = null;

function makeServiceAccountName(): string {
  // GCP caps display name at 100 chars; SA ID (derived) caps at 30 chars
  // (lowercase letters, digits, hyphens). Format: adapty-YYYYMMDDHHMM (21 chars).
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `adapty-${y}${m}${d}${hh}${mm}`;
}

function parseIfLooksLikeKey(text: string): ServiceAccountKey | null {
  try {
    const v = JSON.parse(text) as ServiceAccountKey;
    if (v && v.type === "service_account" && typeof v.client_email === "string") {
      return v;
    }
  } catch {
    // not JSON
  }
  return null;
}

function render(): void {
  if (!overlay) return;
  const s = state;
  const page = classifyGcpPage();

  const apiProgress =
    s.apiIndex < REQUIRED_PLAY_APIS.length
      ? `${s.apiIndex + 1}/${REQUIRED_PLAY_APIS.length}`
      : `${REQUIRED_PLAY_APIS.length}/${REQUIRED_PLAY_APIS.length}`;

  const stepList = [
    {
      title: "Select a Google Cloud project",
      active: page === "project_picker" || s.stage === "await_project",
      done: !!s.projectId || page !== "project_picker",
    },
    {
      title:
        s.stage === "enabling_apis" && s.currentApiName
          ? `<strong>Enabling Google Play APIs — ${apiProgress}: ${s.currentApiName}</strong>`
          : "Enable required Google Play APIs",
      active: s.stage === "enabling_apis",
      done: s.apisVerified,
    },
    {
      title:
        s.progress &&
        [
          "open_create_form",
          "fill_sa_form",
          "submit_create",
          "select_role",
          "advance_step2",
          "skip_optional_steps",
        ].includes(s.progress)
          ? `<strong>${PROGRESS_LABEL[s.progress]}…</strong>`
          : "Create a service account with the Editor role",
      active: s.stage === "automating_sa" && !s.serviceAccountEmail,
      done: !!s.serviceAccountEmail,
    },
    {
      title:
        s.progress &&
        [
          "open_sa_detail",
          "open_keys_tab",
          "open_add_key_menu",
          "select_json",
          "submit_create_key",
        ].includes(s.progress)
          ? `<strong>${PROGRESS_LABEL[s.progress]}…</strong>`
          : "Create a JSON key and capture it",
      active:
        s.stage === "creating_key" ||
        (s.stage === "automating_sa" && !!s.serviceAccountEmail),
      done: !!s.serviceAccountJson,
    },
    {
      title: "Hand off to Play Console",
      active: s.stage === "key_captured",
      done: false,
    },
  ];

  let alert: { kind: "info" | "error" | "success"; text: string } | undefined;
  if (s.stage === "error") {
    alert = { kind: "error", text: s.error || "Automation error." };
  } else if (s.stage === "key_captured") {
    alert = {
      kind: "success",
      text:
        "Service account key captured! Opening Play Console to finish the invite step…",
    };
  } else if (s.stage === "await_project" || page === "project_picker") {
    alert = {
      kind: "info",
      text: "Select an existing project or click Create project to make a new one. We'll take over once a project is picked.",
    };
  } else if (s.stage === "awaiting_user_action" && s.manualHint) {
    alert = {
      kind: "success",
      text: `👉 ${s.manualHint}`,
    };
  } else if (s.progress) {
    alert = { kind: "info", text: `${PROGRESS_LABEL[s.progress]}…` };
  }

  const actions: Array<{
    id: string;
    label: string;
    primary?: boolean;
    disabled?: boolean;
  }> = [];

  if (s.stage === "error") {
    actions.push({ id: "retry", label: "Try again", primary: true });
  } else if (s.stage === "awaiting_user_action" && s.apiIndex < REQUIRED_PLAY_APIS.length && !s.apisVerified) {
    actions.push({ id: "retry_api", label: "Retry", primary: true });
  }

  overlay.render({
    title: "Adapty · Google Cloud Console",
    steps: stepList,
    alert,
    chips: [
      {
        label: "Project",
        status: s.projectId ? "ok" : "pending",
        value: s.projectId ?? undefined,
      },
      {
        label: "Google Play APIs",
        status: s.apisVerified ? "ok" : "pending",
        value: s.apisVerified
          ? "enabled"
          : s.stage === "enabling_apis"
            ? `${s.apiIndex + 1}/${REQUIRED_PLAY_APIS.length}`
            : undefined,
      },
      {
        label: "Service account",
        status: s.serviceAccountEmail ? "ok" : "pending",
        value: s.serviceAccountEmail ?? undefined,
      },
      { label: "JSON key", status: s.serviceAccountJson ? "ok" : "pending" },
    ],
    actions,
  });

  ensureJsonDropZone();
  updateDimmer();
}

function updateDimmer(): void {
  if (!dimmer) return;
  const s = state;
  if (s.stage === "enabling_apis") {
    const step = s.currentApiName ?? "Google Play APIs";
    const apiProg =
      s.apiIndex < REQUIRED_PLAY_APIS.length
        ? `${s.apiIndex + 1}/${REQUIRED_PLAY_APIS.length}`
        : `${REQUIRED_PLAY_APIS.length}/${REQUIRED_PLAY_APIS.length}`;
    dimmer.show({
      title: `Enabling Google Play APIs (${apiProg})`,
      subtitle: `${step} — this usually takes 10-20 seconds per API.`,
    });
  } else if (s.stage === "automating_sa") {
    dimmer.show({
      title: "Configuring Google Cloud",
      subtitle:
        "Creating the service account, granting Editor, and preparing the JSON key.",
    });
  } else if (s.stage === "creating_key") {
    dimmer.show({
      title: "Creating the JSON key",
      subtitle: "Downloading and capturing your service account credentials.",
    });
  } else {
    dimmer.hide();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON drop-zone fallback
// ─────────────────────────────────────────────────────────────────────────────

function acceptCapturedJson(text: string): boolean {
  const candidate = parseIfLooksLikeKey(text);
  if (!candidate || !candidate.client_email) return false;
  state.serviceAccountJson = text;
  state.serviceAccountEmail = candidate.client_email;
  state.stage = "key_captured";
  state.progress = null;
  state.error = null;
  try {
    void chrome.storage.session.set({
      adapty_gcp_service_account_email: candidate.client_email,
      adapty_gcp_service_account_json: text,
      adapty_gcp_project_id: candidate.project_id ?? null,
    });
  } catch (err) {
    console.warn("[adapty/gcp] session storage write failed:", err);
  }
  render();
  chrome.runtime
    .sendMessage({ type: "OVERLAY_OPEN_PLAY_CONSOLE" })
    .catch(() => {
      // non-fatal
    });
  return true;
}

function ensureJsonDropZone(): void {
  const host = document.getElementById("adapty-overlay-host");
  if (!host || !host.shadowRoot) return;
  const shadow = host.shadowRoot;
  const body = shadow.querySelector(".fv-body");
  if (!body) return;

  const page = classifyGcpPage();
  const shouldShow =
    !state.serviceAccountJson &&
    (page === "sa_keys" || state.stage === "awaiting_user_action");

  let dropzone = shadow.getElementById(
    "fv-gcp-dropzone"
  ) as HTMLDivElement | null;

  if (!shouldShow) {
    dropzone?.remove();
    return;
  }
  if (dropzone) return;

  dropzone = document.createElement("div");
  dropzone.id = "fv-gcp-dropzone";
  dropzone.className = "fv-dropzone";
  dropzone.innerHTML = `
    <div class="fv-dropzone-title">Drop the downloaded JSON key here</div>
    <div class="fv-dropzone-sub">or click to choose the file you just downloaded</div>
    <input id="fv-gcp-fileinput" class="fv-hidden-file-input" type="file" accept=".json,application/json" />
    <div id="fv-gcp-droperror" class="fv-dropzone-error" hidden></div>
  `;
  const actionsRow = body.querySelector(".fv-row");
  if (actionsRow) body.insertBefore(dropzone, actionsRow);
  else body.appendChild(dropzone);

  const fileInput = dropzone.querySelector<HTMLInputElement>(
    "#fv-gcp-fileinput"
  )!;

  const setError = (msg: string | null): void => {
    const err = shadow.getElementById(
      "fv-gcp-droperror"
    ) as HTMLElement | null;
    if (!err) return;
    if (msg) {
      err.textContent = msg;
      err.hidden = false;
    } else {
      err.textContent = "";
      err.hidden = true;
    }
  };

  const handleFile = (file: File): void => {
    setError(null);
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".json") && file.type !== "application/json") {
      setError(`Expected a .json file, got ${file.name}.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      if (!acceptCapturedJson(text)) {
        setError(
          "That file doesn't look like a Google service account key. Pick the JSON GCP downloaded."
        );
      }
    };
    reader.onerror = () => setError("Could not read the file — try again.");
    reader.readAsText(file);
  };

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone!.classList.add("fv-dropzone-over");
  });
  dropzone.addEventListener("dragleave", () =>
    dropzone!.classList.remove("fv-dropzone-over")
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone!.classList.remove("fv-dropzone-over");
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// URL observation — Angular SPA
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
  state.projectId = getGcpProjectId();
  const page = classifyGcpPage();

  if (page === "project_picker") {
    if (!removeProjectHighlight) {
      window.setTimeout(() => {
        if (classifyGcpPage() === "project_picker") {
          removeProjectHighlight?.();
          removeProjectHighlight = highlightProjectPicker();
        }
      }, 400);
    }
  } else if (removeProjectHighlight) {
    removeProjectHighlight();
    removeProjectHighlight = null;
  }

  if (page === "sa_list") {
    if (!state.apisVerified && state.projectId) {
      if (state.stage !== "enabling_apis") {
        void runApiEnableCheck();
      }
    } else if (
      !state.serviceAccountEmail &&
      state.stage !== "automating_sa" &&
      state.stage !== "creating_key"
    ) {
      void runSaCreation();
    } else if (
      state.stage === "automating_sa" &&
      state.serviceAccountEmail &&
      !state.serviceAccountJson
    ) {
      void navigateToSaDetailAndKeys();
    }
  }

  if (
    (page === "marketplace_api" || page === "api_overview") &&
    state.stage === "enabling_apis"
  ) {
    // no-op — orchestrator drives the loop
  }

  if (page === "sa_keys") {
    if (state.stage !== "creating_key" && !state.serviceAccountJson) {
      void runCreateJsonKey();
    }
  }

  render();
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Play APIs enable check
// ─────────────────────────────────────────────────────────────────────────────

async function loadApisVerifiedFlag(projectId: string): Promise<boolean> {
  try {
    const key = apisVerifiedKey(projectId);
    const entry = await chrome.storage.session.get(key);
    return entry[key] === true;
  } catch {
    return false;
  }
}

async function storeApisVerifiedFlag(projectId: string): Promise<void> {
  try {
    await chrome.storage.session.set({
      [apisVerifiedKey(projectId)]: true,
    });
  } catch {
    // non-fatal
  }
}

async function runApiEnableCheck(): Promise<void> {
  const projectId = state.projectId;
  if (!projectId) {
    void runSaCreation();
    return;
  }

  if (await loadApisVerifiedFlag(projectId)) {
    state.apisVerified = true;
    state.stage = "scanning";
    render();
    void runSaCreation();
    return;
  }

  state.stage = "enabling_apis";
  state.error = null;
  state.manualHint = null;

  const landedService = getMarketplaceServiceName();
  if (landedService) {
    const landedIdx = REQUIRED_PLAY_APIS.indexOf(landedService);
    if (landedIdx > state.apiIndex) {
      state.apiIndex = landedIdx;
    }
  }

  while (state.apiIndex < REQUIRED_PLAY_APIS.length) {
    const serviceName = REQUIRED_PLAY_APIS[state.apiIndex]!;
    state.currentApiName =
      API_DISPLAY_NAMES[serviceName] ?? serviceName;
    state.progress = "check_api";
    render();

    try {
      const here = classifyGcpPage();
      const hereService = getMarketplaceServiceName();
      if (
        (here !== "marketplace_api" && here !== "api_overview") ||
        hereService !== serviceName
      ) {
        navigateTo(buildMarketplaceUrl(serviceName, projectId));
        await sleep(800);
      }

      await waitFor(
        () => {
          const p = classifyGcpPage();
          const sn = getMarketplaceServiceName();
          if (
            (p === "marketplace_api" || p === "api_overview") &&
            sn === serviceName
          ) {
            return true;
          }
          return null;
        },
        {
          step: `nav:marketplace_${serviceName}`,
          timeoutMs: 10_000,
        }
      );

      await sleep(800);
      let alreadyEnabled = isApiAlreadyEnabled();
      if (!alreadyEnabled) {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await sleep(200);
          if (isApiAlreadyEnabled()) {
            alreadyEnabled = true;
            break;
          }
        }
      }
      if (alreadyEnabled) {
        state.apiIndex += 1;
        continue;
      }

      state.progress = "enabling_api";
      render();
      await clickEnableApiButton();
      await sleep(API_ENABLE_WAIT_MS);

      state.apiIndex += 1;
    } catch (err) {
      state.progress = null;
      state.stage = "awaiting_user_action";
      const friendly =
        state.currentApiName ?? "the required Google Play API";
      state.manualHint =
        err instanceof AutomationStepError
          ? `Enable ${friendly} on this page, then click Retry.`
          : `Enable ${friendly} on this page manually, then click Retry.`;
      render();
      return;
    }
  }

  state.apisVerified = true;
  state.currentApiName = null;
  state.progress = "return_to_sa";
  render();
  await storeApisVerifiedFlag(projectId);

  navigateTo(buildServiceAccountsUrl(projectId));
}

function navigateTo(url: string): void {
  if (location.href !== url) {
    location.href = url;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Blob capture (JSON key download)
// ─────────────────────────────────────────────────────────────────────────────

function injectBlobHook(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/injected/blob-hook.ts");
  script.type = "module";
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function handleBlobMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string; text?: string };
  if (
    !data ||
    data.source !== "adapty-blob-hook" ||
    data.type !== "ADAPTY_BLOB"
  ) {
    return;
  }
  acceptCapturedJson(data.text || "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Automation orchestration
// ─────────────────────────────────────────────────────────────────────────────

async function runSaCreation(): Promise<void> {
  const page = classifyGcpPage();
  if (page !== "sa_list") {
    state.stage = "awaiting_user_action";
    state.manualHint =
      "Navigate to IAM & Admin → Service Accounts and we'll take over automatically.";
    render();
    return;
  }
  state.stage = "automating_sa";
  state.error = null;
  try {
    saEmailsBeforeCreate = snapshotServiceAccountEmails();
    state.progress = "open_create_form";
    render();
    await clickCreateServiceAccountToolbarButton();
    await sleep(STEP_DELAY_MS);

    await waitFor(() => classifyGcpPage() === "sa_create", {
      step: "nav:sa_create",
      timeoutMs: 8000,
    });

    state.progress = "fill_sa_form";
    render();
    await fillServiceAccountForm(makeServiceAccountName());
    await sleep(STEP_DELAY_MS);

    state.progress = "submit_create";
    render();
    await clickCreateAndContinue();
    await sleep(STEP_DELAY_MS);

    state.progress = "select_role";
    render();
    try {
      await selectPlayStoreRoles();
      await sleep(STEP_DELAY_MS);
    } catch (err) {
      // Non-fatal: if role selection fails, the SA is still created without
      // permissions and the user can grant them in IAM afterwards.
      console.warn("[adapty/gcp] role selection failed:", err);
    }

    state.progress = "advance_step2";
    render();
    try {
      await clickStep2Continue();
      await sleep(STEP_DELAY_MS);
    } catch {
      // fall through
    }

    state.progress = "skip_optional_steps";
    render();
    try {
      await clickDone();
      await sleep(STEP_DELAY_MS);
    } catch {
      // fall through
    }

    state.progress = null;
    render();
    const newEmail = await waitForNewServiceAccount(
      saEmailsBeforeCreate ?? new Set(),
      { timeoutMs: 15_000 }
    );
    state.serviceAccountEmail = newEmail;
    render();

    await navigateToSaDetailAndKeys();
  } catch (err) {
    state.progress = null;
    state.stage = "awaiting_user_action";
    state.manualHint =
      err instanceof AutomationStepError
        ? `Finish the current screen manually (stopped at "${err.step}"). We'll pick up again when you reach the Keys tab.`
        : "We couldn't drive the form. Continue manually and we'll resume once the Keys tab is visible.";
    render();
  }
}

async function navigateToSaDetailAndKeys(): Promise<void> {
  if (!state.serviceAccountEmail) return;
  state.stage = "automating_sa";
  try {
    state.progress = "open_sa_detail";
    render();
    await clickServiceAccountRowByEmail(state.serviceAccountEmail);
    await sleep(STEP_DELAY_MS);

    await waitFor(() => {
      const p = classifyGcpPage();
      return p === "sa_detail" || p === "sa_keys" ? true : null;
    }, { step: "nav:sa_detail", timeoutMs: 10_000 });

    state.progress = "open_keys_tab";
    render();
    await clickKeysTab();
    await sleep(STEP_DELAY_MS);

    await waitFor(() => classifyGcpPage() === "sa_keys", {
      step: "nav:sa_keys",
      timeoutMs: 10_000,
    });

    state.progress = null;
    render();
    await runCreateJsonKey();
  } catch (err) {
    state.progress = null;
    state.stage = "awaiting_user_action";
    state.manualHint =
      err instanceof AutomationStepError
        ? `Open the service account "${state.serviceAccountEmail}" and its Keys tab — we'll take over once we see it.`
        : "Open the service account and the Keys tab manually — we'll pick up from there.";
    render();
  }
}

async function runCreateJsonKey(): Promise<void> {
  if (classifyGcpPage() !== "sa_keys") {
    state.stage = "awaiting_user_action";
    state.manualHint = "Open the service account Keys tab to continue.";
    render();
    return;
  }
  state.stage = "creating_key";
  state.error = null;
  try {
    state.progress = "open_add_key_menu";
    render();
    await openAddKeyMenu();
    await sleep(STEP_DELAY_MS);
    await clickCreateNewKeyMenuItem();
    await sleep(STEP_DELAY_MS);

    state.progress = "select_json";
    render();
    await selectJsonRadio();
    await sleep(STEP_DELAY_MS);

    state.progress = "submit_create_key";
    render();
    await clickCreateKeyButton();
    // blob-hook will catch the downloaded JSON and flip stage to key_captured.
  } catch (err) {
    state.progress = null;
    state.stage = "awaiting_user_action";
    state.manualHint =
      err instanceof AutomationStepError
        ? `Finish the Create Key dialog manually — we'll capture the file once it downloads.`
        : "Finish creating the JSON key manually — we'll capture it once the file downloads.";
    render();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

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
    state.stage = "awaiting_user_action";
    state.progress = null;
    state.manualHint =
      "Finish the current step on Google Cloud yourself — we'll pick up again once a JSON key is created.";
    render();
  });
  render();
  overlay.onAction((id) => {
    if (id === "__close__") {
      overlay?.unmount();
      overlay = null;
      dimmer?.hide();
      dimmer = null;
      overlayActivated = false;
      removeProjectHighlight?.();
      removeProjectHighlight = null;
      return;
    }
    if (id === "retry") {
      state.error = null;
      state.progress = null;
      state.manualHint = null;
      const page = classifyGcpPage();
      if (page === "sa_list") {
        state.stage = "scanning";
        render();
        void runSaCreation();
      } else if (page === "sa_keys") {
        state.stage = "scanning";
        render();
        void runCreateJsonKey();
      } else {
        state.stage = "scanning";
        render();
      }
      return;
    }
    if (id === "retry_api") {
      state.error = null;
      state.progress = null;
      state.manualHint = null;
      render();
      void runApiEnableCheck();
      return;
    }
  });

  injectBlobHook();
  window.addEventListener("message", handleBlobMessage);
  observeUrlChanges();

  state.projectId = getGcpProjectId();
  const page = classifyGcpPage();
  if (page === "project_picker") {
    state.stage = "await_project";
    window.setTimeout(() => {
      if (classifyGcpPage() === "project_picker" && !removeProjectHighlight) {
        removeProjectHighlight = highlightProjectPicker();
      }
    }, 400);
  } else {
    state.stage = "scanning";
  }
  render();

  if (page === "sa_list") {
    void runSaCreation();
  } else if (page === "sa_keys") {
    void runCreateJsonKey();
  } else if (page === "marketplace_api" || page === "api_overview") {
    void runApiEnableCheck();
  }
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
      console.warn("[adapty/gcp] capture listener error:", err);
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
