// App Store Connect content script.
//
// When a capture session targets App Store Connect, we:
//   1) Inject blob-hook into the page context so URL.createObjectURL for the
//      generated .p8 is observed transparently.
//   2) Scrape the Issuer ID from the Keys page.
//   3) Click through creating an "Adapty Integration" key and downloading
//      the .p8 file.
//   4) If the blob-hook catches the .p8 payload, we send it straight to the
//      service worker — zero further user action needed.
//   5) If any automation step fails OR the download isn't captured within a
//      short window, we reveal a drop-zone so the user can drop the file
//      they just downloaded and finish the flow manually.

import { Overlay } from "@/overlay/wizard";
import { PageDimmer } from "@/overlay/page-dimmer";
import type {
  AppStoreCaptured,
  CaptureState,
  ExtensionMessage,
} from "@/shared/types";
import {
  AutomationStepError,
  runCreateKeyAutomation,
  waitForIssuerId,
  type AutomationProgressStep,
} from "@/content/asc-automate";

const PEM_BEGIN = "-----BEGIN PRIVATE KEY-----";

type FlowStage =
  | "scanning"
  | "ready"
  | "automating"
  | "awaiting_download"
  | "awaiting_file_drop"
  | "saving"
  | "success"
  | "error";

interface FlowState {
  stage: FlowStage;
  issuerId: string | null;
  apiKeyId: string | null;
  privateKey: string | null;
  progress: AutomationProgressStep | null;
  error: string | null;
}

const AUTO_STEP_LABEL: Record<AutomationProgressStep, string> = {
  open_dialog: "Opening the create-key dialog",
  fill_name: "Naming the key “Adapty Integration”",
  select_role: "Waiting for you to pick an access role",
  awaiting_user_role: "Waiting for you to pick an access role and click Generate",
  submit: "Waiting for you to click Generate",
  scrape_key_id: "Reading the new Key ID",
  click_download: "Downloading the .p8 file",
};

const DOWNLOAD_WATCHDOG_MS = 5000;

let overlay: Overlay | null = null;
let dimmer: PageDimmer | null = null;
let captureState: CaptureState = { stage: "idle" };
let downloadWatchdog: number | null = null;

const state: FlowState = {
  stage: "scanning",
  issuerId: null,
  apiKeyId: null,
  privateKey: null,
  progress: null,
  error: null,
};

function makeKeyName(): string {
  // ASC caps key names at 30 characters. "Adapty YYYY-MM-DD HH:mm" = 23 chars.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const name = `Adapty ${y}-${m}-${d} ${hh}:${mm}`;
  return name.length > 30 ? name.slice(0, 30) : name;
}

function canSave(s: FlowState): boolean {
  return !!(
    s.issuerId &&
    s.apiKeyId &&
    s.privateKey &&
    captureState.stage === "capturing_appstore"
  );
}

function chipStatus(ok: boolean): "ok" | "pending" {
  return ok ? "ok" : "pending";
}

function render(): void {
  if (!overlay) return;
  const s = state;
  const steps = [
    {
      title: "Scan App Store Connect for your Issuer ID",
      active: s.stage === "scanning",
      done: !!s.issuerId,
    },
    {
      title:
        s.stage === "ready"
          ? "Approve the automation below"
          : s.progress
            ? `<strong>${AUTO_STEP_LABEL[s.progress]}…</strong>`
            : "Create a new API key named <strong>Adapty Integration</strong>",
      active: s.stage === "ready" || s.stage === "automating",
      done: !!s.apiKeyId,
    },
    {
      title:
        s.stage === "awaiting_file_drop"
          ? "Drop the .p8 file you just downloaded below"
          : "Capture the .p8 download",
      active:
        s.stage === "awaiting_download" || s.stage === "awaiting_file_drop",
      done: !!s.privateKey,
    },
    {
      title: "Send credentials back to Adapty",
      active: s.stage === "saving",
      done: s.stage === "success",
    },
  ];

  let alert: { kind: "info" | "error" | "success"; text: string } | undefined;
  if (s.stage === "error") {
    alert = { kind: "error", text: s.error || "Automation error." };
  } else if (s.stage === "success") {
    alert = {
      kind: "success",
      text: "Credentials captured. Returning to the Adapty onboarding tab.",
    };
  } else if (s.stage === "saving") {
    alert = { kind: "info", text: "Saving…" };
  } else if (s.stage === "automating" && s.progress === "awaiting_user_role") {
    alert = {
      kind: "success",
      text:
        "👉 Your turn: in the Generate API Key dialog, pick the access role that matches how you want Adapty to act on your behalf (App Manager is the typical choice), then click Generate. We'll capture the .p8 as soon as you click Download.",
    };
  } else if (s.stage === "automating" && s.progress) {
    alert = { kind: "info", text: `${AUTO_STEP_LABEL[s.progress]}…` };
  } else if (s.stage === "ready") {
    alert = {
      kind: "info",
      text:
        "We'll open a new key dialog and pre-fill the name \"Adapty Integration\". You choose the access role and hit Generate — we'll capture the .p8 automatically after that.",
    };
  }

  const actions: Array<{
    id: string;
    label: string;
    primary?: boolean;
    disabled?: boolean;
  }> = [];

  if (s.stage === "ready") {
    actions.push({
      id: "start",
      label: "Create Adapty Integration key",
      primary: true,
    });
  } else if (s.stage === "error") {
    actions.push({ id: "retry", label: "Try again", primary: true });
  } else if (s.stage === "success") {
    actions.push({
      id: "close",
      label: "Done",
      primary: true,
    });
  } else if (s.stage === "awaiting_file_drop") {
    actions.push({
      id: "retry",
      label: "Try automation again",
      primary: false,
    });
  } else if (canSave(s)) {
    actions.push({
      id: "save",
      label: "Save",
      primary: true,
    });
  }

  overlay.render({
    title: "Adapty · App Store Connect",
    steps,
    alert,
    chips: [
      { label: "Issuer ID", status: chipStatus(!!s.issuerId) },
      { label: "Key ID", status: chipStatus(!!s.apiKeyId) },
      { label: ".p8 file", status: chipStatus(!!s.privateKey) },
    ],
    actions,
  });

  ensureDropZone();
  updateDimmer();
}

