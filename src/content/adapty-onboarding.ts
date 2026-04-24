// Adapty onboarding content script.
//
// Injects a floating panel next to https://app.adapty.io/onboarding's "Connect
// app stores" form with "Import from App Store" and "Import from Play Store"
// buttons. On click, kicks off the capture flow by messaging the service
// worker. When captured credentials become available (via storage.session
// change event), fills the Adapty form fields — including the `.p8` and
// service-account JSON dropzones — via React native setter + DataTransfer.

import type {
  AppStoreCaptured,
  ExtensionMessage,
  PlayStoreCaptured,
  StoreType,
} from "@/shared/types";

const PANEL_HOST_ID = "adapty-helper-panel-host";
const FORM_SELECTOR = "form#Onboarding_AppStore_PlayStore";

// App Store form field selectors (from the onboarding page HTML analysis).
const APPLE_FIELDS = {
  bundleId: "input#apple_bundle_id",
  issuerId: "input#apple_store_issuer_id",
  keyId: "input#apple_store_key_id",
  sharedSecret: "input#shared_secret",
  p8Dropzone:
    '[data-test="apple_store_private_key_field"] input[data-testid="dropzone-input"]',
} as const;

const GOOGLE_FIELDS = {
  packageName: "input#google_bundle_id",
  jsonDropzone:
    '[data-test="google_service_account_key_file_field"] input[data-testid="dropzone-input"]',
} as const;

