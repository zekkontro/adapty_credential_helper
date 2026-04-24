// MV3 manifest for the Adapty credential-helper extension.
// Consumed by @crxjs/vite-plugin; the plugin emits `manifest.json` into dist/
// using this module's default export.

import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

export default defineManifest({
  manifest_version: 3,
  name: "Adapty Credential Helper",
  description:
    "Imports App Store Connect and Google Play Console credentials directly into the Adapty onboarding form.",
  version: pkg.version,
  action: {
    default_title: "Adapty Credential Helper",
    default_popup: "src/popup/popup.html",
    default_icon: {
      16: "src/assets/icon-16.png",
      48: "src/assets/icon-48.png",
      128: "src/assets/icon-128.png",
    },
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  icons: {
    16: "src/assets/icon-16.png",
    48: "src/assets/icon-48.png",
    128: "src/assets/icon-128.png",
  },
  permissions: ["storage", "scripting", "tabs"],
  host_permissions: [
    "https://appstoreconnect.apple.com/*",
    "https://play.google.com/*",
    "https://console.cloud.google.com/*",
    "https://app.adapty.io/*",
    "https://*.adapty.io/*",
  ],
  content_scripts: [
    {
      matches: ["https://appstoreconnect.apple.com/apps*"],
      js: ["src/content/asc-apps.ts"],
      run_at: "document_idle",
    },
    {
      matches: [
        "https://appstoreconnect.apple.com/access/integrations/*",
        "https://appstoreconnect.apple.com/access/api/*",
      ],
      js: ["src/content/asc.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://play.google.com/console/*"],
      js: ["src/content/play-console.ts"],
      run_at: "document_idle",
    },
    {
      matches: ["https://console.cloud.google.com/*"],
      js: ["src/content/gcp.ts"],
      run_at: "document_idle",
    },
    {
      matches: [
        "https://app.adapty.io/*",
        "https://*.adapty.io/*",
      ],
      js: ["src/content/adapty-onboarding.ts"],
      run_at: "document_idle",
    },
  ],
  web_accessible_resources: [
    {
      // Vite chunks content scripts into shared modules under `assets/*.js`.
      // Content scripts import those chunks dynamically at runtime, so Chrome
      // must allow the host page to load them.
      resources: [
        "assets/*",
        "src/injected/blob-hook.ts",
        "src/assets/logo-mark.png",
        "src/assets/logo-horizontal.svg",
      ],
      matches: [
        "https://appstoreconnect.apple.com/*",
        "https://console.cloud.google.com/*",
        "https://play.google.com/*",
        "https://app.adapty.io/*",
        "https://*.adapty.io/*",
      ],
    },
  ],
});