function updateDimmer(): void {
  if (!dimmer) return;
  const s = state;
  if (s.stage === "automating") {
    const sub =
      s.progress === "awaiting_user_role"
        ? "Pick an access role on the highlighted Access field, then click Generate — we'll take it from there."
        : s.progress
          ? AUTO_STEP_LABEL[s.progress] + "…"
          : "Creating your API key.";
    dimmer.show({
      title: "Automating App Store Connect",
      subtitle: sub,
    });
  } else if (s.stage === "awaiting_download") {
    dimmer.show({
      title: "Capturing the .p8 file",
      subtitle: "Hold on — Apple is handing us the private key.",
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

function ensureDropZone(): void {
  const host = document.getElementById("adapty-overlay-host");
  if (!host || !host.shadowRoot) return;
  const shadow = host.shadowRoot;
  const body = shadow.querySelector(".fv-body");
  if (!body) return;

  let dropzone = shadow.getElementById("fv-asc-dropzone") as HTMLDivElement | null;
  const actionsRow = body.querySelector(".fv-row");

  if (state.stage !== "awaiting_file_drop") {
    dropzone?.remove();
    return;
  }

  if (!dropzone) {
    dropzone = document.createElement("div");
    dropzone.id = "fv-asc-dropzone";
    dropzone.className = "fv-dropzone";
    dropzone.innerHTML = `
      <div class="fv-dropzone-title">Drop the .p8 file here</div>
      <div class="fv-dropzone-sub">or click to choose the file you just downloaded</div>
      <input id="fv-asc-fileinput" class="fv-hidden-file-input" type="file" accept=".p8,application/x-pem-file,application/octet-stream" />
      <div id="fv-asc-droperror" class="fv-dropzone-error" hidden></div>
    `;
    if (actionsRow) {
      body.insertBefore(dropzone, actionsRow);
    } else {
      body.appendChild(dropzone);
    }

    const fileInput = dropzone.querySelector<HTMLInputElement>(
      "#fv-asc-fileinput"
    )!;

    const setError = (msg: string | null): void => {
      const err = shadow.getElementById("fv-asc-droperror") as HTMLElement | null;
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
      if (!lower.endsWith(".p8") && file.type !== "application/x-pem-file") {
        setError(`Expected a .p8 file, got ${file.name}.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        if (!text.includes(PEM_BEGIN)) {
          setError(
            "That file doesn't look like an Apple private key. Please pick the .p8 generated by App Store Connect."
          );
          return;
        }
        state.privateKey = text.trim();
        void trySave();
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
}

function clearDownloadWatchdog(): void {
  if (downloadWatchdog !== null) {
    window.clearTimeout(downloadWatchdog);
    downloadWatchdog = null;
  }
}

function armDownloadWatchdog(): void {
  clearDownloadWatchdog();
  downloadWatchdog = window.setTimeout(() => {
    if (!state.privateKey) {
      state.stage = "awaiting_file_drop";
      state.error = null;
      render();
    }
  }, DOWNLOAD_WATCHDOG_MS);
}

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
  const text = data.text || "";
  if (text.includes(PEM_BEGIN)) {
    state.privateKey = text.trim();
    clearDownloadWatchdog();
    void trySave();
  }
}

async function getPendingExtras(): Promise<{
  bundleId?: string;
  sharedSecret?: string;
}> {
  try {
    const r = await chrome.storage.session.get([
      "adapty_pending_bundle_id",
      "adapty_pending_shared_secret",
    ]);
    return {
      bundleId: r["adapty_pending_bundle_id"] as string | undefined,
      sharedSecret: r["adapty_pending_shared_secret"] as string | undefined,
    };
  } catch {
    return {};
  }
}

async function trySave(): Promise<void> {
  if (!canSave(state)) {
    render();
    return;
  }
  state.stage = "saving";
  render();

  const { bundleId, sharedSecret } = await getPendingExtras();
  const creds: AppStoreCaptured = {
    bundle_id: bundleId,
    api_key_id: state.apiKeyId!,
    issuer_id: state.issuerId!,
    private_key: state.privateKey!,
    private_key_filename: `AuthKey_${state.apiKeyId}.p8`,
    shared_secret: sharedSecret,
    captured_at: Date.now(),
  };
  const msg: ExtensionMessage = {
    type: "OVERLAY_SUBMIT_CREDENTIALS",
    store_type: "appstore",
    credentials: creds,
  };
  try {
    const resp = await chrome.runtime.sendMessage(msg);
    if (!resp?.ok) {
      state.stage = "error";
      state.error = resp?.error || "Failed to store credentials";
    } else {
      state.stage = "success";
      state.error = null;
    }
  } catch (err) {
    state.stage = "error";
    state.error = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function runAutomation(): Promise<void> {
  if (!state.issuerId) {
    state.stage = "error";
    state.error = "Couldn't find your Issuer ID on this page.";
    render();
    return;
  }
  state.stage = "automating";
  state.error = null;
  state.progress = "open_dialog";
  render();

  try {
    const { apiKeyId } = await runCreateKeyAutomation({
      keyName: makeKeyName(),
      onProgress: (step) => {
        state.progress = step;
        render();
      },
    });
    state.apiKeyId = apiKeyId;
    state.progress = null;
    state.stage = "awaiting_download";
    render();
    if (state.privateKey) {
      void trySave();
    } else {
      armDownloadWatchdog();
    }
  } catch (err) {
    state.progress = null;
    state.stage = "awaiting_file_drop";
    state.error =
      err instanceof AutomationStepError
        ? `Automation stopped at "${err.step}". You can finish by dropping the .p8 file below.`
        : err instanceof Error
          ? err.message
          : "Automation error.";
    render();
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

function isActiveCapture(s: CaptureState): boolean {
  return s.stage === "capturing_appstore";
}

let overlayActivated = false;

function ensureOverlayActivated(): void {
  if (overlayActivated) return;
  overlayActivated = true;

  overlay = new Overlay();
  overlay.mount();
  dimmer = new PageDimmer();
  dimmer.onCancel(() => {
    state.stage = "awaiting_file_drop";
    state.progress = null;
    clearDownloadWatchdog();
    render();
  });
  overlay.onAction((id) => {
    if (id === "__close__" || id === "close") {
      clearDownloadWatchdog();
      overlay?.unmount();
      overlay = null;
      dimmer?.hide();
      dimmer = null;
      overlayActivated = false;
      return;
    }
    if (id === "start") {
      void runAutomation();
      return;
    }
    if (id === "retry") {
      state.apiKeyId = null;
      state.privateKey = null;
      state.progress = null;
      state.error = null;
      state.stage = state.issuerId ? "ready" : "scanning";
      render();
      if (state.issuerId) void runAutomation();
      return;
    }
    if (id === "save") {
      void trySave();
      return;
    }
  });

  injectBlobHook();
  window.addEventListener("message", handleBlobMessage);

  state.stage = "scanning";
  render();

  void (async () => {
    try {
      state.issuerId = await waitForIssuerId();
      void runAutomation();
    } catch {
      state.stage = "error";
      state.error =
        "We couldn't find an Issuer ID on this page. Make sure you're on the Integrations → Keys tab and refresh.";
      render();
    }
  })();
}

async function init(): Promise<void> {
  chrome.storage.session.onChanged.addListener(async (changes) => {
    try {
      if ("adapty_capture_state" in changes) {
        await refreshCaptureState();
        if (isActiveCapture(captureState)) ensureOverlayActivated();
        render();
      }
    } catch (err) {
      console.warn("[adapty/asc] capture listener error:", err);
    }
  });

  await refreshCaptureState();
  if (isActiveCapture(captureState)) {
    ensureOverlayActivated();
    return;
  }

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    await refreshCaptureState();
    if (isActiveCapture(captureState)) {
      ensureOverlayActivated();
      return;
    }
  }
}

init();
