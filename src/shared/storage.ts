// Thin wrapper around chrome.storage.session for captured credentials and
// flow state. Session storage is cleared when the browser closes — captured
// .p8 and service-account JSON intentionally do NOT survive a restart.

import type {
  AppStoreCaptured,
  CaptureState,
  PlayStoreCaptured,
  StoreType,
} from "@/shared/types";

const KEY_STATE = "adapty_capture_state";
const KEY_APPSTORE = "adapty_captured_appstore";
const KEY_PLAYSTORE = "adapty_captured_playstore";
// Bundle ID captured on the ASC app detail page; read by the API-keys page
// content script when packaging the final AppStoreCaptured.
const KEY_PENDING_BUNDLE_ID = "adapty_pending_bundle_id";

const EMPTY_STATE: CaptureState = { stage: "idle" };

export async function getCaptureState(): Promise<CaptureState> {
  const r = await chrome.storage.session.get(KEY_STATE);
  return (r[KEY_STATE] as CaptureState | undefined) ?? EMPTY_STATE;
}

export async function setCaptureState(
  next: CaptureState | ((prev: CaptureState) => CaptureState)
): Promise<CaptureState> {
  const prev = await getCaptureState();
  const value = typeof next === "function" ? next(prev) : next;
  await chrome.storage.session.set({ [KEY_STATE]: value });
  return value;
}

export async function clearCaptureState(): Promise<void> {
  await chrome.storage.session.remove(KEY_STATE);
}

export async function getAppStoreCaptured(): Promise<
  AppStoreCaptured | undefined
> {
  const r = await chrome.storage.session.get(KEY_APPSTORE);
  return r[KEY_APPSTORE] as AppStoreCaptured | undefined;
}

export async function setAppStoreCaptured(c: AppStoreCaptured): Promise<void> {
  await chrome.storage.session.set({ [KEY_APPSTORE]: c });
}

export async function getPlayStoreCaptured(): Promise<
  PlayStoreCaptured | undefined
> {
  const r = await chrome.storage.session.get(KEY_PLAYSTORE);
  return r[KEY_PLAYSTORE] as PlayStoreCaptured | undefined;
}

export async function setPlayStoreCaptured(c: PlayStoreCaptured): Promise<void> {
  await chrome.storage.session.set({ [KEY_PLAYSTORE]: c });
}

export async function clearCaptured(store?: StoreType): Promise<void> {
  if (!store || store === "appstore") {
    await chrome.storage.session.remove(KEY_APPSTORE);
  }
  if (!store || store === "playstore") {
    await chrome.storage.session.remove(KEY_PLAYSTORE);
  }
}

export async function getPendingBundleId(): Promise<string | undefined> {
  const r = await chrome.storage.session.get(KEY_PENDING_BUNDLE_ID);
  return r[KEY_PENDING_BUNDLE_ID] as string | undefined;
}

export async function setPendingBundleId(id: string): Promise<void> {
  await chrome.storage.session.set({ [KEY_PENDING_BUNDLE_ID]: id });
}

export async function clearPendingBundleId(): Promise<void> {
  await chrome.storage.session.remove(KEY_PENDING_BUNDLE_ID);
}

export const STORAGE_KEYS = {
  state: KEY_STATE,
  appstore: KEY_APPSTORE,
  playstore: KEY_PLAYSTORE,
  pendingBundleId: KEY_PENDING_BUNDLE_ID,
} as const;
