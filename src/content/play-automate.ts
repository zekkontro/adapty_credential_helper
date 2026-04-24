// Play Console DOM automation helpers. Angular Material + Play Console's
// own web-components; selectors rely on stable `debug-id` attributes
// wherever they exist (permission checkboxes, email input), and on
// aria-label / text fallbacks elsewhere.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AutomationStepError extends Error {
  constructor(
    public readonly step: string,
    public readonly reason: string
  ) {
    super(`${step}: ${reason}`);
    this.name = "AutomationStepError";
  }
}

export async function waitFor<T>(
  fn: () => T | null | undefined | false,
  opts: { step: string; timeoutMs?: number; pollMs?: number } = {
    step: "waitFor",
  }
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const pollMs = opts.pollMs ?? 150;
  const started = Date.now();
  const first = fn();
  if (first) return first as T;
  return await new Promise<T>((resolve, reject) => {
    const id = window.setInterval(() => {
      try {
        const v = fn();
        if (v) {
          window.clearInterval(id);
          resolve(v as T);
          return;
        }
      } catch (err) {
        window.clearInterval(id);
        reject(
          new AutomationStepError(
            opts.step,
            err instanceof Error ? err.message : String(err)
          )
        );
        return;
      }
      if (Date.now() - started > timeoutMs) {
        window.clearInterval(id);
        reject(
          new AutomationStepError(opts.step, `timed out after ${timeoutMs}ms`)
        );
      }
    }, pollMs);
  });
}

function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
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

export function dispatchFullClick(el: HTMLElement): void {
  try {
    el.focus({ preventScroll: true });
  } catch {
    // non-fatal
  }
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
  };
  try {
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      })
    );
  } catch {
    // non-fatal
  }
  el.dispatchEvent(new MouseEvent("mousedown", base));
  try {
    el.dispatchEvent(
      new PointerEvent("pointerup", {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 0,
      })
    );
  } catch {
    // non-fatal
  }
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
  el.click();
  el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
}

export function setReactInputValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ─────────────────────────────────────────────────────────────────────────────
// URL routing — Play Console replaces the developer-id `_` placeholder with
// the real numeric id after the user picks an account.
// ─────────────────────────────────────────────────────────────────────────────

export type PlayPageKind =
  | "account_picker"
  | "app_list"
  | "users_permissions_list"
  | "invite_user"
  | "developer_home"
  | "other";

const DEV_ID_RE = /\/developers\/([^/]+)(?:\/|$)/;

export function getDeveloperId(url: string = location.href): string | null {
  const m = new URL(url).pathname.match(DEV_ID_RE);
  if (!m) return null;
  const id = m[1];
  if (!id || id === "_") return null;
  return id;
}

export function classifyPlayPage(url: string = location.href): PlayPageKind {
  const parsed = new URL(url);
  const p = parsed.pathname;
  const devId = getDeveloperId(url);
  if (p.includes("/developers/_/")) return "account_picker";
  if (/\/users-and-permissions\/invite($|\/)/.test(p)) return "invite_user";
  if (/\/users-and-permissions($|\/)/.test(p)) return "users_permissions_list";
  if (/\/app-list($|\/)/.test(p)) return "app_list";
  if (devId && /\/console\/u\/\d+\/developers\//.test(p)) {
    return "developer_home";
  }
  return "other";
}

export function buildUsersInviteUrl(devId: string): string {
  return `${location.origin}/console/u/0/developers/${devId}/users-and-permissions/invite`;
}

export function buildUsersListUrl(devId: string): string {
  return `${location.origin}/console/u/0/developers/${devId}/users-and-permissions`;
}

export function buildAppListUrl(devId: string): string {
  return `${location.origin}/console/u/0/developers/${devId}/app-list`;
}

export function navigateTo(url: string): void {
  if (location.href !== url) {
    location.href = url;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invite form automation
// ─────────────────────────────────────────────────────────────────────────────

async function findEmailInput(): Promise<HTMLInputElement> {
  return await waitFor<HTMLInputElement>(
    () => {
      const mat = document.querySelector<HTMLElement>(
        'material-input[debug-id="email-input"]'
      );
      const inner = mat?.querySelector<HTMLInputElement>(
        'input[type="email"], input.mdc-text-field__input'
      );
      if (inner && visible(inner)) return inner;

      const generic = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="email"]')
      ).find((el) => visible(el));
      return generic ?? null;
    },
    { step: "find:invite_email_input", timeoutMs: 12_000 }
  );
}

