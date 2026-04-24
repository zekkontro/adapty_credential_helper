// DOM automation helpers for Google Cloud Console (IAM → Service Accounts).
// Angular Material components — no stable test IDs. Selector strategy:
// aria-label → button text → role+placeholder, all behind MutationObserver
// polling with a shared waitFor.

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

export function fireClick(el: HTMLElement): void {
  el.click();
  el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
  );
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

function findClickable(matches: {
  text?: string[];
  includesText?: string[];
  ariaLabel?: string[];
  ariaIncludes?: string[];
}): HTMLElement | null {
  const clickables = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a[role="button"], [role="button"], a, [role="menuitem"]'
    )
  );
  const textLc = matches.text?.map((t) => t.toLowerCase()) ?? [];
  const includesTextLc =
    matches.includesText?.map((t) => t.toLowerCase()) ?? [];
  const ariaLc = matches.ariaLabel?.map((t) => t.toLowerCase()) ?? [];
  const ariaIncludesLc =
    matches.ariaIncludes?.map((t) => t.toLowerCase()) ?? [];
  for (const el of clickables) {
    if (!visible(el)) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    if (el.getAttribute("aria-disabled") === "true") continue;
    const aria = (el.getAttribute("aria-label") ?? "").trim().toLowerCase();
    const tx = textOf(el).toLowerCase();
    if (aria && ariaLc.includes(aria)) return el;
    if (aria && ariaIncludesLc.some((s) => aria.includes(s))) return el;
    if (tx && textLc.includes(tx)) return el;
    if (tx && includesTextLc.some((s) => tx.includes(s))) return el;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL routing helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getGcpProjectId(): string | null {
  const params = new URL(location.href).searchParams;
  const p = params.get("project");
  return p && p.length > 0 ? p : null;
}

export type GcpPageKind =
  | "project_picker"
  | "sa_list"
  | "sa_create"
  | "sa_detail"
  | "sa_keys"
  | "marketplace_api"
  | "api_overview"
  | "other";

export function classifyGcpPage(url: string = location.href): GcpPageKind {
  const u = new URL(url);
  const p = u.pathname;
  if (p.includes("/projectselector2/")) return "project_picker";
  if (p.includes("/iam-admin/serviceaccounts/create")) return "sa_create";
  if (/\/iam-admin\/serviceaccounts\/details\/[^/]+\/keys/.test(p))
    return "sa_keys";
  if (/\/iam-admin\/serviceaccounts\/details\//.test(p)) return "sa_detail";
  if (/\/iam-admin\/serviceaccounts(\/|\?|$)/.test(p)) return "sa_list";
  if (/\/marketplace\/product\/google\/[^/]+/.test(p)) return "marketplace_api";
  if (/\/apis\/api\/[^/]+\/overview/.test(p)) return "api_overview";
  return "other";
}

export function getMarketplaceServiceName(
  url: string = location.href
): string | null {
  const u = new URL(url);
  const p = u.pathname;
  let m = p.match(/\/marketplace\/product\/google\/([^/?]+)/);
  if (m) return m[1] ?? null;
  m = p.match(/\/apis\/api\/([^/?]+)\/overview/);
  if (m) return m[1] ?? null;
  return null;
}

export function buildMarketplaceUrl(
  serviceName: string,
  projectId: string
): string {
  return `${location.origin}/marketplace/product/google/${encodeURIComponent(serviceName)}?project=${encodeURIComponent(projectId)}`;
}

export function buildServiceAccountsUrl(projectId: string): string {
  return `${location.origin}/iam-admin/serviceaccounts?project=${encodeURIComponent(projectId)}&supportedpurview=project`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Play APIs enable check (GCP marketplace)
// ─────────────────────────────────────────────────────────────────────────────

export const REQUIRED_PLAY_APIS: readonly string[] = [
  "androidpublisher.googleapis.com",
  "playdeveloperreporting.googleapis.com",
];

function findEnableApiButton(): HTMLButtonElement | null {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="enable this API"], button[aria-label*="enable this api" i]'
    )
  );
  for (const b of buttons) {
    if (!visible(b)) continue;
    if (b.disabled) continue;
    if (b.getAttribute("aria-disabled") === "true") continue;
    return b;
  }
  return null;
}