// React controls each input's value via an internal tracker. Use the native
// prototype setter so React's synthetic event system sees the change.
function setReactInputValue(el: HTMLInputElement, value: string): void {
  const proto = HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Adapty's dropzones listen on file-input `change`. Build a File object in
// memory, wrap it in a DataTransfer so the FileList can be assigned, then
// dispatch the change event that react-dropzone/react-hook-form observes.
function uploadFileToDropzone(
  input: HTMLInputElement,
  content: string,
  filename: string,
  mime: string
): boolean {
  try {
    const file = new File([content], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch (err) {
    console.warn("[adapty/onboarding] dropzone upload failed:", err);
    return false;
  }
}

async function requestFill(): Promise<{
  appstore?: AppStoreCaptured;
  playstore?: PlayStoreCaptured;
}> {
  try {
    const resp = await chrome.runtime.sendMessage<ExtensionMessage>({
      type: "ADAPTY_REQUEST_FILL",
    });
    return resp ?? {};
  } catch {
    return {};
  }
}

function fillAppStoreFields(c: AppStoreCaptured): void {
  const bundleInput = document.querySelector<HTMLInputElement>(
    APPLE_FIELDS.bundleId
  );
  if (bundleInput && c.bundle_id) {
    setReactInputValue(bundleInput, c.bundle_id);
  }
  const issuerInput = document.querySelector<HTMLInputElement>(
    APPLE_FIELDS.issuerId
  );
  if (issuerInput) setReactInputValue(issuerInput, c.issuer_id);

  const keyInput = document.querySelector<HTMLInputElement>(APPLE_FIELDS.keyId);
  if (keyInput) setReactInputValue(keyInput, c.api_key_id);

  const sharedInput = document.querySelector<HTMLInputElement>(
    APPLE_FIELDS.sharedSecret
  );
  if (sharedInput && c.shared_secret) {
    setReactInputValue(sharedInput, c.shared_secret);
  }

  const p8Input = document.querySelector<HTMLInputElement>(
    APPLE_FIELDS.p8Dropzone
  );
  if (p8Input) {
    uploadFileToDropzone(
      p8Input,
      c.private_key,
      c.private_key_filename || `AuthKey_${c.api_key_id}.p8`,
      "application/pkcs8"
    );
  }
}

function fillPlayStoreFields(c: PlayStoreCaptured): void {
  const pkgInput = document.querySelector<HTMLInputElement>(
    GOOGLE_FIELDS.packageName
  );
  if (pkgInput && c.package_name) {
    setReactInputValue(pkgInput, c.package_name);
  }

  const jsonInput = document.querySelector<HTMLInputElement>(
    GOOGLE_FIELDS.jsonDropzone
  );
  if (jsonInput) {
    uploadFileToDropzone(
      jsonInput,
      c.service_account_json,
      c.service_account_filename || "service-account.json",
      "application/json"
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel UI (shadow DOM)
// ─────────────────────────────────────────────────────────────────────────────

interface PanelState {
  appstore?: AppStoreCaptured;
  playstore?: PlayStoreCaptured;
}

class Panel {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private container: HTMLDivElement;
  private onAction: (action: "import_appstore" | "import_playstore" | "clear") => void;

  constructor(onAction: Panel["onAction"]) {
    this.onAction = onAction;
    this.host = document.createElement("div");
    this.host.id = PANEL_HOST_ID;
    this.host.style.all = "initial";
    this.host.style.position = "fixed";
    this.host.style.right = "24px";
    this.host.style.top = "96px";
    this.host.style.zIndex = "2147483647";
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .root {
        width: 320px;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
          Roboto, "Helvetica Neue", Arial, sans-serif;
        background: #ffffff;
        color: #111111;
        border: 1px solid #e5e5e5;
        border-radius: 16px;
        box-shadow: 0 20px 40px -8px rgba(0, 0, 0, 0.18),
          0 2px 4px -1px rgba(0, 0, 0, 0.06);
        overflow: hidden;
        -webkit-font-smoothing: antialiased;
        animation: slide-in 220ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes slide-in {
        from { opacity: 0; transform: translateY(-8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .root * { box-sizing: border-box; }
      .header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 16px;
        border-bottom: 1px solid #eeeeee;
      }
      .dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: #7018FF;
        box-shadow: 0 0 0 0 rgba(112, 24, 255, 0.8);
        animation: dot-pulse 1.8s infinite;
      }
      @keyframes dot-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(112, 24, 255, 0.7); }
        70%  { box-shadow: 0 0 0 10px rgba(112, 24, 255, 0); }
        100% { box-shadow: 0 0 0 0 rgba(112, 24, 255, 0); }
      }
      .title {
        font-weight: 600; font-size: 13px; letter-spacing: -0.01em;
        flex: 1; min-width: 0;
      }
      .subtitle {
        font-size: 11px; color: #666666; margin-top: 2px;
      }
      .close {
        border: 0; background: transparent; cursor: pointer;
        color: #666666; width: 28px; height: 28px;
        border-radius: 999px; font-size: 18px; line-height: 1;
        display: grid; place-items: center;
      }
      .close:hover { background: #f5f5f5; color: #111111; }
      .body { padding: 12px 16px 14px; }
      .row {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; border: 1px solid #e5e5e5;
        border-radius: 12px; margin-bottom: 8px;
      }
      .row .name {
        flex: 1; min-width: 0; font-size: 13px; font-weight: 500;
      }
      .row .status {
        font-size: 11px; color: #666666;
      }
      .row .status.ok { color: #556b00; font-weight: 500; }
      .row button {
        border: 1px solid #111111; background: #111111; color: #ffffff;
        padding: 7px 14px; border-radius: 999px; font-size: 12px;
        font-weight: 500; cursor: pointer; font-family: inherit;
        transition: background 200ms ease, color 200ms ease, border-color 200ms ease;
      }
      .row button:hover {
        background: #7018FF; color: #ffffff; border-color: #7018FF;
      }
      .row button.secondary {
        background: transparent; color: #111111;
      }
      .row button.secondary:hover {
        background: #7018FF; color: #ffffff; border-color: #7018FF;
      }
      .footer {
        padding: 10px 16px; border-top: 1px solid #eeeeee;
        font-size: 11px; color: #888888; display: flex;
        align-items: center; justify-content: space-between;
      }
      .footer button.clear {
        border: 0; background: transparent; color: #888888;
        cursor: pointer; font-size: 11px; padding: 0;
        text-decoration: underline; font-family: inherit;
      }
      .footer button.clear:hover { color: #111111; }
    `;
    this.shadow.appendChild(style);

    this.container = document.createElement("div");
    this.container.className = "root";
    this.shadow.appendChild(this.container);
  }

  mount(): void {
    if (!this.host.isConnected) {
      document.documentElement.appendChild(this.host);
    }
  }

  unmount(): void {
    this.host.remove();
  }

  render(state: PanelState): void {
    const hasAny = !!state.appstore || !!state.playstore;

    this.container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "header";

    const dot = document.createElement("span");
    dot.className = "dot";
    header.appendChild(dot);

    const titleWrap = document.createElement("div");
    titleWrap.style.flex = "1";
    titleWrap.style.minWidth = "0";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Adapty Credential Helper";
    titleWrap.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = "Pull keys from App Store & Play Console";
    titleWrap.appendChild(subtitle);

    header.appendChild(titleWrap);

    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.setAttribute("aria-label", "Hide helper");
    close.textContent = "×";
    close.addEventListener("click", () => this.unmount());
    header.appendChild(close);

    this.container.appendChild(header);

    const body = document.createElement("div");
    body.className = "body";

    body.appendChild(
      this.buildRow(
        "App Store",
        state.appstore
          ? `✓ Captured · ${state.appstore.api_key_id}`
          : "Not captured",
        state.appstore ? "Re-import" : "Import from App Store",
        !!state.appstore,
        () => this.onAction("import_appstore")
      )
    );

    body.appendChild(
      this.buildRow(
        "Play Store",
        state.playstore
          ? `✓ Captured · ${state.playstore.package_name ?? "package pending"}`
          : "Not captured",
        state.playstore ? "Re-import" : "Import from Play Store",
        !!state.playstore,
        () => this.onAction("import_playstore")
      )
    );

    this.container.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "footer";
    const note = document.createElement("span");
    note.textContent = hasAny ? "Session-only; cleared on restart." : "";
    footer.appendChild(note);

    if (hasAny) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "clear";
      clearBtn.type = "button";
      clearBtn.textContent = "Clear captured";
      clearBtn.addEventListener("click", () => this.onAction("clear"));
      footer.appendChild(clearBtn);
    }

    this.container.appendChild(footer);
  }

  private buildRow(
    name: string,
    status: string,
    btnLabel: string,
    captured: boolean,
    onClick: () => void
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";

    const nameWrap = document.createElement("div");
    nameWrap.style.flex = "1";
    nameWrap.style.minWidth = "0";

    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = name;
    nameWrap.appendChild(nameEl);

    const statusEl = document.createElement("div");
    statusEl.className = "status" + (captured ? " ok" : "");
    statusEl.textContent = status;
    nameWrap.appendChild(statusEl);

    row.appendChild(nameWrap);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = captured ? "secondary" : "";
    btn.textContent = btnLabel;
    btn.addEventListener("click", onClick);
    row.appendChild(btn);

    return row;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap: wait for the Adapty form, then mount panel + wire up messages
// ─────────────────────────────────────────────────────────────────────────────

let panel: Panel | null = null;

async function startCapture(storeType: StoreType): Promise<void> {
  // Tab id is left unset — the service worker reads sender.tab.id from the
  // message context so we don't need a round-trip query to discover it.
  const msg: ExtensionMessage = {
    type: "ADAPTY_START_CAPTURE",
    store_type: storeType,
  };
  try {
    await chrome.runtime.sendMessage(msg);
  } catch (err) {
    console.warn("[adapty/onboarding] start capture failed:", err);
  }
}

async function handleClear(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: "ADAPTY_CLEAR_CAPTURED",
    } as ExtensionMessage);
  } catch (err) {
    console.warn("[adapty/onboarding] clear failed:", err);
  }
  renderFromStorage();
}

async function renderFromStorage(): Promise<void> {
  if (!panel) return;
  const { appstore, playstore } = await requestFill();
  panel.render({ appstore, playstore });
  if (appstore) fillAppStoreFields(appstore);
  if (playstore) fillPlayStoreFields(playstore);
}

function ensurePanel(): void {
  if (panel) return;
  panel = new Panel((action) => {
    if (action === "import_appstore") void startCapture("appstore");
    else if (action === "import_playstore") void startCapture("playstore");
    else if (action === "clear") void handleClear();
  });
  panel.mount();
  void renderFromStorage();
}

function waitForForm(): void {
  if (document.querySelector(FORM_SELECTOR)) {
    ensurePanel();
    return;
  }
  const observer = new MutationObserver(() => {
    if (document.querySelector(FORM_SELECTOR)) {
      ensurePanel();
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  // Safety timeout — if the form never appears (e.g. user navigated
  // elsewhere), stop observing after 2 minutes to avoid leaking memory.
  window.setTimeout(() => observer.disconnect(), 120_000);
}

function init(): void {
  waitForForm();

  // Watch for new captures landing in storage.session so we re-render the
  // panel and re-fill the form instantly after a round-trip through ASC/GCP.
  chrome.storage.session.onChanged.addListener((changes) => {
    if (
      "adapty_captured_appstore" in changes ||
      "adapty_captured_playstore" in changes
    ) {
      void renderFromStorage();
    }
  });
}

init();
