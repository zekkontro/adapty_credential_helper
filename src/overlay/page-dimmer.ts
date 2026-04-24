// Full-viewport dimming overlay mounted on top of the host page while
// automation is running. Purpose:
//   1) Visually signal that the extension is driving the page — hands off.
//   2) Block pointer events on the native site so a premature click can't
//      race against the automation.
//   3) Expose a "Let me do this manually" escape so the user can bail out
//      at any time.
//
// Sits at z-index just below the wizard popup so the popup stays readable
// on top. Shadow-DOM encapsulated.

import overlayCss from "./wizard.css?inline";

const LOGO_URL =
  typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("src/assets/logo-mark.png")
    : "";

export interface DimmerState {
  title: string;
  subtitle?: string;
}

export class PageDimmer {
  private root: HTMLDivElement;
  private shadow: ShadowRoot;
  private backdrop: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private subtitleEl: HTMLDivElement;
  private cancelBtn: HTMLButtonElement;
  private mounted = false;
  private onCancelFn: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "adapty-dimmer-host";
    this.root.style.all = "initial";
    this.root.style.position = "fixed";
    this.root.style.inset = "0";
    this.root.style.zIndex = "2147483640";
    this.root.style.pointerEvents = "auto";
    this.shadow = this.root.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      ${overlayCss}
      :host, .fv-dim-backdrop {
        --fv-accent: #7018FF;
      }
      .fv-dim-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        display: grid;
        place-items: center;
        animation: fv-dim-fade-in 220ms ease-out;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
          Roboto, "Helvetica Neue", Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      @keyframes fv-dim-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      .fv-dim-card {
        display: flex;
        align-items: center;
        gap: 18px;
        padding: 18px 24px;
        border-radius: 20px;
        background: rgba(22, 22, 22, 0.92);
        color: #ffffff;
        border: 1px solid rgba(112, 24, 255, 0.25);
        box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.55),
          0 2px 4px -1px rgba(0, 0, 0, 0.4);
        max-width: 560px;
      }
      .fv-dim-logo {
        width: 40px;
        height: 40px;
        border-radius: 12px;
        flex-shrink: 0;
      }
      .fv-dim-spinner {
        width: 28px;
        height: 28px;
        border: 3px solid rgba(112, 24, 255, 0.25);
        border-top-color: #7018FF;
        border-radius: 50%;
        animation: fv-dim-spin 900ms linear infinite;
        flex-shrink: 0;
      }
      @keyframes fv-dim-spin {
        to { transform: rotate(360deg); }
      }
      .fv-dim-text {
        flex: 1;
        min-width: 0;
      }
      .fv-dim-title {
        font-weight: 600;
        font-size: 14px;
        letter-spacing: -0.01em;
        line-height: 1.3;
      }
      .fv-dim-subtitle {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.7);
        margin-top: 4px;
        line-height: 1.45;
      }
      .fv-dim-cancel {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.25);
        color: rgba(255, 255, 255, 0.9);
        padding: 8px 14px;
        border-radius: 9999px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        transition: background 200ms ease, border-color 200ms ease,
          color 200ms ease;
        flex-shrink: 0;
      }
      .fv-dim-cancel:hover {
        background: #7018FF;
        border-color: #7018FF;
        color: #ffffff;
      }
    `;
    this.shadow.appendChild(style);

    this.backdrop = document.createElement("div");
    this.backdrop.className = "fv-dim-backdrop";

    const card = document.createElement("div");
    card.className = "fv-dim-card";

    const logo = document.createElement("img");
    logo.className = "fv-dim-logo";
    logo.src = LOGO_URL;
    logo.alt = "Adapty Credential Helper";
    card.appendChild(logo);

    const spinner = document.createElement("div");
    spinner.className = "fv-dim-spinner";
    card.appendChild(spinner);

    const textWrap = document.createElement("div");
    textWrap.className = "fv-dim-text";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "fv-dim-title";
    this.subtitleEl = document.createElement("div");
    this.subtitleEl.className = "fv-dim-subtitle";
    textWrap.appendChild(this.titleEl);
    textWrap.appendChild(this.subtitleEl);
    card.appendChild(textWrap);

    this.cancelBtn = document.createElement("button");
    this.cancelBtn.type = "button";
    this.cancelBtn.className = "fv-dim-cancel";
    this.cancelBtn.textContent = "Let me do it manually";
    this.cancelBtn.addEventListener("click", () => {
      this.onCancelFn?.();
    });
    card.appendChild(this.cancelBtn);

    this.backdrop.appendChild(card);
    this.shadow.appendChild(this.backdrop);
  }

  onCancel(handler: () => void): void {
    this.onCancelFn = handler;
  }

  show(state: DimmerState): void {
    this.setState(state);
    if (!this.mounted) {
      document.documentElement.appendChild(this.root);
      this.mounted = true;
    }
  }

  setState(state: DimmerState): void {
    this.titleEl.textContent = state.title;
    this.subtitleEl.textContent =
      state.subtitle ??
      "Don't click anything — we're driving this page for you.";
  }

  hide(): void {
    if (this.mounted) {
      this.root.remove();
      this.mounted = false;
    }
  }

  isVisible(): boolean {
    return this.mounted;
  }
}
