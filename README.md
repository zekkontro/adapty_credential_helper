<div align="center">

<img src="src/assets/logo-horizontal.svg" alt="Adapty Credential Helper" width="280" />

# Adapty Credential Helper

**A Chrome extension that fills the [Adapty](https://app.adapty.io) onboarding form in minutes by auto-capturing App Store Connect and Google Play Console credentials.**

[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/bundler-Vite%205-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Manifest V3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/license-MIT-7018FF.svg)](LICENSE)

[Features](#features) ·
[Installation](#installation) ·
[Usage](#usage) ·
[Privacy](#privacy) ·
[Development](#development)

</div>

---

## Why this exists

Setting Adapty up means jumping between App Store Connect, Google Cloud Console, and Play Console to collect:

- **App Store**: Bundle ID, Issuer ID, Key ID, `.p8` private key, App-Specific Shared Secret
- **Play Store**: Package name, Google Cloud service-account JSON

Doing this by hand usually takes 30 to 60 minutes and is the most frustrating step of onboarding. This extension automates the whole flow and writes the captured values straight into Adapty's form. Typical completion time: under 5 minutes.

---

## Features

### App Store Connect

- Reads the Bundle ID from the App Information panel
- Opens the Manage dialog for App-Specific Shared Secret and clicks Generate if none exists, then scrapes the 32-character hex value
- Opens the Create API Key dialog, prefills the key name, highlights the Access field (you pick the role)
- Auto-clicks Download in the Download API Key dialog, captures the `.p8` blob via a `URL.createObjectURL` hook

### Google Play

- Highlights the GCP project picker and waits for your selection
- Enables the two required Google Play APIs (Android Developer, Developer Reporting)
- Creates a service account and grants it the Pub/Sub Admin and Monitoring Viewer roles
- Generates and captures the JSON key
- Automates the Play Console invite flow (email, 7 required permission checkboxes, confirmation)

### Adapty form fill

- Injects a panel on the onboarding page at the top right
- Fills every field using the React native value setter
- Uploads the `.p8` and JSON files directly into the dropzones via a `DataTransfer` shim

### Privacy first

- Credentials live only in `chrome.storage.session`, wiped automatically when you close the browser
- No external server calls, no logging, no telemetry
- The `.p8` and service-account JSON flow from the provider's page into the Adapty form entirely in the browser

---

## Installation

Until it lands on the Chrome Web Store, the extension is installed in "Load unpacked" mode. About 5 minutes of setup.

### Requirements

- Google Chrome 116+ (or any Chromium-based browser: Brave, Edge, Arc)
- Node.js 18+ (only needed to build from source)
- git

### Step by step

**1. Clone the repo and install dependencies:**

```bash
git clone https://github.com/<your-username>/adapty-credential-helper.git
cd adapty-credential-helper
npm install
npm run build
```

The build produces a `dist/` folder. That's what you'll load into Chrome.

**2. Open Chrome and navigate to:**

```
chrome://extensions
```

**3. Toggle "Developer mode" on (top right corner).**

**4. Click the "Load unpacked" button that appears.**

**5. In the folder picker, select the `dist/` folder inside the cloned repo.**

**6. The extension appears in your list.** Pin it from the puzzle-piece icon in the Chrome toolbar so you can always reach it.

### Alternative: install from a prebuilt ZIP

If you would rather not set up a dev environment, grab the latest `.zip` from the [Releases](../../releases) page and:

1. Unzip it
2. Open `chrome://extensions`, turn Developer mode on, click "Load unpacked"
3. Select the unzipped folder

### Updating

When a new version is released:

```bash
git pull
npm install
npm run build
```

Then press the Reload button on the extension's card in `chrome://extensions`.

---

## Usage

### 1. Open the Adapty onboarding page

Go to **[app.adapty.io/onboarding](https://app.adapty.io/onboarding)**.

### 2. Advance to the "Connect app stores" step

Once the page loads, a purple helper panel appears in the top-right corner:

```
┌─────────────────────────────────────────┐
│ Adapty Credential Helper                │
│ Pull keys from App Store & Play Store   │
├─────────────────────────────────────────┤
│ App Store     Not captured              │
│                    [Import from App..]  │
│                                         │
│ Play Store    Not captured              │
│                    [Import from Play..] │
└─────────────────────────────────────────┘
```

### 3. Capture the App Store credentials

Click "Import from App Store".

1. App Store Connect opens in a new tab
2. Click the app you want to connect (once)
3. The extension navigates to the App Information page automatically
4. Bundle ID and Shared Secret are captured
5. You are then redirected to the API Keys page
6. In the overlay, click "Create Adapty Integration key"
7. **You pick the access role** (App Manager is the typical choice) and click Generate
8. The `.p8` file downloads and is captured automatically
9. Focus returns to Adapty and the form fields and file are filled in

### 4. Capture the Play Store credentials

Click "Import from Play Store".

1. Google Cloud Console opens
2. Pick your project (the project picker is highlighted with a purple border)
3. The extension enables the required Google Play APIs (takes about 30 seconds)
4. A service account is created and granted Pub/Sub Admin and Monitoring Viewer roles
5. A JSON key is generated and captured
6. Play Console opens; select your developer account
7. The extension fills the invite form and submits it
8. Back on Adapty, you are asked for the package name; enter it and click Save

### 5. Review and submit

If everything looks filled in, click "Continue" to finish onboarding.

---

## FAQ

<details>
<summary><b>The panel doesn't show up on Adapty</b></summary>

- Refresh the page (Cmd/Ctrl+R)
- Make sure the extension is enabled at `chrome://extensions`
- Confirm you're on `app.adapty.io/onboarding` (not any other Adapty page)

</details>

<details>
<summary><b>The App Store flow freezes on the Access role selection</b></summary>

This is the expected behavior. Apple's Access combobox resists automation, so role selection is intentionally left to you. Click the Access field (highlighted in purple), pick your role (for example App Manager), and press Generate. The extension takes over from there.

</details>

<details>
<summary><b>Shared Secret wasn't captured</b></summary>

If your account doesn't have the Account Holder or Admin role, Apple hides the secret. In that case, fill the Shared Secret field on the Adapty form manually. Apple may also have changed the dialog DOM; if so, please [open an issue](../../issues/new).

</details>

<details>
<summary><b>Do I need to create a new Google Cloud project?</b></summary>

No, an existing project works. That said, for Play Store the project is where the Android Publisher and Developer Reporting APIs get enabled. In production, this is typically a dedicated project for your app.

</details>

<details>
<summary><b>Are credentials stored permanently?</b></summary>

No. Captured data lives only in `chrome.storage.session`, which Chrome clears automatically when the browser closes. You can also wipe it any time from the popup's "Clear captured credentials" button.

</details>

<details>
<summary><b>The extension isn't working, how do I debug?</b></summary>

Console logs are the best clue:

- On the Adapty tab: right click, Inspect, Console, look for `[adapty/*]` prefixed logs
- Service worker: `chrome://extensions`, Adapty Credential Helper card, click "service worker"

Include those logs when filing an [issue](../../issues/new).

</details>

---

## Privacy

- The extension talks to no external server. It only interacts with Apple, Google, and Adapty pages.
- Captured credentials live exclusively in `chrome.storage.session`, which Chrome wipes when the browser closes. They are never written to `chrome.storage.local`.
- The `.p8` file and service-account JSON are read via a page-context blob hook and passed directly into the Adapty form. Nothing is logged, nothing is uploaded, nothing is sent anywhere.
- You can clear all session state at any time using the "Clear captured credentials" button in the popup.

Host permissions (from `manifest.json`):

```json
"host_permissions": [
  "https://appstoreconnect.apple.com/*",
  "https://play.google.com/*",
  "https://console.cloud.google.com/*",
  "https://app.adapty.io/*",
  "https://*.adapty.io/*"
]
```

Every entry is required for the flow; no other origins are accessible to the extension.

---

## Architecture

```
chrome.storage.session
  adapty_capture_state
  adapty_captured_appstore / playstore
  adapty_pending_bundle_id / shared_secret / gcp_service_account_*
         ▲                    ▲                    ▲
         │                    │                    │
  service worker       content scripts       adapty-onboarding
  (orchestrator)  <->  asc, asc-apps    <->  (panel + form-fill)
                       gcp, play-console
                              │
                              ├── overlay/wizard.ts (shadow-DOM UI)
                              ├── overlay/page-dimmer.ts (blocks clicks)
                              └── injected/blob-hook.ts (URL.createObjectURL)

popup/ (toolbar UI, status + shortcuts)
```

- **Content scripts** drive each platform's DOM. They target stable anchors (aria-labels, `debug-id`, component tag names) and fall back to text matching when Apple or Google ship layout changes.
- **Overlay** is rendered inside a shadow DOM so host-page CSS cannot leak in.
- **Blob hook** is injected into the page context (not the content-script isolated world). It wraps `URL.createObjectURL` so `.p8` and JSON downloads are captured before Chrome opens a file dialog.
- **Service worker** holds the capture state, opens or focuses the right tab, and returns focus to the Adapty tab when done.
- **Adapty content script** writes into React-controlled inputs using `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`, and fills file inputs with a `DataTransfer` shim.

There is no backend; the extension is fully self-contained.

---

## Development

```
src/
├── background/          service-worker.ts, state.ts
├── content/
│   ├── asc-apps.ts      ASC /apps (bundle ID, shared secret)
│   ├── asc.ts           ASC /access/api (API key, .p8 capture)
│   ├── asc-automate.ts  ASC DOM helpers
│   ├── gcp.ts           GCP (project, APIs, SA, JSON key)
│   ├── gcp-automate.ts  GCP DOM helpers (role picker, stepper)
│   ├── play-console.ts  Play Console invite flow
│   ├── play-automate.ts Play Console DOM helpers
│   └── adapty-onboarding.ts  Adapty form panel and auto-fill
├── overlay/             Shadow-DOM wizard and full-viewport dimmer
├── injected/            blob-hook.ts (page-context shim)
├── popup/               Toolbar popup
├── shared/              types, log, storage helpers
└── manifest.config.ts   MV3 manifest
```

### Commands

```bash
npm run dev       # watch build, writes to dist/
npm run build     # one-shot production build
npx tsc --noEmit  # type-check without emitting
npm run release   # build and zip (dist/adapty-credential-helper-v*.zip)
```

### Stack

- TypeScript 5 with strict mode and `noUncheckedIndexedAccess`
- Vite 5 with [`@crxjs/vite-plugin`](https://crxjs.dev/) for MV3 bundling and HMR
- Vanilla DOM, no frameworks, total bundle around 80 kB

---

## Roadmap

- [ ] App Store Small Business Program and Play Reduced Service Fee toggles
- [ ] Chrome Web Store listing
- [ ] Turkish UI support

---

## Contributing

Issues and PRs are welcome. The most fragile part of the extension is the DOM selectors for ASC, GCP, and Play Console. If Apple or Google change a UI and something breaks, opening an [issue](../../issues/new) with the failing selector and a screenshot is the quickest path to a fix.

Before sending a PR:

```bash
npx tsc --noEmit
npm run build
```

---

## License

[MIT](LICENSE), Berat Kurt.

This extension is not affiliated with or endorsed by Adapty, Apple, or Google.