function findAlreadyEnabledSignal(): HTMLElement | null {
  const ariaHits = document.querySelectorAll<HTMLButtonElement>(
    'button[aria-label*="manage this api" i],' +
      'button[aria-label*="manage api" i],' +
      'button[aria-label*="disable api" i],' +
      'button[aria-label*="disable this api" i]'
  );
  for (const el of Array.from(ariaHits)) {
    if (visible(el) && !el.disabled) return el;
  }
  const banner = document.querySelector<HTMLElement>(
    "mp-product-details-banner, cfc-product-header, mp-product-details-cta-button-container"
  );
  if (!banner) return null;
  const nodes = Array.from(
    banner.querySelectorAll<HTMLElement>(
      "button, a[role='button'], [role='status'], mat-chip, span"
    )
  );
  for (const el of nodes) {
    if (!visible(el)) continue;
    const tx = textOf(el).toLowerCase();
    if (
      tx === "manage" ||
      tx === "disable" ||
      tx === "api enabled" ||
      tx === "api is enabled" ||
      tx.includes("already enabled")
    ) {
      return el;
    }
  }
  return null;
}

export function isApiAlreadyEnabled(): boolean {
  if (classifyGcpPage() === "api_overview") return true;
  if (findEnableApiButton()) return false;
  if (findAlreadyEnabledSignal()) return true;
  return false;
}

export async function clickEnableApiButton(): Promise<void> {
  const btn = await waitFor<HTMLButtonElement>(
    () => findEnableApiButton(),
    { step: "find:enable_api_button", timeoutMs: 10_000 }
  );
  try {
    btn.scrollIntoView({ block: "center", inline: "center" });
  } catch {
    // non-fatal
  }
  await sleep(150);
  dispatchFullClick(btn);
}

// ─────────────────────────────────────────────────────────────────────────────
// SA list page
// ─────────────────────────────────────────────────────────────────────────────

export async function clickCreateServiceAccountToolbarButton(): Promise<void> {
  const btn = await waitFor(
    () =>
      findClickable({
        ariaLabel: ["create service account"],
        ariaIncludes: ["create service account"],
        text: ["create service account"],
        includesText: ["create service account"],
      }),
    { step: "find:create_sa_toolbar_button" }
  );
  fireClick(btn);
}

