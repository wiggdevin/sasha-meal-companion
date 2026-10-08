/**
 * The Day card's live widget (owner, 2026-10-05): which panels it carries, in what order, and whether
 * the user left it open. Kept on this device per account (backend lane: a `diet_prefs.widget` key can
 * carry it across devices later). Every read survives a missing, blocked or corrupt store and falls
 * back to the defaults; a write that fails keeps the choice for this session only.
 */
import type { AccountHandle } from "@/lib/device/account";
import { readAccountItem, writeAccountItem } from "@/lib/device/account-storage";

export const WIDGET_PANELS = ["kcalLeft", "kcalEaten", "macros", "rings", "macroRings", "water"] as const;
/** Panels never offered as a plain "Add": shown only while their own gate says so, and added to or
 *  removed from the saved order by that gate (lib/today/rebalance-widget.ts), never by the tray. */
export const CONDITIONAL_PANELS = ["rebalance"] as const;
export type WidgetPanel = (typeof WIDGET_PANELS)[number] | (typeof CONDITIONAL_PANELS)[number];

/** Panels the widget will offer once their backend lands; listed in the edit tray, never active.
 *  "rebalance" (Phase 19 R2) is wired as a real, gated panel now, so it is never listed here. */
export const COMING_PANELS: readonly { id: string; name: string }[] = [];

export const PANEL_NAME: Record<WidgetPanel, string> = {
  kcalLeft: "Calories left",
  kcalEaten: "Calories eaten",
  macros: "Protein, carbs and fat",
  water: "Water",
  rings: "All rings",
  macroRings: "Macro rings",
  rebalance: "Rebalance my day",
};

export type WidgetPrefs = { panels: WidgetPanel[]; expanded: boolean; index: number };

export const DEFAULT_PREFS: WidgetPrefs = { panels: ["kcalLeft", "macros", "water"], expanded: false, index: 0 };

const ALL_PANELS: readonly string[] = [...WIDGET_PANELS, ...CONDITIONAL_PANELS];

const isPanel = (value: unknown): value is WidgetPanel =>
  typeof value === "string" && ALL_PANELS.includes(value);

/** A panel added and removed only by its own gate (effectiveWidgetPrefs): the edit tray offers no
 *  Remove for it — that control would be a no-op the gate immediately undoes. */
export const isConditionalPanel = (panel: WidgetPanel): boolean =>
  (CONDITIONAL_PANELS as readonly WidgetPanel[]).includes(panel);

/** A stored value read back: unknown panels dropped, duplicates removed, never empty. */
export function cleanPrefs(raw: unknown): WidgetPrefs {
  if (typeof raw !== "object" || raw === null) return DEFAULT_PREFS;
  const record = raw as Record<string, unknown>;
  const panels = Array.isArray(record.panels)
    ? [...new Set(record.panels.filter(isPanel))] : DEFAULT_PREFS.panels;
  const kept = panels.length > 0 ? panels : DEFAULT_PREFS.panels;
  const index = typeof record.index === "number" && Number.isInteger(record.index)
    ? Math.min(Math.max(record.index, 0), kept.length - 1) : 0;
  return { panels: kept, expanded: record.expanded === true, index };
}

/** Filed under the account (`smc:u:<id>:widget:v1`, lib/device/account-storage.ts, Phase 9 §0.4). */
const NAME = "widget:v1";

/**
 * This tab's own memory of the prefs it has already resolved for an account, once it has resolved
 * any (PR #470 review re-plan): storage can go on silently losing every write for the rest of the
 * visit (full or blocked) while still answering an OLDER value, not an absent one, on every read —
 * so a read cannot tell "the latest truth" from "what a failed write left behind" by itself. Once
 * this tab has resolved a value for an account — by reading it, or by trying to save one — that
 * value is authoritative for the rest of this tab's life; storage is read again only to resolve the
 * very first value. Never written to storage itself and never read back across a real reload.
 */
