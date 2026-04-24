// App Store Connect Apps content script.
//
// Runs on https://appstoreconnect.apple.com/apps and /apps/:appId/*. Its job is
// to capture the Bundle ID and App-Specific Shared Secret for the app the user
// is configuring in Adapty, then send them to the Integrations → Keys page
// where asc.ts takes over.
//
// Flow:
//   1) Apps list page (/apps): show a top banner asking the user to click
//      the app they're connecting. Listen for navigation to /apps/:appId/*.
//   2) Any /apps/:appId/* page that isn't /distribution/info: forward to
//      /apps/:appId/distribution/info — the General → App Information panel
//      there is where Apple surfaces the Bundle ID and the "Manage" link
//      for the App-Specific Shared Secret.
//   3) /apps/:appId/distribution/info: scrape the Bundle ID, open the
//      Shared Secret "Manage" dialog, scrape the 32-char hex secret, write
//      both to chrome.storage.session, and navigate to /access/integrations/api
//      so asc.ts takes over. Shared-secret capture is best-effort — if
//      automation fails the flow still continues with just the Bundle ID.

import type { CaptureState } from "@/shared/types";

const BANNER_ID = "adapty-asc-apps-banner";
const INTEGRATIONS_URL =
  "https://appstoreconnect.apple.com/access/integrations/api";
const APP_INFO_PATH_SUFFIX = "/distribution/info";

