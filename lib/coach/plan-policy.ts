/**
 * A plan never holds a food the account's rules block (AGENTS.md: "A food on Avoid never appears in
 * any date's plan"). Logging is different — a log records what already happened and marks an
 * off-plan item (ruling 2026-09-14) — but an action that WRITES THE PLAN with a blocked item is
 * refused whole, with the reason, instead of being applied and merely marked "off-plan".
 *
 * GPT-6 Sol AI-integration audit, 2026-10-04, finding B1: `set_slot_meal` could write a blocked item
 * across up to 31 dates. Pure; the server applies it after grounding on both action paths.
 */
import type { CoachAction } from "@/lib/coach/actions";

/**
 * The actions that put a food INTO a plan slot, as opposed to logging what was eaten. A
 * `set_slot_item` only resizes a line already on the slot (lib/coach/apply-slot.ts keeps that
 * line's food), and its grounding is a fresh search for the model's short word, so its verdict is
 * another food's: "milk" refused to resize an allowed almond-milk line (audit 2026-10-10 A158).
 */
export const PLAN_WRITE_KINDS = new Set<CoachAction["kind"]>([
  "set_slot_meal", "add_slot_item",
]);

export function refusePlanBlocked(actions: readonly CoachAction[]): {
  actions: CoachAction[]; refusals: string[];
} {
  const kept: CoachAction[] = [];
  const refusals: string[] = [];
  for (const action of actions) {
    const blocked = PLAN_WRITE_KINDS.has(action.kind) && "flagged" in action
      ? (action.flagged as string[]) : [];
    if (blocked.length === 0) {
      kept.push(action);
      continue;
    }
    refusals.push(`I didn't put ${blocked.join(", ")} in your plan — your food rules or Avoid list `
      + "block it. Pick something else, or change the rule first.");
  }
  return { actions: kept, refusals };
}
