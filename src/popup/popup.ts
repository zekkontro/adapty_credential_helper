// Toolbar popup. No pairing codes / backend — just shows the current
// session's captured credential status and provides shortcuts for
// opening the Adapty onboarding page and clearing captures.

import type {
  AppStoreCaptured,
  ExtensionMessage,
  PlayStoreCaptured,
} from "@/shared/types";

const LOGO_URL = chrome.runtime.getURL("src/assets/icon-48.png");
const VERSION = chrome.runtime.getManifest().version;
const ADAPTY_ONBOARDING_URL = "https://app.adapty.io/onboarding";

interface Captured {
  appstore?: AppStoreCaptured;
  playstore?: PlayStoreCaptured;
}

function e<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
}

async function getCaptured(): Promise<Captured> {
  try {
    const resp = await chrome.runtime.sendMessage<ExtensionMessage>({
      type: "ADAPTY_REQUEST_FILL",
    });
    return (resp ?? {}) as Captured;
  } catch {
    return {};
  }
}

async function clearAll(): Promise<void> {
  try {
    await chrome.runtime.sendMessage<ExtensionMessage>({
      type: "ADAPTY_CLEAR_CAPTURED",
    });
  } catch {
    // ignore
  }
}

function formatAppStore(c: AppStoreCaptured | undefined): string {
  if (!c) return "Not captured";
  const bits: string[] = [];
  if (c.bundle_id) bits.push(c.bundle_id);
  bits.push(`Key ${c.api_key_id}`);
  return "✓ " + bits.join(" · ");
}

function formatPlayStore(c: PlayStoreCaptured | undefined): string {
  if (!c) return "Not captured";
  if (c.package_name) return `✓ ${c.package_name}`;
  return "✓ Captured (no package name)";
}

function render(captured: Captured): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";

  const header = e("div", { class: "header" }, [
    e("img", { src: LOGO_URL, alt: "Adapty" }),
    e("div", { class: "title" }, ["Adapty Credential Helper"]),
    e("span", { class: "version" }, [`v${VERSION}`]),
  ]);
  root.appendChild(header);

  const body = e("div", { class: "body" });

  body.appendChild(
    buildRow(
      "App Store",
      formatAppStore(captured.appstore),
      !!captured.appstore
    )
  );
  body.appendChild(
    buildRow(
      "Play Store",
      formatPlayStore(captured.playstore),
      !!captured.playstore
    )
  );

  root.appendChild(body);

  const footer = e("div", { class: "footer" });

  const openBtn = e("button", { class: "btn", type: "button" }, [
    "Open Adapty onboarding",
  ]);
  openBtn.addEventListener("click", () => {
    void chrome.tabs.create({ url: ADAPTY_ONBOARDING_URL });
    window.close();
  });
  footer.appendChild(openBtn);

  if (captured.appstore || captured.playstore) {
    const clearBtn = e("button", { class: "link-btn", type: "button" }, [
      "Clear captured credentials",
    ]);
    clearBtn.addEventListener("click", async () => {
      await clearAll();
      await refresh();
    });
    footer.appendChild(clearBtn);
  } else {
    const hint = e("span", { class: "link-btn" }, [
      "Open Adapty → click Import on the helper panel to begin.",
    ]);
    hint.style.textDecoration = "none";
    hint.style.cursor = "default";
    footer.appendChild(hint);
  }

  root.appendChild(footer);
}

function buildRow(name: string, status: string, captured: boolean): HTMLElement {
  return e("div", { class: "row" }, [
    e("div", { class: "name" }, [
      e("div", { class: "primary" }, [name]),
      e("div", { class: "secondary" + (captured ? " ok" : "") }, [status]),
    ]),
  ]);
}

async function refresh(): Promise<void> {
  const captured = await getCaptured();
  render(captured);
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (
    "adapty_captured_appstore" in changes ||
    "adapty_captured_playstore" in changes
  ) {
    void refresh();
  }
});

void refresh();
