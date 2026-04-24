// Adapty Credential Helper — MV3 service worker.
//
// Responsibilities:
//   1) Accept ADAPTY_START_CAPTURE from the onboarding content script, set
//      the capture state, and open/focus the relevant provider entry URL
//      (ASC Apps list for App Store, GCP project picker for Play Store).
//   2) Persist credentials submitted by the ASC / Play Console overlays
//      into session storage and re-focus the Adapty onboarding tab.
//   3) Serve ADAPTY_REQUEST_FILL / OVERLAY_GET_STATE queries so the panel
//      and overlays can render without reading storage directly.

import { log, warn, error as logError } from "@/shared/log";
import type {
  AppStoreCaptured,
  ExtensionMessage,
  PlayStoreCaptured,
  StoreType,
} from "@/shared/types";
import {
  clearCaptureState,
  getCaptureState,
  setCaptureState,
} from "@/background/state";

const VERSION = chrome.runtime.getManifest().version;

// Starting URL for each store's capture flow. App Store begins on the Apps
// list so we can scrape the bundle id before diving into key creation; Play
// Store begins on the GCP project picker.
const STORE_START_URL: Record<StoreType, string> = {
  appstore: "https://appstoreconnect.apple.com/apps",
  playstore:
    "https://console.cloud.google.com/projectselector2/iam-admin/serviceaccounts?supportedpurview=project",
};

const KEY_APPSTORE = "adapty_captured_appstore";
const KEY_PLAYSTORE = "adapty_captured_playstore";

async function openOrFocusTab(url: string): Promise<chrome.tabs.Tab | null> {
  try {
    const tabs = await chrome.tabs.query({});
    const origin = new URL(url).origin;
    const existing = tabs.find((t) => t.url?.startsWith(origin));
    if (existing?.id !== undefined) {
      const updated = await chrome.tabs.update(existing.id, {
        active: true,
        url,
      });
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      if (existing.url && existing.url === url) {
        try {
          await chrome.tabs.reload(existing.id, { bypassCache: false });
        } catch {
          // Content scripts also poll storage as a safety net.
        }
      }
      return updated ?? null;
    }
    const created = await chrome.tabs.create({ url, active: true });
    return created;
  } catch (e) {
    logError("openOrFocusTab", e);
    return null;
  }
}

async function focusTabById(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {
    warn("focusTabById failed", tabId, e);
  }
}

async function startCapture(
  storeType: StoreType,
  adaptyTabId: number | undefined
): Promise<void> {
  if (!adaptyTabId) {
    logError("startCapture: missing tab id", storeType);
    return;
  }
  await setCaptureState({
    stage: storeType === "appstore" ? "capturing_appstore" : "capturing_playstore",
    adapty_tab_id: adaptyTabId,
    error: undefined,
  });
  const url = STORE_START_URL[storeType];
  const tab = await openOrFocusTab(url);
  if (tab?.id !== undefined) {
    await setCaptureState((prev) => ({ ...prev, capture_tab_id: tab.id }));
  }
}

async function persistCredentials(
  storeType: StoreType,
  credentials: AppStoreCaptured | PlayStoreCaptured
): Promise<void> {
  if (storeType === "appstore") {
    await chrome.storage.session.set({ [KEY_APPSTORE]: credentials });
  } else {
    await chrome.storage.session.set({ [KEY_PLAYSTORE]: credentials });
  }
  await setCaptureState((prev) => ({
    ...prev,
    stage: "ready_to_fill",
    error: undefined,
  }));
}

async function getCaptured(): Promise<{
  appstore?: AppStoreCaptured;
  playstore?: PlayStoreCaptured;
}> {
  const entry = await chrome.storage.session.get([KEY_APPSTORE, KEY_PLAYSTORE]);
  return {
    appstore: entry[KEY_APPSTORE] as AppStoreCaptured | undefined,
    playstore: entry[KEY_PLAYSTORE] as PlayStoreCaptured | undefined,
  };
}

async function clearCaptured(storeType?: StoreType): Promise<void> {
  if (!storeType) {
    await chrome.storage.session.remove([KEY_APPSTORE, KEY_PLAYSTORE]);
  } else if (storeType === "appstore") {
    await chrome.storage.session.remove(KEY_APPSTORE);
  } else {
    await chrome.storage.session.remove(KEY_PLAYSTORE);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message handlers
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message as ExtensionMessage;
  if (!msg || typeof msg !== "object") return false;

  switch (msg.type) {
    case "ADAPTY_START_CAPTURE": {
      // Prefer sender.tab.id (authoritative) over a value the content script
      // might have provided. Keep the explicit field as a fallback for code
      // paths that send this message from non-tab contexts (e.g. popup).
      const tabId = sender.tab?.id ?? msg.adapty_tab_id;
      startCapture(msg.store_type, tabId).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    case "ADAPTY_CAPTURE_CANCEL":
      clearCaptureState().then(() => sendResponse({ ok: true }));
      return true;

    case "ADAPTY_REQUEST_FILL":
      getCaptured().then(({ appstore, playstore }) => {
        sendResponse({ appstore, playstore });
      });
      return true;

    case "ADAPTY_CLEAR_CAPTURED":
      clearCaptured(msg.store_type).then(() => sendResponse({ ok: true }));
      return true;

    case "OVERLAY_GET_STATE":
      getCaptureState().then((state) => sendResponse({ state }));
      return true;

    case "OVERLAY_OPEN_PLAY_CONSOLE":
      // Hand-off from the GCP content script after the JSON key is captured.
      (async () => {
        try {
          await openOrFocusTab(
            "https://play.google.com/console/u/0/developers/_/users-and-permissions"
          );
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      return true;

    case "OVERLAY_SUBMIT_CREDENTIALS":
      (async () => {
        try {
          const state = await getCaptureState();
          const expectedStage =
            msg.store_type === "appstore"
              ? "capturing_appstore"
              : "capturing_playstore";

          // Idempotency: if the fill is already done (ready_to_fill), ack
          // without rewriting. Content-script callers can fire repeatedly
          // (blob-hook firing twice, retries).
          if (state.stage === "ready_to_fill") {
            sendResponse({ ok: true });
            return;
          }
          if (state.stage !== expectedStage) {
            throw new Error(
              `No active ${msg.store_type} capture — restart from the Adapty panel.`
            );
          }
          await persistCredentials(msg.store_type, msg.credentials);
          if (state.adapty_tab_id) {
            await focusTabById(state.adapty_tab_id);
          }
          sendResponse({ ok: true });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await setCaptureState({ stage: "error", error: message });
          sendResponse({ ok: false, error: message });
        }
      })();
      return true;

    default:
      return false;
  }
});

// Allow content scripts to read chrome.storage.session. Without this call
// Chrome 115+ defaults the access level to TRUSTED_CONTEXTS and content
// scripts throw "Access to storage is not allowed from this context."
try {
  const sessionStorage = chrome.storage.session as unknown as {
    setAccessLevel?: (opts: { accessLevel: string }) => Promise<void> | void;
  };
  sessionStorage.setAccessLevel?.({
    accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
  });
} catch (err) {
  warn("session storage setAccessLevel failed (older Chrome?)", err);
}

log("service worker booted", VERSION);
