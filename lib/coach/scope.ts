/**
 * Scoped AI input (2026-10-04, agreed with the UI lane). Every ask box is bound to one scope:
 * - `component`: one meal card — one slot on one date. Only that slot's actions run.
 * - `page`: one dock tab — the actions that page owns.
 * - `global`: the full coach, exactly as before (also what an absent scope means).
 *
 * Pure. Narrowing works like the recipes surface (lib/coach/recipe-surface.ts): a guidance block at
 * the end of the transcript, plus a server-side filter on both action paths. The system prompt and
 * the provider schema never change with scope, so the coach golden files stay byte-identical.
 */
import type { CoachAction } from "@/lib/coach/actions";
import type { CoachPage, CoachScope, SlotId } from "@/lib/coach/types";

export type { CoachPage, CoachScope } from "@/lib/coach/types";

type ActionKind = CoachAction["kind"];

/** One meal card: the slot's own plan edits and logging that meal. */
const COMPONENT_KINDS: readonly ActionKind[] = [
  "add_slot_item", "remove_slot_item", "set_slot_item", "set_slot_meal", "move_slot",
  "skip_slot", "restore_slot", "log_meal",
];

const PAGE_KINDS: Record<CoachPage, readonly ActionKind[]> = {
  today: [...COMPONENT_KINDS, "delete_entry", "move_entry", "log_water", "log_weight",
    "shift_schedule"],
  body: ["log_weight", "log_water", "update_profile", "set_targets"],
  foods: ["add_to_avoid", "remove_from_avoid", "add_to_eats", "remove_from_eats",
    "add_to_shopping_list", "save_recipe"],
  settings: ["update_profile", "set_targets", "shift_schedule"],
};

/** Null means every kind (global or no scope). */
export function allowedKinds(scope: CoachScope | undefined): ReadonlySet<ActionKind> | null {
  if (!scope || scope.kind === "global") return null;
  return new Set(scope.kind === "component" ? COMPONENT_KINDS : PAGE_KINDS[scope.page]);
}

type Targeted = { slot?: unknown; date?: unknown; from?: unknown; through?: unknown };

/**
 * Drops every action the scope does not allow. A component scope also drops an action aimed at a
 * different slot or date, or one that spans dates (`from`/`through`), so a meal card can only ever
 * change its own meal.
 */
export function actionsInScope<A extends { kind: ActionKind }>(
  actions: readonly A[], scope: CoachScope | undefined,
): A[] {
  const allowed = allowedKinds(scope);
  if (!allowed) return [...actions];
  return actions.filter((action) => {
    if (!allowed.has(action.kind)) return false;
    if (scope?.kind !== "component") return true;
    const target = action as unknown as Targeted;
    if (target.slot !== undefined && target.slot !== scope.slotId) return false;
    if (target.date !== undefined && target.date !== scope.date) return false;
    for (const bound of [target.from, target.through]) {
      if (bound !== undefined && bound !== null && bound !== scope.date) return false;
    }
    return true;
  });
}

/** The viewed date the turn reasons about, when the scope names one. */
export function scopeDate(scope: CoachScope | undefined): string | null {
  if (scope?.kind === "component") return scope.date;
  if (scope?.kind === "page") return scope.date ?? null;
  return null;
}

/** The meal slot a component scope pins, for the existing Plan-sheet slot pinning. */
export function scopeSlot(scope: CoachScope | undefined): SlotId | null {
  return scope?.kind === "component" ? scope.slotId : null;
}

const PAGE_LABEL: Record<CoachPage, string> = {
  today: "Today (the day's meals, logging, water and weight)",
  body: "Body (weight, activity, profile and targets)",
  foods: "Foods (the Eats and Avoid lists, recipes and shopping)",
  settings: "Settings (profile, targets and schedule)",
};

/** Transcript-tail guidance, the same mechanism the recipes surface uses. Empty for global. */
export function scopeGuidance(scope: CoachScope | undefined): string[] {
  const allowed = allowedKinds(scope);
  if (!scope || !allowed) return [];
  const kinds = [...allowed].join(", ");
  if (scope.kind === "component") {
    return [`SCOPE: this ask comes from the ${scope.slotId} meal card for ${scope.date}. Answer about`
      + ` that meal only. Actions may only change ${scope.slotId} on ${scope.date}; allowed kinds:`
      + ` ${kinds}. For anything else, say it belongs in the main coach and emit no action.`];
  }
  if (scope.kind !== "page") return [];
  return [`SCOPE: this ask comes from the ${PAGE_LABEL[scope.page]} page`
    + `${scope.date ? `, viewing ${scope.date}` : ""}. Prefer that page's topic. Allowed action`
    + ` kinds: ${kinds}. For anything else, answer in words and emit no action.`];
}
