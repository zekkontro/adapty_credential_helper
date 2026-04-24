// Tiny imperative overlay used by the ASC / GCP / Play Console content
// scripts. Rendered inside a shadow DOM so the host site's CSS can't leak in.

import overlayCss from "./wizard.css?inline";

const LOGO_URL =
  typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("src/assets/logo-mark.png")
    : "";

export interface Step {
  title: string;
  active?: boolean;
  done?: boolean;
}

export interface FieldChip {
  label: string;
  status: "pending" | "ok" | "error";
  value?: string;
}

export interface InputField {
  id: string;
  label: string;
  placeholder?: string;
  value?: string;
  pattern?: string;
  autocomplete?: string;
  helpText?: string;
  errorText?: string;
}

export interface OverlayState {
  title: string;
  steps: Step[];
  alert?: { kind: "info" | "error" | "success"; text: string };
  chips?: FieldChip[];
  fields?: InputField[];
  actions?: Array<{
    id: string;
    label: string;
    primary?: boolean;
    disabled?: boolean;
  }>;
}

type ActionHandler = (id: string) => void;
type InputHandler = (id: string, value: string) => void;

export interface OverlayOptions {
  // Which side of the viewport to dock on. Defaults to "left" (ASC flow);
  // GCP + Play Console use "right" so the overlay doesn't block GCP's
  // side-nav or Play Console's users table.
  align?: "left" | "right";
}

export class Overlay {
  private root: HTMLDivElement;
  private shadow: ShadowRoot;
  private container: HTMLDivElement;
  private onActionFn: ActionHandler | null = null;
  private onInputFn: InputHandler | null = null;

  constructor(options: OverlayOptions = {}) {
    this.root = document.createElement("div");
    this.root.id = "adapty-overlay-host";
    this.root.style.all = "initial";
    this.root.style.position = "fixed";
    this.root.style.zIndex = "2147483647";
    this.shadow = this.root.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = overlayCss;
    this.shadow.appendChild(style);

    this.container = document.createElement("div");
    this.container.className = "adapty-overlay-root";
    if (options.align === "right") {
      this.container.classList.add("fv-align-right");
    }
    this.shadow.appendChild(this.container);
  }

  mount(): void {
    if (!this.root.isConnected) {
      document.documentElement.appendChild(this.root);
    }
  }

  unmount(): void {
    this.root.remove();
  }

  onAction(handler: ActionHandler): void {
    this.onActionFn = handler;
  }

  onInput(handler: InputHandler): void {
    this.onInputFn = handler;
  }

  render(state: OverlayState): void {
    const activeRestore = this.snapshotFocus();

    this.container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "fv-header";

    const logo = document.createElement("img");
    logo.className = "fv-logo";
    logo.src = LOGO_URL;
    logo.alt = "Adapty Credential Helper";
    header.appendChild(logo);

    const parts = state.title.split(" · ");
    const titleWrap = document.createElement("div");
    titleWrap.style.flex = "1";
    titleWrap.style.minWidth = "0";

    const title = document.createElement("div");
    title.className = "fv-title";
    title.textContent = parts[0] ?? state.title;
    titleWrap.appendChild(title);

    if (parts.length > 1) {
      const subtitle = document.createElement("div");
      subtitle.className = "fv-subtitle";
      subtitle.textContent = parts.slice(1).join(" · ");
      titleWrap.appendChild(subtitle);
    }

    header.appendChild(titleWrap);

    const close = document.createElement("button");
    close.className = "fv-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close overlay");
    close.textContent = "×";
    close.addEventListener("click", () => {
      this.onActionFn?.("__close__");
    });
    header.appendChild(close);

    this.container.appendChild(header);

    const body = document.createElement("div");
    body.className = "fv-body";

    if (state.alert) {
      const alert = document.createElement("div");
      alert.className = `fv-alert fv-alert-${state.alert.kind}`;
      alert.textContent = state.alert.text;
      body.appendChild(alert);
    }

    for (let i = 0; i < state.steps.length; i++) {
      const step = state.steps[i]!;
      const row = document.createElement("div");
      row.className = "fv-step";
      if (step.active) row.classList.add("active");
      if (step.done) row.classList.add("done");
      const num = document.createElement("span");
      num.className = "fv-step-num";
      num.textContent = step.done ? "✓" : String(i + 1);
      const txt = document.createElement("div");
      txt.className = "fv-step-text";
      txt.innerHTML = step.title;
      row.appendChild(num);
      row.appendChild(txt);
      body.appendChild(row);
    }

    if (state.chips?.length) {
      const chipRow = document.createElement("div");
      chipRow.className = "fv-chip-row";
      for (const c of state.chips) {
        const pill = document.createElement("span");
        pill.className = `fv-pill ${c.status}`;
        pill.textContent = c.value ? `${c.label}: ${c.value}` : c.label;
        chipRow.appendChild(pill);
      }
      body.appendChild(chipRow);
    }

    if (state.fields?.length) {
      for (const f of state.fields) {
        const wrap = document.createElement("div");
        wrap.className = "fv-field";

        if (f.label) {
          const label = document.createElement("label");
          label.className = "fv-label";
          label.textContent = f.label;
          label.setAttribute("for", `fv-field-${f.id}`);
          wrap.appendChild(label);
        }

        const input = document.createElement("input");
        input.className = "fv-input";
        input.type = "text";
        input.id = `fv-field-${f.id}`;
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.autocomplete) input.autocomplete = f.autocomplete as AutoFill;
        if (f.pattern) input.pattern = f.pattern;
        if (f.value !== undefined) input.value = f.value;
        input.addEventListener("input", () => {
          this.onInputFn?.(f.id, input.value);
        });
        wrap.appendChild(input);

        if (f.errorText) {
          const err = document.createElement("div");
          err.className = "fv-dropzone-error";
          err.textContent = f.errorText;
          wrap.appendChild(err);
        } else if (f.helpText) {
          const hint = document.createElement("div");
          hint.className = "fv-subtitle";
          hint.style.marginTop = "6px";
          hint.textContent = f.helpText;
          wrap.appendChild(hint);
        }

        body.appendChild(wrap);
      }
    }

    if (state.actions?.length) {
      const row = document.createElement("div");
      row.className = "fv-row";
      for (const a of state.actions) {
        const btn = document.createElement("button");
        btn.className = "fv-btn" + (a.primary ? " fv-btn-primary" : "");
        btn.type = "button";
        btn.textContent = a.label;
        btn.disabled = !!a.disabled;
        btn.addEventListener("click", () => this.onActionFn?.(a.id));
        row.appendChild(btn);
      }
      body.appendChild(row);
    }

    this.container.appendChild(body);

    activeRestore?.();
  }

  private snapshotFocus(): (() => void) | null {
    const active = this.shadow.activeElement as HTMLInputElement | null;
    if (!active) return null;
    if (active.tagName !== "INPUT" && active.tagName !== "TEXTAREA") {
      return null;
    }
    const id = active.id;
    if (!id) return null;
    const selStart = active.selectionStart ?? null;
    const selEnd = active.selectionEnd ?? null;
    return () => {
      const next = this.shadow.getElementById(id) as HTMLInputElement | null;
      if (!next) return;
      try {
        next.focus({ preventScroll: true });
        if (selStart !== null && selEnd !== null && next.setSelectionRange) {
          next.setSelectionRange(selStart, selEnd);
        }
      } catch {
        // non-fatal — some input types reject setSelectionRange.
      }
    };
  }
}