const sessionPrefs = new Map<string, WidgetPrefs>();
/** Scoped to the account's own bind (not just its id): a later sign-in under the same id after a
 *  sign-out, or a test's fresh bind, starts this tab's memory clean rather than reusing the last
 *  bind's cache. A remount keeps the same handle's epoch, so its cache still carries through. */
const sessionKey = (account: AccountHandle): string => `${account.userId}:${account.epoch}`;

/**
 * Signed out, or the account changed underneath: the defaults, never another account's choice. The
 * very first resolution for an account reads storage, falling back to `fallback` — the caller's
 * current in-memory prefs, when it has any — on a blocked, full or empty store (PR #470 review
 * R1/re-plan); every later call for that account, in this tab, answers from that first resolution
 * directly, so neither a null read nor a stale-but-readable one (a write silently failed) can ever
 * again override what this tab already knows about the account.
 */
export function loadWidgetPrefs(account: AccountHandle | null, fallback: WidgetPrefs = DEFAULT_PREFS): WidgetPrefs {
  if (!account) return DEFAULT_PREFS;
  const key = sessionKey(account);
  const resolved = sessionPrefs.get(key);
  if (resolved) return resolved;
  let next = fallback;
  try {
    const raw = readAccountItem(account, NAME);
    if (raw) next = cleanPrefs(JSON.parse(raw));
  } catch {
    // Falls through to `fallback`, resolved below like any other first read.
  }
  sessionPrefs.set(key, next);
  return next;
}

/**
 * The widget as it is shown and saved (Sol R2 re-plan): "rebalance" is present exactly while its
 * gate answers `show`, the selected panel is kept by NAME when the list shifts (the first panel when
 * the selected one was the gated tab that just left), and the index is always valid. Every renderer
 * (carousel, bubbles, pager, Edit tray) and every write reads this one projection.
 */
export function effectiveWidgetPrefs(prefs: WidgetPrefs, show: boolean): WidgetPrefs {
  const selected = prefs.panels[Math.min(Math.max(prefs.index, 0), prefs.panels.length - 1)];
  const has = prefs.panels.includes("rebalance");
  const shifted: WidgetPanel[] = show === has ? [...prefs.panels]
    : show ? [...prefs.panels, "rebalance"] : prefs.panels.filter((panel) => panel !== "rebalance");
  const panels = shifted.length > 0 ? shifted : [...DEFAULT_PREFS.panels];
  const at = selected === undefined ? -1 : panels.indexOf(selected);
  return { ...prefs, panels, index: at >= 0 ? at : 0 };
}

/**
 * False when nothing was kept (signed out, private mode, storage full, account changed): the choice
 * lasts this visit. `show` is the rebalance gate's live answer and is required: the prefs are
 * normalised through `effectiveWidgetPrefs` before writing, so a write made while the gate is not
 * an explicit yes can never persist "rebalance".
 */
export function saveWidgetPrefs(account: AccountHandle | null, prefs: WidgetPrefs, show: boolean): boolean {
  if (!account) return false;
  const effective = effectiveWidgetPrefs(prefs, show);
  // Kept for this tab regardless of whether the write below actually lands — a remount must see
  // this attempt, not whatever older value storage still has readable.
  sessionPrefs.set(sessionKey(account), effective);
  try {
    // `writeAccountItem` now reports a blocked or full store back to its caller (#470 followup)
    // instead of always answering as if the write landed.
    return writeAccountItem(account, NAME, JSON.stringify(effective));
  } catch {
    return false;
  }
}

/** Move one panel up or down the order; the edges stay put. */
export function movePanel(panels: readonly WidgetPanel[], panel: WidgetPanel, by: -1 | 1): WidgetPanel[] {
  const from = panels.indexOf(panel);
  const to = from + by;
  if (from < 0 || to < 0 || to >= panels.length) return [...panels];
  const next = [...panels];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
