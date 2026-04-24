// Shared types between service worker, content scripts, overlay, and popup.

export type StoreType = "appstore" | "playstore";

export type CaptureStage =
  | "idle"
  | "capturing_appstore"
  | "capturing_playstore"
  | "ready_to_fill"
  | "error";

export interface CaptureState {
  stage: CaptureStage;
  error?: string;
  // Tab where the Adapty onboarding form lives. Service worker re-focuses
  // this tab once credentials are captured.
  adapty_tab_id?: number;
  // The active sub-flow needs its own tab id so we can close/focus cleanly.
  capture_tab_id?: number;
}

export interface AppStoreCaptured {
  bundle_id?: string;
  issuer_id: string;
  api_key_id: string;
  // Raw .p8 file text (PEM). Bytes are written back into Adapty's file input
  // via a File/DataTransfer shim; we keep the text form in session storage.
  private_key: string;
  private_key_filename: string;
  // App-Specific Shared Secret (32-char hex) scraped from the App Information
  // page's "Manage" dialog. Optional because some apps don't have one yet
  // and the user can still configure the rest of the credentials without it.
  shared_secret?: string;
  captured_at: number;
}

export interface PlayStoreCaptured {
  package_name?: string;
  // Raw service-account JSON string.
  service_account_json: string;
  service_account_filename: string;
  captured_at: number;
}

export type ExtensionMessage =
  | {
      type: "ADAPTY_START_CAPTURE";
      store_type: StoreType;
      // Optional — if omitted, the service worker uses sender.tab.id.
      adapty_tab_id?: number;
    }
  | { type: "ADAPTY_CAPTURE_CANCEL" }
  | { type: "ADAPTY_REQUEST_FILL" }
  | { type: "ADAPTY_CLEAR_CAPTURED"; store_type?: StoreType }
  | { type: "OVERLAY_GET_STATE" }
  | {
      type: "OVERLAY_SUBMIT_CREDENTIALS";
      store_type: StoreType;
      credentials: AppStoreCaptured | PlayStoreCaptured;
    }
  | { type: "OVERLAY_OPEN_PLAY_CONSOLE" }
  | { type: "CONTENT_BLOB_CAPTURED"; mime: string; text: string };