export async function fillInviteEmail(email: string): Promise<void> {
  const input = await findEmailInput();
  input.focus();
  setReactInputValue(input, email);
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

export async function clickAccountPermissionsTab(): Promise<void> {
  await waitFor(
    () => {
      const tabs = Array.from(
        document.querySelectorAll<HTMLElement>(
          'tab-button[role="tab"], [role="tab"]'
        )
      );
      for (const t of tabs) {
        if (!visible(t)) continue;
        const aria = (t.getAttribute("aria-label") ?? "").toLowerCase();
        const tx = textOf(t).toLowerCase();
        const matches =
          aria === "hesap izinleri" ||
          aria === "account permissions" ||
          tx === "hesap izinleri" ||
          tx === "account permissions";
        if (!matches) continue;
        if (t.getAttribute("aria-selected") === "true") return true;
        dispatchFullClick(t);
        return true;
      }
      return null;
    },
    { step: "click:account_permissions_tab", timeoutMs: 10_000 }
  );
}

export async function tickPermissionByDebugId(
  debugId: string
): Promise<void> {
  const host = await waitFor<HTMLElement>(
    () => {
      const el = document.querySelector<HTMLElement>(
        `material-checkbox[debug-id="${debugId}"]`
      );
      if (!el) return null;
      if (!visible(el)) {
        try {
          el.scrollIntoView({ block: "center" });
        } catch {
          // non-fatal
        }
        return null;
      }
      return el;
    },
    { step: `find:permission_${debugId}`, timeoutMs: 10_000 }
  );

  const nativeInput = host.querySelector<HTMLInputElement>(
    "input.mdc-checkbox__native-control, input[type='checkbox']"
  );
  const mdcWrapper = host.querySelector<HTMLElement>(".mdc-checkbox");

  const isChecked = (): boolean => {
    if (nativeInput?.checked) return true;
    if (host.getAttribute("aria-checked") === "true") return true;
    if (host.classList.contains("mdc-checkbox--selected")) return true;
    if (host.classList.contains("mdc-checkbox--checked")) return true;
    if (mdcWrapper?.classList.contains("mdc-checkbox--selected")) return true;
    return false;
  };

  if (isChecked()) return;

  if (nativeInput) {
    try {
      nativeInput.focus({ preventScroll: true });
    } catch {
      // non-fatal
    }
    nativeInput.click();
    await sleep(120);
    if (isChecked()) return;
  }

  if (mdcWrapper) {
    dispatchFullClick(mdcWrapper);
    await sleep(120);
    if (isChecked()) return;
  }

  dispatchFullClick(host);
}

export async function clickInviteSubmit(): Promise<void> {
  const btn = await waitFor<HTMLElement>(
    () => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, a[role='button'], [role='button']"
        )
      );
      const invitePhrases = [
        "kullanıcıyı davet et",
        "kullanıcı davet et",
        "davet et",
        "invite user",
        "invite users",
        "send invitation",
        "send invite",
      ];
      for (const el of buttons) {
        if (!visible(el)) continue;
        if ((el as HTMLButtonElement).disabled) continue;
        if (el.getAttribute("aria-disabled") === "true") continue;
        const tx = textOf(el).toLowerCase();
        const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
        if (invitePhrases.includes(tx)) return el;
        if (invitePhrases.some((p) => aria === p || aria.includes(p)))
          return el;
      }
      return null;
    },
    { step: "find:invite_submit", timeoutMs: 12_000 }
  );
  dispatchFullClick(btn);
}

