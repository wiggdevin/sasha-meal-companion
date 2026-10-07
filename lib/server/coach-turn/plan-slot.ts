/**
 * Every Plan-sheet turn is about ONE known meal slot, and the sheet shows only cards that fit that
 * slot (components/PlanSheet.tsx `selectable`). The opening turn says so through `planningSlot`;
 * quick picks, typed wishes, photo or link asks and refills keep the coach's normal intent path,
 * whose own slot read is a regex over the prompt. When that regex missed, cards were built against
 * the loose admission window, and the sheet threw every one away ("No ready meal options yet").
 *
 * This pins the slot on the suggestion and compose tools for any plan-surface turn, whatever path
 * or model call reaches them. The person's preference (wish text, kind of ask, plan source) is
 * left as it is; only the slot, the meal kind and the remaining-macros fit are fixed.
 */

import { scopeSlot } from "@/lib/coach/scope";
import type { ComposeArgs, Executor, SuggestInput } from "@/lib/coach/executors";
import type { ToolName } from "@/lib/coach/registry";
import { MEAL_SLOT_IDS, type CoachTurnRequest, type MealSlotId } from "@/lib/coach/types";

/** lib/plan/quick-picks.ts writes the slot id in parentheses: "for Meal 2 (meal-2) on …". */
const SLOT_IN_PROMPT = /\((meal-[1-6])\)/;

const mealSlot = (value: string | undefined): MealSlotId | null =>
  MEAL_SLOT_IDS.find((id) => id === value) ?? null;

/** The meal slot a turn plans for: the structured fields first, the sheet's own prompt text last. */
export function planSlotOf(
  req: Pick<CoachTurnRequest, "surface" | "planningSlot" | "planSlot" | "text" | "scope">,
): MealSlotId | null {
  // A meal card's scope pins its own slot, the same way the Plan sheet does (lib/coach/scope.ts).
  const scoped = scopeSlot(req.scope);
  if (scoped) return mealSlot(scoped);
  // Only a Plan-sheet turn is about one slot: a chat or recipe-widget turn that carries a
  // `planningSlot` must not have its suggestions forced onto it (2026-10-03 audit).
  if (req.surface !== "plan") return null;
  if (req.planningSlot) return req.planningSlot;
  return req.planSlot ?? mealSlot(SLOT_IN_PROMPT.exec(req.text)?.[1]);
}

/** The turn's executors, with the plan slot fixed on every meal suggestion and composition. */
export function pinPlanSlot(
  executors: Record<ToolName, Executor>, slot: MealSlotId | null,
): Record<ToolName, Executor> {
  if (!slot) return executors;
  return {
    ...executors,
    suggest_options: (userId, args) => {
      const input = args as SuggestInput;
      // A complete-recipe search is the sheet's other list; it carries no slot target.
      if (input.kind === "recipe") return executors.suggest_options(userId, args);
      const pinned: SuggestInput = { ...input, kind: "meal", fitRemaining: true, slot };
      return executors.suggest_options(userId, pinned);
    },
    compose_meal: (userId, args) =>
      executors.compose_meal(userId, { ...(args as ComposeArgs), slot }),
  };
}