export function snapshotServiceAccountEmails(): Set<string> {
  const emails = new Set<string>();
  const text = document.body?.innerText || "";
  const matches = text.match(
    /[A-Za-z0-9_.+-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/g
  );
  if (matches) for (const m of matches) emails.add(m);
  return emails;
}

export async function waitForNewServiceAccount(
  before: Set<string>,
  opts: { timeoutMs?: number } = {}
): Promise<string> {
  return await waitFor<string>(
    () => {
      const cur = snapshotServiceAccountEmails();
      for (const e of cur) if (!before.has(e)) return e;
      return null;
    },
    { step: "scan:new_sa_email", timeoutMs: opts.timeoutMs ?? 12_000 }
  );
}

export async function clickServiceAccountRowByEmail(
  email: string
): Promise<void> {
  const link = await waitFor<HTMLElement>(
    () => {
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
      const needle = email.toLowerCase();
      for (const a of anchors) {
        if (!visible(a)) continue;
        const tx = textOf(a).toLowerCase();
        if (tx === needle || tx.includes(needle)) return a;
      }
      return null;
    },
    { step: "find:sa_row_link", timeoutMs: 10_000 }
  );
  fireClick(link);
}

// ─────────────────────────────────────────────────────────────────────────────
// SA create page
// ─────────────────────────────────────────────────────────────────────────────

async function findServiceAccountNameInput(): Promise<HTMLInputElement> {
  return await waitFor<HTMLInputElement>(
    () => {
      const byFc = document.querySelector<HTMLInputElement>(
        'input[formcontrolname="displayName"]'
      );
      if (byFc && visible(byFc)) return byFc;

      const fields = Array.from(
        document.querySelectorAll<HTMLElement>("mat-form-field, .mat-mdc-form-field")
      );
      for (const field of fields) {
        const label = (field.innerText || "").toLowerCase();
        if (
          label.includes("service account name") ||
          label.startsWith("name")
        ) {
          const input = field.querySelector<HTMLInputElement>("input");
          if (input && visible(input)) return input;
        }
      }
      return null;
    },
    { step: "find:sa_name_input", timeoutMs: 8000 }
  );
}

export async function fillServiceAccountForm(name: string): Promise<void> {
  const input = await findServiceAccountNameInput();
  input.focus();
  setReactInputValue(input, name);
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

export async function clickCreateAndContinue(): Promise<void> {
  const btn = await waitFor(
    () =>
      findClickable({
        text: ["create and continue", "create"],
        includesText: ["create and continue"],
        ariaLabel: ["create and continue"],
        ariaIncludes: ["create and continue"],
      }),
    { step: "find:create_and_continue", timeoutMs: 10_000 }
  );
  fireClick(btn);
}

export async function clickDone(): Promise<void> {
  const btn = await waitFor<HTMLElement>(
    () => {
      // Primary target: the form's submit button inside the stepper's
      // bottom buttons container. That's the actual "Done" on the Create
      // Service Account panel — scoped selector avoids mis-matching other
      // "Done" buttons elsewhere on the page.
      const container = document.querySelector<HTMLElement>(
        ".cfc-stepper-buttons-container"
      );
      if (container) {
        const submitBtn = Array.from(
          container.querySelectorAll<HTMLButtonElement>(
            "button[type='submit']"
          )
        ).find(
          (b) =>
            visible(b) &&
            !b.disabled &&
            b.getAttribute("aria-disabled") !== "true"
        );
        if (submitBtn) return submitBtn;

        // Fallback inside the container — any visible button whose label
        // text is "Done".
        const byText = Array.from(
          container.querySelectorAll<HTMLButtonElement>("button")
        ).find((b) => {
          if (!visible(b) || b.disabled) return false;
          if (b.getAttribute("aria-disabled") === "true") return false;
          return textOf(b).toLowerCase() === "done";
        });
        if (byText) return byText;
      }

      // Document-wide fallback.
      return findClickable({
        text: ["done"],
        ariaLabel: ["done"],
      });
    },
    { step: "find:done_button", timeoutMs: 15_000 }
  );

  // The Done button often sits below the fold inside a scrollable side
  // panel — bring it into view before clicking so pointer events land on
  // a fully-rendered target.
  try {
    btn.scrollIntoView({ block: "center", inline: "center" });
  } catch {
    // non-fatal
  }
  await sleep(200);

  // Use the full pointer cycle — Material's ripple + form-submit
  // directive occasionally ignore a bare `.click()` on a type="submit"
  // button, which is why the previous flow stalled at step 3.
  dispatchFullClick(btn);

  // Belt-and-braces: if clicking didn't trigger the submit (Angular
  // form-level validator quirks), call requestSubmit on the enclosing
  // form directly.
  await sleep(400);
  const form = btn.closest("form") as HTMLFormElement | null;
  if (form && typeof form.requestSubmit === "function") {
    try {
      form.requestSubmit(btn as HTMLButtonElement);
    } catch {
      // non-fatal
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SA detail / Keys tab
// ─────────────────────────────────────────────────────────────────────────────

export async function clickKeysTab(): Promise<void> {
  const tab = await waitFor(
    () => {
      const tabLinks = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[role="tab"], div[role="tab"], a.mat-mdc-tab-link, a[mat-tab-link]'
        )
      );
      for (const t of tabLinks) {
        if (!visible(t)) continue;
        const tx = textOf(t).toLowerCase();
        if (tx === "keys" || tx.startsWith("keys")) return t;
      }
      return findClickable({ text: ["keys"] });
    },
    { step: "find:keys_tab", timeoutMs: 10_000 }
  );
  fireClick(tab);
}

function isAddKeyMenuOpen(btn: HTMLElement): boolean {
  if (btn.getAttribute("aria-expanded") === "true") return true;
  const items = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".cdk-overlay-container [role='menuitem'], [role='menu'] [role='menuitem'], mat-menu-content [role='menuitem'], .mat-mdc-menu-content [role='menuitem']"
    )
  );
  for (const el of items) {
    if (!visible(el)) continue;
    const tx = (el.innerText || el.textContent || "").toLowerCase();
    if (tx.includes("create new key")) return true;
  }
  return false;
}

async function waitForMenuOpen(
  btn: HTMLElement,
  timeoutMs: number
): Promise<boolean> {
  try {
    await waitFor(() => (isAddKeyMenuOpen(btn) ? true : null), {
      step: "watch:add_key_menu_open",
      timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

export async function openAddKeyMenu(): Promise<void> {
  const L = "[adapty/gcp openAddKeyMenu]";
  const btn = await waitFor<HTMLButtonElement>(
    () => {
      const byAttr = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Add key"], button[cfcmenubutton]'
      );
      if (byAttr && visible(byAttr) && !byAttr.disabled) return byAttr;
      const fallback = findClickable({
        text: ["add key"],
        ariaLabel: ["add key"],
        ariaIncludes: ["add key"],
        includesText: ["add key"],
      });
      return (fallback as HTMLButtonElement | null) ?? null;
    },
    { step: "find:add_key_button", timeoutMs: 12_000 }
  );
  console.log(L, "found Add Key button", btn);

  if (isAddKeyMenuOpen(btn)) {
    console.log(L, "menu already open");
    return;
  }

  const strategies: Array<{ name: string; run: () => void | Promise<void> }> =
    [
      {
        name: "native_click",
        run: () => {
          btn.focus({ preventScroll: true });
          btn.click();
        },
      },
      {
        name: "full_click",
        run: () => {
          dispatchFullClick(btn);
        },
      },
      {
        name: "pointerdown_only",
        run: () => {
          const rect = btn.getBoundingClientRect();
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
            btn.dispatchEvent(
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
          btn.dispatchEvent(new MouseEvent("mousedown", base));
          window.setTimeout(() => {
            try {
              btn.dispatchEvent(
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
            btn.dispatchEvent(
              new MouseEvent("mouseup", { ...base, buttons: 0 })
            );
          }, 60);
        },
      },
    ];

  for (const s of strategies) {
    console.log(L, `trying strategy: ${s.name}`);
    await s.run();
    const opened = await waitForMenuOpen(btn, 1500);
    if (opened) {
      console.log(L, `${s.name} opened the menu`);
      return;
    }
    console.log(L, `${s.name} did not open the menu, retrying`);
    await new Promise((r) => setTimeout(r, 300));
  }

  for (let i = 0; i < 3; i++) {
    console.log(L, `fallback native_click retry #${i + 1}`);
    btn.focus({ preventScroll: true });
    btn.click();
    const opened = await waitForMenuOpen(btn, 2000);
    if (opened) return;
  }

  throw new AutomationStepError(
    "open:add_key_menu",
    "Add Key menu never opened (aria-expanded stayed false)"
  );
}

export async function clickCreateNewKeyMenuItem(): Promise<void> {
  const item = await waitFor(
    () => {
      const overlays = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".cdk-overlay-container [role='menuitem'], [role='menu'] [role='menuitem'], mat-menu-content [role='menuitem'], .mat-mdc-menu-content [role='menuitem']"
        )
      );
      for (const el of overlays) {
        if (!visible(el)) continue;
        const tx = textOf(el).toLowerCase();
        if (tx === "create new key" || tx.includes("create new key")) {
          return el;
        }
      }
      return findClickable({
        text: ["create new key"],
        includesText: ["create new key"],
      });
    },
    { step: "find:create_new_key_menuitem", timeoutMs: 10_000 }
  );
  dispatchFullClick(item);
}

export async function selectJsonRadio(): Promise<void> {
  await waitFor(
    () => {
      const dialog = document.querySelector<HTMLElement>(
        "cfc-create-service-account-key-dialog, .mat-mdc-dialog-container"
      );
      const scope = dialog || document;
      const radios = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'input[type="radio"], mat-radio-button, [role="radio"]'
        )
      );
      for (const r of radios) {
        if (!visible(r)) continue;
        const wrapper =
          r.closest<HTMLElement>("mat-radio-button, label") || r.parentElement;
        const tx = (wrapper?.textContent || "").toLowerCase();
        if (tx.includes("json")) {
          const target =
            r.closest<HTMLElement>("mat-radio-button, label") ||
            (r as HTMLElement);
          dispatchFullClick(target);
          return true;
        }
      }
      return null;
    },
    { step: "select:json_radio", timeoutMs: 8000 }
  );
}

export async function clickCreateKeyButton(): Promise<void> {
  const btn = await waitFor(
    () => {
      const dialog = document.querySelector<HTMLElement>(
        "cfc-create-service-account-key-dialog, .mat-mdc-dialog-container, [role='dialog']"
      );
      if (!dialog) return null;
      const clickables = Array.from(
        dialog.querySelectorAll<HTMLElement>("button, [role='button']")
      );
      for (const el of clickables) {
        if (!visible(el)) continue;
        if ((el as HTMLButtonElement).disabled) continue;
        if (el.getAttribute("aria-disabled") === "true") continue;
        const tx = textOf(el).toLowerCase();
        if (tx === "create") return el;
      }
      return null;
    },
    { step: "find:create_key_submit", timeoutMs: 10_000 }
  );
  dispatchFullClick(btn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration progress events
// ─────────────────────────────────────────────────────────────────────────────

export type GcpProgressStep =
  | "await_project"
  | "check_api"
  | "enabling_api"
  | "return_to_sa"
  | "open_create_form"
  | "fill_sa_form"
  | "submit_create"
  | "select_role"
  | "advance_step2"
  | "skip_optional_steps"
  | "open_sa_detail"
  | "open_keys_tab"
  | "open_add_key_menu"
  | "select_json"
  | "submit_create_key";

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Permissions: select Play Store service-account roles
// ("Pub/Sub Admin" + "Monitoring Viewer")
// ─────────────────────────────────────────────────────────────────────────────

// Open the role combobox. Always picks the LAST visible trigger inside the
// permissions step so the same helper works for the initial role selection
// AND any subsequent "Add another role" rows (the new row is appended at
// the bottom and is the only one without a chosen role yet).
export async function openRoleCombobox(): Promise<void> {
  const trigger = await waitFor<HTMLElement>(
    () => {
      const step = document.querySelector<HTMLElement>(
        "cfc-stepper-step[formgroupname='projectPermissions']"
      );
      const scope = step || document;
      const triggers = Array.from(
        scope.querySelectorAll<HTMLElement>(
          "cfc-select-dual-column .cfc-select-trigger"
        )
      ).filter((el) => visible(el));
      if (triggers.length > 0) return triggers[triggers.length - 1]!;
      const host = scope.querySelector<HTMLElement>(
        "cfc-select-dual-column[role='combobox']"
      );
      if (host && visible(host)) return host;
      return null;
    },
    { step: "find:role_combobox", timeoutMs: 10_000 }
  );
  fireClick(trigger);
}

// GCP's role picker is a dual-column listbox:
//   • .cfc-select-dual-column-left  — categories (Basic, Pub/Sub, Monitoring, …)
//   • .cfc-select-dual-column-right — roles inside the selected category
// A role option's primary text is the role name (e.g. "Pub/Sub Admin"). Options
// in the left column carry the class `cfc-select-dual-column-category` — we
// filter those out when looking for a role, so we never click a category by
// accident when searching "Pub/Sub Admin" (left column shows "Pub/Sub" too).

// Locate the picker's search input. The live HTML shows a bare <input>
// without a type attribute and role="combobox" inside <cfc-select-filter>,
// so the old selector `input[type='text']` silently missed it.
function findRolePickerSearchInput(): HTMLInputElement | null {
  const filter = document.querySelector<HTMLElement>(
    ".cdk-overlay-container cfc-select-filter, cfc-select-filter"
  );
  const inFilter = filter?.querySelector<HTMLInputElement>("input");
  if (inFilter && visible(inFilter)) return inFilter;

  // Fallback: any overlay input with a role-picker-style placeholder.
  const candidates = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      ".cdk-overlay-container input"
    )
  ).filter((el) => visible(el));
  for (const c of candidates) {
    const ph = (c.getAttribute("placeholder") ?? "").toLowerCase();
    if (
      ph.includes("role") ||
      ph.includes("permission") ||
      ph.includes("service")
    ) {
      return c;
    }
  }
  return null;
}

// Find a role in the RIGHT column (never a category from the left column).
function findRoleOptionInRightColumn(roleName: string): HTMLElement | null {
  const needle = roleName.toLowerCase();
  const rightCol = document.querySelector<HTMLElement>(
    ".cdk-overlay-container .cfc-select-dual-column-right"
  );
  const scopes: (Document | HTMLElement)[] = rightCol
    ? [rightCol]
    : Array.from(
        document.querySelectorAll<HTMLElement>(".cdk-overlay-container")
      );
  if (scopes.length === 0) scopes.push(document);

  for (const scope of scopes) {
    const options = Array.from(
      scope.querySelectorAll<HTMLElement>(
        "[role='option'], mat-option"
      )
    ).filter((el) => {
      if (!visible(el)) return false;
      if (el.classList.contains("cfc-select-dual-column-category")) return false;
      return true;
    });

    // Exact match on the option's primary (first-line) text.
    for (const el of options) {
      const primary =
        el.querySelector<HTMLElement>(".mdc-list-item__primary-text") ?? el;
      const tx = (primary.innerText || primary.textContent || "")
        .trim()
        .toLowerCase();
      if (tx === needle) return el;
    }
    // Looser: role name appears as a prefix of the full option text (some
    // options render role ID like "roles/pubsub.admin" as secondary text).
    for (const el of options) {
      const tx = (el.innerText || "").trim().toLowerCase();
      if (tx === needle) return el;
      if (tx.startsWith(needle + " ") || tx.startsWith(needle + "\n"))
        return el;
    }
  }
  return null;
}

// Find a category option in the LEFT column.
function findCategoryByName(categoryName: string): HTMLElement | null {
  const needle = categoryName.toLowerCase();
  const leftCol = document.querySelector<HTMLElement>(
    ".cdk-overlay-container .cfc-select-dual-column-left"
  );
  const scope: Document | HTMLElement = leftCol ?? document;
  const categories = Array.from(
    scope.querySelectorAll<HTMLElement>(
      ".cfc-select-dual-column-category, [role='option']"
    )
  ).filter((el) => visible(el));

  for (const el of categories) {
    const primary =
      el.querySelector<HTMLElement>(".mdc-list-item__primary-text") ?? el;
    const tx = (primary.innerText || primary.textContent || "")
      .trim()
      .toLowerCase();
    if (tx === needle) return el;
  }
  for (const el of categories) {
    const tx = (el.innerText || "").trim().toLowerCase();
    if (tx.startsWith(needle)) return el;
  }
  return null;
}

// Select a single role by name. Strategy:
//   1) Type the full role name into the picker's search filter and click
//      the filtered right-column option.
//   2) If search fails (or the search input isn't found), clear the search,
//      click the category in the left column, then click the role in the
//      right column. Category-nav matches the behavior that worked
//      previously for Basic → Editor.
//
// Pass `category` for any role whose category name isn't the leading
// segment of the role name (e.g. "Editor" lives under "Basic"). For the
// Play Store flow we always pass it explicitly to be safe.
export async function selectRoleByName(
  roleName: string,
  category?: string
): Promise<void> {
  // Strategy 1: search.
  const searchInput = findRolePickerSearchInput();
  if (searchInput) {
    searchInput.focus();
    setReactInputValue(searchInput, roleName);
    // Let the virtualised listbox filter before we start polling.
    await sleep(500);
    try {
      const hit = await waitFor<HTMLElement>(
        () => findRoleOptionInRightColumn(roleName),
        { step: `find:role_${roleName}_via_search`, timeoutMs: 6000 }
      );
      dispatchFullClick(hit);
      return;
    } catch {
      // Fall through to category navigation.
    }
    // Clear the search so category navigation sees the full list again.
    setReactInputValue(searchInput, "");
    await sleep(400);
  }

  // Strategy 2: category navigation.
  if (!category) {
    throw new AutomationStepError(
      `select:role_${roleName}`,
      `Search didn't find "${roleName}" and no category fallback was provided.`
    );
  }
  const catEl = await waitFor<HTMLElement>(
    () => findCategoryByName(category),
    { step: `find:category_${category}`, timeoutMs: 8000 }
  );
  dispatchFullClick(catEl);
  await sleep(500);

  const roleEl = await waitFor<HTMLElement>(
    () => findRoleOptionInRightColumn(roleName),
    { step: `find:role_${roleName}`, timeoutMs: 8000 }
  );
  dispatchFullClick(roleEl);
}

// Click the "+ ADD ANOTHER ROLE" button inside the Permissions step.
export async function clickAddAnotherRole(): Promise<void> {
  const btn = await waitFor<HTMLElement>(
    () => {
      const step = document.querySelector<HTMLElement>(
        "cfc-stepper-step[formgroupname='projectPermissions']"
      );
      const scope = step || document;
      const buttons = Array.from(
        scope.querySelectorAll<HTMLElement>(
          "button, a[role='button'], [role='button']"
        )
      );
      for (const b of buttons) {
        if (!visible(b)) continue;
        if ((b as HTMLButtonElement).disabled) continue;
        const tx = textOf(b).toLowerCase();
        if (tx === "add another role" || tx.includes("add another role")) {
          return b;
        }
      }
      return null;
    },
    { step: "find:add_another_role", timeoutMs: 8000 }
  );
  fireClick(btn);
}

// Entry point for the Play Store flow's permission step. Adds the two roles
// Adapty's backend needs on the service account:
//   • Pub/Sub Admin    — receive real-time subscription events
//   • Monitoring Viewer — read alerting / reporting metrics
//
// Each role is paired with its category so selectRoleByName can fall back
// to left-column → right-column navigation when GCP's search filter
// doesn't engage (observed in the current DOM where the search input has
// no `type` attribute, breaking older selectors).
export async function selectPlayStoreRoles(): Promise<void> {
  const ROLES: Array<{ name: string; category: string }> = [
    { name: "Pub/Sub Admin", category: "Pub/Sub" },
    { name: "Monitoring Viewer", category: "Monitoring" },
  ];

  for (let i = 0; i < ROLES.length; i++) {
    if (i > 0) {
      await clickAddAnotherRole();
      await sleep(800);
    }
    await openRoleCombobox();
    await sleep(600);
    await selectRoleByName(ROLES[i]!.name, ROLES[i]!.category);
    await sleep(800);
  }
}

export async function clickStep2Continue(): Promise<void> {
  const btn = await waitFor<HTMLElement>(
    () => {
      const step = document.querySelector<HTMLElement>(
        "cfc-stepper-step[formgroupname='projectPermissions']"
      );
      if (!step) return null;
      const candidate = step.querySelector<HTMLElement>(
        "button.cfc-stepper-step-continue-button"
      );
      if (candidate && visible(candidate)) return candidate;
      const buttons = Array.from(step.querySelectorAll<HTMLElement>("button"));
      for (const b of buttons) {
        if (!visible(b)) continue;
        const tx = textOf(b).toLowerCase();
        if (tx === "continue") return b;
      }
      return null;
    },
    { step: "find:step2_continue", timeoutMs: 8000 }
  );
  fireClick(btn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Project picker highlight
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_HIGHLIGHT_STYLE_ID = "adapty-gcp-project-highlight-style";

function ensureProjectHighlightStyle(): void {
  if (document.getElementById(PROJECT_HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PROJECT_HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .adapty-project-highlight {
      outline: 3px solid #7018FF !important;
      outline-offset: 4px !important;
      border-radius: 12px !important;
      position: relative !important;
      z-index: 5 !important;
      animation: adapty-project-pulse 1.6s ease-in-out infinite;
    }
    @keyframes adapty-project-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(112, 24, 255, 0.6); }
      50%      { box-shadow: 0 0 0 12px rgba(112, 24, 255, 0); }
    }
  `;
  document.head.appendChild(style);
}

export function highlightProjectPicker(): () => void {
  ensureProjectHighlightStyle();

  const cards = Array.from(
    document.querySelectorAll<HTMLElement>(
      "cfc-resource-card mat-card, cfc-resource-card"
    )
  ).filter((el) => visible(el));

  const added: HTMLElement[] = [];
  if (cards.length > 0) {
    for (const c of cards) {
      c.classList.add("adapty-project-highlight");
      added.push(c);
    }
  } else {
    const createBtn =
      document.querySelector<HTMLElement>(
        "button.projectselector-project-create"
      ) ||
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => textOf(b).toLowerCase() === "create project"
      ) ||
      null;
    if (createBtn) {
      createBtn.classList.add("adapty-project-highlight");
      added.push(createBtn);
    }
  }

  return () => {
    for (const el of added) el.classList.remove("adapty-project-highlight");
  };
}
