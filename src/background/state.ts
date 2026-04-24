// Thin wrapper around chrome.storage.session for the capture flow state.
// Session storage survives the service worker being unloaded but is cleared
// when the browser closes — captured keys intentionally do NOT persist.

import type { CaptureState } from "@/shared/types";

const KEY = "adapty_capture_state";
const EMPTY: CaptureState = { stage: "idle" };

export async function getCaptureState(): Promise<CaptureState> {
  const r = await chrome.storage.session.get(KEY);
  const value = r[KEY] as CaptureState | undefined;
  return value ?? EMPTY;
}

export async function setCaptureState(
  next: CaptureState | ((prev: CaptureState) => CaptureState)
): Promise<CaptureState> {
  const prev = await getCaptureState();
  const value = typeof next === "function" ? next(prev) : next;
  await chrome.storage.session.set({ [KEY]: value });
  return value;
}

export async function clearCaptureState(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