// Apple renders Bundle IDs like `com.example.app` — reverse-DNS style. Stay
// permissive (lowercase letters, digits, dot, underscore, hyphen) and require
// at least one dot so we don't accidentally match a single word.
const BUNDLE_ID_RE = /\b([a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+)\b/;

// The App-Specific Shared Secret is always a 32-char lowercase hex string.
const SHARED_SECRET_RE = /\b([a-f0-9]{32})\b/;

async function getCaptureState(): Promise<CaptureState> {
  const r = await chrome.storage.session.get("adapty_capture_state");
  return (r["adapty_capture_state"] as CaptureState | undefined) ?? {
    stage: "idle",
  };
}

function isAppsListPage(): boolean {
  return /\/apps\/?$/.test(location.pathname);
}

function appDetailId(): string | null {
  const m = location.pathname.match(/\/apps\/(\d+)/);
  return m?.[1] ?? null;
}

function isAppInfoPage(): boolean {
  // Exact path we want — /apps/{id}/distribution/info — is where ASC
  // surfaces the Bundle ID in the General → App Information panel.
  return /\/apps\/\d+\/distribution\/info(\/|$|\?)/.test(location.pathname);
}

function buildAppInfoUrl(appId: string): string {
  return `${location.origin}/apps/${appId}${APP_INFO_PATH_SUFFIX}`;
}

function showBanner(message: string): void {
  hideBanner();
  const host = document.createElement("div");
  host.id = BANNER_ID;
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.top = "16px";
  host.style.left = "50%";
  host.style.transform = "translateX(-50%)";
  host.style.zIndex = "2147483647";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .card {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
        Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #111;
      color: #fff;
      border: 1px solid rgba(112, 24, 255, 0.4);
      border-radius: 999px;
      padding: 10px 20px 10px 16px;
      font-size: 13px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.35);
      -webkit-font-smoothing: antialiased;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #7018FF;
      box-shadow: 0 0 0 0 rgba(112, 24, 255, 0.7);
      animation: pulse 1.6s infinite;
    }
    @keyframes pulse {
      0%   { box-shadow: 0 0 0 0 rgba(112, 24, 255, 0.7); }
      70%  { box-shadow: 0 0 0 10px rgba(112, 24, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(112, 24, 255, 0); }
    }
  `;
  shadow.appendChild(style);
  const card = document.createElement("div");
  card.className = "card";
  const dot = document.createElement("span");
  dot.className = "dot";
  const txt = document.createElement("span");
  txt.textContent = message;
  card.appendChild(dot);
  card.appendChild(txt);
  shadow.appendChild(card);
  document.documentElement.appendChild(host);
}

function hideBanner(): void {
  document.getElementById(BANNER_ID)?.remove();
}

// Bundle ID lives in the App Information panel. Apple's DOM is styled-
// components without test IDs, so try multiple strategies.
function findBundleId(): string | null {
  // Strategy 1: element with text exactly "Bundle ID" — look at its
  // siblings / parent's innerText for a reverse-DNS match.
  const labels = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
    (el) => {
      const t = (el.innerText || el.textContent || "").trim();
      return t === "Bundle ID" || t === "Bundle ID:";
    }
  );
  for (const label of labels) {
    let parent: HTMLElement | null = label.parentElement;
    for (let i = 0; i < 4 && parent; i++) {
      const text = parent.innerText || "";
      // Strip the "Bundle ID" label from the sample so we don't accidentally
      // match "id" within a word.
      const stripped = text.replace(/Bundle ID:?/i, "");
      const m = stripped.match(BUNDLE_ID_RE);
      if (m && m[1]) return m[1];
      parent = parent.parentElement;
    }
  }

  // Strategy 2: search the whole body for a reverse-DNS identifier near the
  // phrase "Bundle ID".
  const body = document.body?.innerText || "";
  const idx = body.indexOf("Bundle ID");
  if (idx >= 0) {
    const window = body.slice(idx, idx + 160);
    const m = window.match(BUNDLE_ID_RE);
    if (m && m[1]) return m[1];
  }

  return null;
}

async function waitForBundleId(): Promise<string> {
  const started = Date.now();
  // Apple's App Information panel renders as an SPA and can take a while on
  // slow connections — give it a generous 30 seconds before bailing out.
  const timeoutMs = 30_000;
  return new Promise<string>((resolve, reject) => {
    const tick = () => {
      const id = findBundleId();
      if (id) {
        resolve(id);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Bundle ID not found on this page"));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// App-Specific Shared Secret
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isElementVisible(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  return true;
}

function textOf(el: Element): string {
  return (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "";
}

// Find the "Manage" (or "View") button/link inside the App-Specific Shared
// Secret section. ASC renders this block somewhere below Bundle ID on the
// App Information page; the label text is the most reliable anchor.
function findManageSharedSecretButton(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], [role="link"]'
    )
  );

  // Locate the section container by walking up from the "App-Specific
  // Shared Secret" label — we only accept buttons that live in the same
  // subtree so we don't mis-click a "Manage" button from another section.
  const labels = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
    (el) => {
      const t = (el.innerText || el.textContent || "").trim();
      return /app-specific shared secret/i.test(t) && t.length < 80;
    }
  );
  for (const label of labels) {
    let scope: HTMLElement | null = label;
    for (let i = 0; i < 6 && scope; i++) {
      const buttons = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button, a, [role="button"], [role="link"]'
        )
      );
      for (const btn of buttons) {
        if (!isElementVisible(btn)) continue;
        if ((btn as HTMLButtonElement).disabled) continue;
        const tx = textOf(btn).toLowerCase();
        if (tx === "manage" || tx === "view" || tx.includes("manage")) {
          return btn;
        }
      }
      scope = scope.parentElement;
    }
  }

  // Fallback — any visible Manage button on the page (last-ditch).
  for (const btn of candidates) {
    if (!isElementVisible(btn)) continue;
    const tx = textOf(btn).toLowerCase();
    if (tx === "manage") {
      // Only accept if near shared-secret text in the page body.
      const near = (
        btn.closest("section, div, li, tr") as HTMLElement | null
      )?.innerText;
      if (near && /app-specific shared secret/i.test(near)) return btn;
    }
  }
  return null;
}

function findOpenDialog(): HTMLElement | null {
  // ASC dialogs can render as role="dialog" or inside #_m_modal. Prefer role.
  const byRole = document.querySelector<HTMLElement>('[role="dialog"]');
  if (byRole && isElementVisible(byRole)) return byRole;
  const byModal =
    document.querySelector<HTMLElement>("#_m_modal .tb-modal__box") ??
    document.querySelector<HTMLElement>("#_m_modal");
  if (byModal && isElementVisible(byModal)) return byModal;
  return null;
}

function extractSharedSecretFromNode(node: HTMLElement): string | null {
  const text = node.innerText || node.textContent || "";
  const m = text.match(SHARED_SECRET_RE);
  return m?.[1] ?? null;
}

// Open the Manage dialog, wait for the 32-char hex secret to appear. If the
// app has never had a shared secret, the dialog shows only a "Generate"
// button and a description — click Generate and wait again. Best-effort;
// returns null if anything fails.
async function captureSharedSecret(): Promise<string | null> {
  const manageBtn = findManageSharedSecretButton();
  if (!manageBtn) return null;

  manageBtn.click();
  manageBtn.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
  );

  // Wait for the Shared Secret dialog to render.
  const openDeadline = Date.now() + 8_000;
  let dialog: HTMLElement | null = null;
  while (Date.now() < openDeadline) {
    await sleep(150);
    const d = findOpenDialog();
    if (d && /app-specific shared secret/i.test(d.innerText || "")) {
      dialog = d;
      break;
    }
  }
  if (!dialog) return null;

  const findSecret = (): string | null => {
    const fresh = findOpenDialog() ?? dialog;
    if (!fresh) return null;
    dialog = fresh;
    return extractSharedSecretFromNode(fresh);
  };

  // Quick pass — maybe the secret is already there (existing shared secret).
  let secret: string | null = null;
  const quickDeadline = Date.now() + 1_500;
  while (Date.now() < quickDeadline) {
    await sleep(150);
    secret = findSecret();
    if (secret) break;
  }

  // No secret yet — click "Generate" to create one, then keep polling.
  if (!secret && dialog) {
    const generateBtn = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, [role="button"]')
    ).find((b) => {
      if (!isElementVisible(b)) return false;
      if ((b as HTMLButtonElement).disabled) return false;
      const tx = textOf(b).toLowerCase();
      return tx === "generate";
    });
    if (generateBtn) {
      generateBtn.click();
      generateBtn.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        })
      );
      // Apple may surface a confirmation dialog on top ("Generate a new
      // shared secret?"). Click through any primary confirm button that
      // isn't labelled Cancel/Close.
      await sleep(400);
      const confirmScope = findOpenDialog();
      if (confirmScope && confirmScope !== dialog) {
        const confirm = Array.from(
          confirmScope.querySelectorAll<HTMLElement>(
            'button, [role="button"]'
          )
        ).find((b) => {
          if (!isElementVisible(b)) return false;
          if ((b as HTMLButtonElement).disabled) return false;
          const tx = textOf(b).toLowerCase();
          return (
            tx === "generate" ||
            tx === "confirm" ||
            tx === "continue" ||
            tx === "yes"
          );
        });
        confirm?.click();
      }

      const genDeadline = Date.now() + 15_000;
      while (Date.now() < genDeadline) {
        await sleep(200);
        secret = findSecret();
        if (secret) break;
      }
    }
  }

  // Best-effort close so the user isn't staring at the dialog when we
  // navigate away. Look for Done / Close / Cancel inside the dialog.
  if (dialog) {
    const closeBtn = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, a, [role="button"]')
    ).find((b) => {
      if (!isElementVisible(b)) return false;
      const tx = textOf(b).toLowerCase();
      return tx === "done" || tx === "close" || tx === "cancel";
    });
    if (closeBtn) {
      closeBtn.click();
    } else {
      const xBtn = dialog.querySelector<HTMLElement>(
        'button[aria-label="Close" i], [aria-label="Close" i]'
      );
      xBtn?.click();
    }
  }

  return secret;
}

async function onAppsListPage(): Promise<void> {
  showBanner("Click the app you're configuring in Adapty…");

  // Watch for location changes (ASC is SPA — listen on popstate and poll).
  let lastPath = location.pathname;
  const poll = window.setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      const id = appDetailId();
      if (id) {
        window.clearInterval(poll);
        // As soon as an app is picked, hop straight to the App Information
        // panel — Apple's router doesn't always land us there by default.
        if (!isAppInfoPage()) {
          showBanner("Opening App Information…");
          location.href = buildAppInfoUrl(id);
          return;
        }
        void onAppInfoPage();
      }
    }
  }, 500);
}

async function onAppInfoPage(): Promise<void> {
  showBanner("Reading Bundle ID…");
  try {
    const bundleId = await waitForBundleId();
    await chrome.storage.session.set({ adapty_pending_bundle_id: bundleId });

    // Best-effort shared-secret capture — don't fail the flow if this
    // doesn't work. Some apps legitimately have no shared secret yet;
    // Apple may also change the dialog DOM.
    showBanner("Reading App-Specific Shared Secret…");
    let sharedSecret: string | null = null;
    try {
      sharedSecret = await captureSharedSecret();
    } catch (err) {
      console.warn("[adapty/asc-apps] shared secret capture failed:", err);
    }
    if (sharedSecret) {
      await chrome.storage.session.set({
        adapty_pending_shared_secret: sharedSecret,
      });
      showBanner(`Got Bundle ID + Shared Secret — opening the keys page…`);
    } else {
      // Clear any stale value from a prior attempt so asc.ts doesn't pick
      // up the wrong secret.
      await chrome.storage.session.remove("adapty_pending_shared_secret");
      showBanner(
        `Got ${bundleId} — (no shared secret found) opening the keys page…`
      );
    }
    // Small delay so the user sees the banner update before we navigate.
    setTimeout(() => {
      location.href = INTEGRATIONS_URL;
    }, 900);
  } catch (err) {
    console.warn("[adapty/asc-apps] bundle id not found:", err);
    showBanner(
      "Couldn't find the Bundle ID — scroll to App Information and try again."
    );
  }
}

async function init(): Promise<void> {
  const state = await getCaptureState();
  if (state.stage !== "capturing_appstore") return;

  const id = appDetailId();
  if (id && isAppInfoPage()) {
    // User is already on the App Information page — scrape and continue.
    await onAppInfoPage();
  } else if (id) {
    // On some other /apps/:id/* route — bounce to /distribution/info.
    showBanner("Opening App Information…");
    location.href = buildAppInfoUrl(id);
    return;
  } else if (isAppsListPage()) {
    await onAppsListPage();
  }

  // Also react to state changes — e.g., if the user cancels, hide the banner.
  chrome.storage.session.onChanged.addListener((changes) => {
    if ("adapty_capture_state" in changes) {
      const next = changes["adapty_capture_state"]?.newValue as
        | CaptureState
        | undefined;
      if (!next || next.stage !== "capturing_appstore") {
        hideBanner();
      }
    }
  });
}

init();