export async function clickInviteConfirmButton(): Promise<void> {
  const btn = await waitFor<HTMLElement>(
    () => {
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          "material-dialog, [role='dialog']"
        )
      ).filter(visible);
      const scopes: (Document | HTMLElement)[] = dialogs.length
        ? dialogs
        : [document];

      const confirmPhrases = [
        "davetiye gönder",
        "davet et",
        "gönder",
        "send invitation",
        "send invite",
        "send",
        "invite",
        "yes",
        "evet",
      ];

      for (const scope of scopes) {
        const byDebugId = scope.querySelector<HTMLElement>(
          'button[debug-id="yes-button"]'
        );
        if (byDebugId && visible(byDebugId) && !(byDebugId as HTMLButtonElement).disabled) {
          return byDebugId;
        }
        const byClass = scope.querySelector<HTMLElement>(
          "button.yes-button"
        );
        if (byClass && visible(byClass) && !(byClass as HTMLButtonElement).disabled) {
          return byClass;
        }
        const buttons = Array.from(
          scope.querySelectorAll<HTMLElement>(
            "button, [role='button']"
          )
        );
        for (const el of buttons) {
          if (!visible(el)) continue;
          if ((el as HTMLButtonElement).disabled) continue;
          if (el.getAttribute("aria-disabled") === "true") continue;
          const debugId = (el.getAttribute("debug-id") ?? "").toLowerCase();
          if (debugId === "no-button" || debugId === "close-icon-button") {
            continue;
          }
          if (el.classList.contains("no-button")) continue;
          const tx = textOf(el).toLowerCase();
          const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
          if (tx === "iptal" || tx === "cancel" || tx === "kapat") continue;
          if (confirmPhrases.some((p) => tx === p || tx.includes(p))) {
            return el;
          }
          if (aria && confirmPhrases.some((p) => aria === p || aria.includes(p))) {
            return el;
          }
        }
      }
      return null;
    },
    { step: "find:invite_confirm", timeoutMs: 8000 }
  );
  dispatchFullClick(btn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Invite-sent observer
// ─────────────────────────────────────────────────────────────────────────────

export async function waitForInviteSent(): Promise<void> {
  await waitFor(
    () => {
      if (classifyPlayPage() === "users_permissions_list") return true;
      const toasts = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role='status'], material-snackbar, snack-bar, .snackbar"
        )
      );
      for (const t of toasts) {
        const tx = textOf(t).toLowerCase();
        if (tx.includes("invit") || tx.includes("davet")) return true;
      }
      return null;
    },
    { step: "watch:invite_sent", timeoutMs: 180_000 }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Package-name scrape from Play Console app list
// ─────────────────────────────────────────────────────────────────────────────

const PACKAGE_NAME_RE_G =
  /\b([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\b/g;

// Extract candidate package names currently visible on the app-list page.
// Filters out obvious non-package strings like file extensions and URLs.
export function snapshotAppPackageNames(): string[] {
  const text = document.body?.innerText || "";
  const found = new Set<string>();
  const matches = text.match(PACKAGE_NAME_RE_G);
  if (!matches) return [];
  for (const m of matches) {
    // Skip single-dotted strings (like "foo.png") that are probably filenames.
    if (!/\./.test(m.slice(1))) continue;
    // Must have at least 2 segments, preferably 3 (true reverse-DNS).
    if (m.split(".").length < 2) continue;
    // Skip common noise.
    if (/(google|play|gstatic|gvt1|youtube|adwords|admob)\.com/.test(m)) continue;
    if (/\.(com|net|org|io|app|dev)$/.test(m) && m.split(".").length === 2) {
      // Skip bare 2-segment domains ("example.com") — unlikely to be a package.
      continue;
    }
    found.add(m);
  }
  return [...found];
}

// ─────────────────────────────────────────────────────────────────────────────
// Highlight helper (used only as a soft assist if automation stalls)
// ─────────────────────────────────────────────────────────────────────────────

const HIGHLIGHT_STYLE_ID = "adapty-play-highlight-style";

function ensureHighlightStyle(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .adapty-play-highlight {
      outline: 3px solid #7018FF !important;
      outline-offset: 4px !important;
      border-radius: 10px !important;
      position: relative !important;
      z-index: 5 !important;
      animation: adapty-play-pulse 1.6s ease-in-out infinite;
    }
    @keyframes adapty-play-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(112, 24, 255, 0.6); }
      50%      { box-shadow: 0 0 0 12px rgba(112, 24, 255, 0); }
    }
  `;
  document.head.appendChild(style);
}

export type CleanupFn = () => void;

export function highlightAccountPickerCards(): CleanupFn {
  ensureHighlightStyle();
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".cfc-resource-card, .developer-card, [role='link'][href*='/developers/']"
    )
  ).filter(visible);
  const added: HTMLElement[] = [];
  for (const c of cards) {
    c.classList.add("adapty-play-highlight");
    added.push(c);
  }
  return () => {
    for (const el of added) el.classList.remove("adapty-play-highlight");
  };
}
