// DOM automation helpers for App Store Connect's Keys page.
// All selector strategies use multiple fallbacks because Apple does not
// publish test IDs; tolerate copy changes and minor DOM shape drift.

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export class AutomationStepError extends Error {
  constructor(
    public readonly step: string,
    public readonly reason: string
  ) {
    super(`${step}: ${reason}`);
    this.name = "AutomationStepError";
  }
}

// Polls a predicate until it returns truthy or timeoutMs elapses.
export async function waitFor<T>(
  fn: () => T | null | undefined | false,
  opts: { step: string; timeoutMs?: number; pollMs?: number } = {
    step: "waitFor",
  }
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const pollMs = opts.pollMs ?? 120;
  const started = Date.now();
  const first = fn();
  if (first) return first as T;
  return await new Promise<T>((resolve, reject) => {
    const id = window.setInterval(() => {
      try {
        const value = fn();
        if (value) {
          window.clearInterval(id);
          resolve(value as T);
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

// React controls the input's value via its own internal tracker; calling the
// native setter + dispatching 'input' is the documented workaround.
export function setReactInputValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
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

function findButton(matches: {
  text?: string[];
  includesText?: string[];
  ariaLabel?: string[];
  ariaIncludes?: string[];
}): HTMLButtonElement | HTMLElement | null {
  const clickables = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, [role="button"], a[role="button"]'
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
// Issuer ID
// ─────────────────────────────────────────────────────────────────────────────

export function findIssuerId(): string | null {
  const labels = Array.from(document.querySelectorAll<HTMLElement>("span"))
    .filter((el) => el.textContent?.trim() === "Issuer ID");
  for (const label of labels) {
    let parent: HTMLElement | null = label.parentElement;
    for (let i = 0; i < 4 && parent; i++) {
      const text = parent.innerText || "";
      const m = text.match(UUID_RE);
      if (m) return m[0].toLowerCase();
      parent = parent.parentElement;
    }
  }
  const bodyMatch = (document.body?.innerText || "").match(UUID_RE);
  return bodyMatch ? bodyMatch[0].toLowerCase() : null;
}

export async function waitForIssuerId(): Promise<string> {
  return await waitFor(() => findIssuerId(), {
    step: "scan:issuer_id",
    // Generous 30 s window — some ASC pages hydrate their data panels well
    // after document_idle, and the user shouldn't see a false-negative.
    timeoutMs: 30_000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Create-key dialog
// ─────────────────────────────────────────────────────────────────────────────

export async function clickAddKeyButton(): Promise<void> {
  const btn = await waitFor(() => {
    const addSvg = document.querySelector<SVGElement>(
      'svg[class*="AddSystemButton__AddIcon"]'
    );
    const wrapper = addSvg?.closest("button") as HTMLButtonElement | null;
    if (wrapper && visible(wrapper) && !wrapper.disabled) return wrapper;

    return findButton({
      ariaLabel: ["add new api key", "create api key", "generate api key"],
      ariaIncludes: ["add api key", "create api", "generate api"],
      text: ["generate api key", "add new key", "add"],
      includesText: ["generate api key"],
    });
  }, { step: "find:add_key_button" });
  fireClick(btn);
}

function getDialogScope(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[role="dialog"]') ??
    document.querySelector<HTMLElement>("#_m_modal .tb-modal__box") ??
    document.querySelector<HTMLElement>("#_m_modal") ??
    null
  );
}

async function waitForCreateDialogInput(): Promise<HTMLInputElement> {
  return await waitFor<HTMLInputElement>(() => {
    const scope: ParentNode = getDialogScope() ?? document;
    const candidates = Array.from(
      scope.querySelectorAll<HTMLInputElement>(
        "input[type='text'], input:not([type])"
      )
    ).filter((el) => {
      if (!visible(el) || el.disabled) return false;
      const placeholder = (el.getAttribute("placeholder") ?? "").toLowerCase();
      if (placeholder.includes("select") || placeholder.includes("role")) {
        return false;
      }
      if (el.getAttribute("role") === "combobox") return false;
      if (el.closest("[role='combobox'], [role='listbox']")) return false;
      return true;
    });

    const named = candidates.find(
      (el) => el.getAttribute("maxlength") === "30"
    );
    if (named) return named;

    for (const el of candidates) {
      const label = el
        .closest("label")
        ?.textContent?.trim()
        .toLowerCase();
      if (label === "name") return el;
      const parentText = el.parentElement?.innerText?.trim().toLowerCase();
      if (parentText?.startsWith("name")) return el;
    }

    return candidates[0] ?? null;
  }, { step: "find:create_dialog_input", timeoutMs: 6000 });
}

export async function fillCreateDialog(name: string): Promise<void> {
  const input = await waitForCreateDialogInput();
  input.focus();
  setReactInputValue(input, name);
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

// Visually highlight the Access field inside the Generate API Key dialog so
// the user has an unmistakable target.
export function highlightAccessField(): () => void {
  const dialog = getDialogScope();
  if (!dialog) return () => {};

  const STYLE_ID = "adapty-access-highlight-style";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .adapty-access-highlight {
        outline: 4px solid #7018FF !important;
        outline-offset: 4px !important;
        border-radius: 12px !important;
        position: relative !important;
        z-index: 10 !important;
        transition: box-shadow 200ms ease;
        animation: adapty-access-pulse 1.4s ease-in-out infinite;
      }
      .adapty-access-highlight::after {
        content: "👉 Pick an access role, then click Generate";
        position: absolute;
        top: -36px;
        left: 0;
        background: #7018FF;
        color: #ffffff;
        padding: 6px 12px;
        border-radius: 8px;
        font-weight: 600;
        font-size: 12px;
        font-family: -apple-system, "Inter", sans-serif;
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        pointer-events: none;
        z-index: 11;
      }
      @keyframes adapty-access-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(112, 24, 255, 0.75); }
        50%      { box-shadow: 0 0 0 14px rgba(112, 24, 255, 0); }
      }
    `;
    document.head.appendChild(style);
  }

  let target: HTMLElement | null = null;

  const all = Array.from(dialog.querySelectorAll<HTMLElement>("*"));
  const placeholderNode = all.find((el) => {
    const txt = (el.innerText || "").trim();
    const ph = el.getAttribute?.("placeholder") ?? "";
    return txt === "Select Roles" || ph === "Select Roles";
  });
  if (placeholderNode) {
    let node: HTMLElement | null = placeholderNode;
    for (let i = 0; i < 4 && node; i++) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 200 && rect.height >= 30) {
        target = node;
        break;
      }
      node = node.parentElement;
    }
  }

  if (!target) {
    const accessLabel = all.find((el) => {
      const txt = (el.innerText || "").trim();
      return txt === "Access" || txt.startsWith("Access ");
    });
    if (accessLabel) {
      let parent: HTMLElement | null = accessLabel.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        const combo = parent.querySelector<HTMLElement>(
          "[role='combobox'], [role='listbox'], input, button"
        );
        if (combo && combo !== accessLabel) {
          target = combo;
          break;
        }
        parent = parent.parentElement;
      }
    }
  }

  if (!target) return () => {};

  target.classList.add("adapty-access-highlight");
  try {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    // non-fatal
  }

  return () => {
    target?.classList.remove("adapty-access-highlight");
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-submission: scrape key id + click download
// ─────────────────────────────────────────────────────────────────────────────

export function snapshotActiveKeyIds(): Set<string> {
  const ids = new Set<string>();
  const rows = document.querySelectorAll<HTMLElement>(
    "tr[data-key][aria-rowindex]"
  );
  for (const r of Array.from(rows)) {
    const k = r.dataset.key;
    if (k && /^[A-Z0-9]{10}$/.test(k)) ids.add(k);
  }
  return ids;
}

export async function scrapeNewKeyId(
  previousIds: Set<string>,
  opts: { postSubmitDelayMs?: number; timeoutMs?: number } = {}
): Promise<string> {
  const delay = opts.postSubmitDelayMs ?? 1000;
  await new Promise((r) => setTimeout(r, delay));
  return await waitFor<string>(() => {
    const current = snapshotActiveKeyIds();
    for (const id of current) {
      if (!previousIds.has(id)) return id;
    }
    return null;
  }, { step: "scrape:new_key_id", timeoutMs: opts.timeoutMs ?? 10000 });
}

export async function clickDownloadButton(): Promise<void> {
  const btn = await waitFor<HTMLElement>(
    () => {
      const modals = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"], #_m_modal .tb-modal__box, #_m_modal'
        )
      );
      for (const modal of modals) {
        if (!visible(modal)) continue;

        // Accept the modal if any heading OR its full text mentions the
        // Download API Key flow. Apple has shipped multiple heading
        // variants (h1 vs h2, "Download API Key" vs "Download your API
        // key") — be tolerant instead of matching one exact string.
        const headings = Array.from(
          modal.querySelectorAll<HTMLElement>(
            "h1, h2, h3, [role='heading']"
          )
        );
        const modalText = (modal.innerText || "").toLowerCase();
        const titled =
          headings.some((h) => {
            const t = (h.innerText || "").trim().toLowerCase();
            return (
              t.includes("download api key") ||
              t.includes("download your api key")
            );
          }) ||
          /download\s+(your\s+)?api\s+key/i.test(modalText);
        if (!titled) continue;

        const buttons = Array.from(
          modal.querySelectorAll<HTMLButtonElement>(
            "button, a[role='button']"
          ) as unknown as HTMLButtonElement[]
        );
        for (const b of buttons) {
          if (!visible(b)) continue;
          if ((b as HTMLButtonElement).disabled) continue;
          if (b.getAttribute("aria-disabled") === "true") continue;
          const tx = textOf(b).toLowerCase();
          const aria = (
            b.getAttribute("aria-label") ?? ""
          )
            .trim()
            .toLowerCase();
          if (
            tx === "download" ||
            tx === "download api key" ||
            aria === "download" ||
            aria.includes("download")
          ) {
            return b;
          }
        }
      }
      return findButton({
        ariaIncludes: ["download api key", "download key"],
        text: ["download api key", "download"],
        includesText: ["download api key"],
      });
    },
    // Give the user plenty of time to land on the Download dialog after
    // they manually click Generate.
    { step: "find:download_button", timeoutMs: 60_000 }
  );
  dispatchFullClick(btn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Access role selection (App Manager)
// ─────────────────────────────────────────────────────────────────────────────

function findAccessInput(): HTMLInputElement | null {
  const scope = getDialogScope() ?? document;
  const byId =
    scope.querySelector<HTMLInputElement>('div#roles input[name="roles"]') ||
    scope.querySelector<HTMLInputElement>(
      'input[name="roles"][placeholder="Select Roles"]'
    ) ||
    scope.querySelector<HTMLInputElement>('input[name="roles"]');
  if (byId && visible(byId)) return byId;
  return null;
}

function hasAccessChip(roleName: string): boolean {
  const wrap = document.getElementById("roles");
  if (!wrap) return false;
  const needle = roleName.toLowerCase();
  const chips = wrap.querySelectorAll<HTMLElement>("p, span");
  for (const c of chips) {
    const tx = (c.innerText || c.textContent || "").trim().toLowerCase();
    if (tx === needle) return true;
  }
  return false;
}

function findRoleOption(roleName: string): HTMLElement | null {
  const needle = roleName.toLowerCase();
  const walker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_TEXT
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.textContent || "").trim();
    if (!text || text.toLowerCase() !== needle) continue;
    let parent = node.parentElement;
    if (!parent) continue;
    if (
      parent.closest<HTMLElement>(
        '[class*="ChipWrapper"], [class*="ChipsInputstyles__ChipWrapper"]'
      )
    ) {
      continue;
    }
    if (parent.closest<HTMLElement>("label, #info-tooltip-container-roles")) {
      continue;
    }
    if (!visible(parent)) continue;

    let target: HTMLElement = parent;
    for (let i = 0; i < 6 && target.parentElement; i++) {
      const el = target;
      const attr = el.getAttribute("cursor");
      const role = el.getAttribute("role");
      if (attr === "pointer") return el;
      if (role === "option" || role === "menuitem") return el;
      const tag = el.tagName.toLowerCase();
      if (tag === "button" || tag === "li" || tag === "a") return el;
      try {
        const cs = window.getComputedStyle(el);
        if (cs.cursor === "pointer") return el;
      } catch {
        // non-fatal
      }
      target = target.parentElement;
    }
    return parent;
  }
  return null;
}

export async function selectAccessRole(
  roleName: string = "App Manager"
): Promise<void> {
  const L = "[adapty/asc selectAccessRole]";
  if (hasAccessChip(roleName)) {
    console.log(L, "chip already present, skipping");
    return;
  }

  const input = await waitFor<HTMLInputElement>(
    () => findAccessInput(),
    { step: "find:access_input", timeoutMs: 6000 }
  );
  console.log(L, "found input:", input);
  const chipsWrapper = document.getElementById("roles");

  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (hasAccessChip(roleName)) return;
    console.log(L, `round ${round + 1}: opening dropdown`);

    const target = chipsWrapper ?? input;
    try {
      target.focus({ preventScroll: true });
    } catch {
      // non-fatal
    }
    input.focus();
    dispatchFullClick(input);

    let option: HTMLElement | null = null;
    try {
      option = await waitFor<HTMLElement>(
        () => findRoleOption(roleName),
        { step: `find:role_option_${roleName}`, timeoutMs: 2500 }
      );
    } catch {
      option = null;
    }

    if (option) {
      console.log(L, `round ${round + 1}: found option, clicking`, option);
      dispatchFullClick(option);
      await new Promise((r) => setTimeout(r, 400));
      if (hasAccessChip(roleName)) {
        console.log(L, `round ${round + 1}: chip landed — done`);
        return;
      }
      console.log(
        L,
        `round ${round + 1}: clicked option but chip did not land`
      );
    } else {
      console.log(L, `round ${round + 1}: no option matched "${roleName}"`);
    }

    try {
      input.blur();
    } catch {
      // non-fatal
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(L, "3 rounds failed, attempting type + Enter fallback");

  input.focus();
  dispatchFullClick(input);
  setReactInputValue(input, roleName);
  await new Promise((r) => setTimeout(r, 200));
  const enterInit: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    code: "Enter",
  };
  for (const type of ["keydown", "keypress", "keyup"] as const) {
    const ev = new KeyboardEvent(type, enterInit);
    try {
      Object.defineProperty(ev, "keyCode", { get: () => 13 });
      Object.defineProperty(ev, "which", { get: () => 13 });
    } catch {
      // non-fatal
    }
    input.dispatchEvent(ev);
  }

  await waitFor(
    () => (hasAccessChip(roleName) ? true : null),
    { step: `verify:role_chip_${roleName}`, timeoutMs: 3000 }
  );
}

export async function clickGenerateButton(): Promise<void> {
  const btn = await waitFor<HTMLButtonElement>(
    () => {
      const scope = getDialogScope() ?? document;
      const buttons = Array.from(
        scope.querySelectorAll<HTMLButtonElement>("button")
      );
      for (const b of buttons) {
        if (!visible(b)) continue;
        if (b.disabled) continue;
        if (b.getAttribute("aria-disabled") === "true") continue;
        const tx = textOf(b).toLowerCase();
        if (tx === "generate") return b;
      }
      return null;
    },
    { step: "find:generate_button", timeoutMs: 8000 }
  );
  dispatchFullClick(btn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrated sequence — single entry point for asc.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type AutomationProgressStep =
  | "open_dialog"
  | "fill_name"
  | "select_role"
  | "awaiting_user_role"
  | "submit"
  | "scrape_key_id"
  | "click_download";

export interface AutomationResult {
  apiKeyId: string;
}

export async function runCreateKeyAutomation(params: {
  keyName: string;
  onProgress?: (step: AutomationProgressStep) => void;
}): Promise<AutomationResult> {
  const report = (s: AutomationProgressStep) => params.onProgress?.(s);

  report("open_dialog");
  await clickAddKeyButton();

  report("fill_name");
  await fillCreateDialog(params.keyName);

  const keysBeforeSubmit = snapshotActiveKeyIds();

  // Access role + Generate click are always left to the user — Apple's
  // custom combobox is fragile to drive programmatically, and picking a
  // permission scope is a conscious decision we don't want to guess at.
  // We still highlight the Access field so the next action is obvious.
  report("awaiting_user_role");
  const removeHighlight = highlightAccessField();

  try {
    const apiKeyId = await scrapeNewKeyId(keysBeforeSubmit, {
      postSubmitDelayMs: 400,
      timeoutMs: 180_000,
    });

    report("scrape_key_id");
    removeHighlight?.();

    await new Promise((r) => setTimeout(r, 400));

    report("click_download");
    await clickDownloadButton();

    return { apiKeyId };
  } catch (err) {
    removeHighlight?.();
    throw err;
  }
}
