/**
 * Which slot a meal card's planning turn is about, in the coach contract it speaks (2026-10-04,
 * backend PR #355, scoped AI input). The card's turns carry `scope: { kind: "component", slotId,
 * date }` instead of the Plan sheet's older `surface: "plan"` with `planSlot` / `planningSlot`; the
 * server pins the slot from the scope the same way, and runs the turn in a private plan thread.
 * Combining the two answers 400, so a turn carries exactly one of them.
 *
 * The scope's `date` sets the turn's viewed day, so `now` is the real clock. The legacy path faked
 * `now` as the viewed date at noon so the server's slot target came from that day.
 *
 * `PLAN_TURN_CONTRACT` is the one switch: "legacy" restores the old fields if the scope contract is
 * not deployed when this ships.
 */
import { MEAL_SLOT_IDS, type MealSlotId, type SlotId } from "@/lib/coach/types";
import type { CoachScope } from "@/lib/coach/types";

/** The backend's component scope (lib/coach/types.ts, `.strict()` there). */
export type ComponentScope = Extract<CoachScope, { kind: "component" }>;

export type PlanTurnContract = "scope" | "legacy";
/** The server speaks scope since PR #355; "legacy" stays only as the documented fallback switch. */
export const PLAN_TURN_CONTRACT: PlanTurnContract = "scope";

export type PlanTurnFields =
  | { scope: ComponentScope; now: string }
  | { surface: "plan"; now: string; planningSlot?: MealSlotId; planSlot?: MealSlotId };

const isMealSlot = (slot: string): slot is MealSlotId => (MEAL_SLOT_IDS as readonly string[]).includes(slot);

/**
 * The slot fields of one card turn. `initialPlan` is the automatic opening ("Choose for me"), which
 * the legacy contract marked with `planningSlot`; under scope every turn is pinned alike.
 */
export function planTurnFields(slot: SlotId, date: string, initialPlan: boolean,
  contract: PlanTurnContract = PLAN_TURN_CONTRACT, at: Date = new Date()): PlanTurnFields {
  if (contract === "scope") return { scope: { kind: "component", slotId: slot, date }, now: at.toISOString() };
  const meal = isMealSlot(slot) ? slot : undefined;
  return {
    surface: "plan",
    // The server's slot target comes from the turn clock, not a number in the prompt.
    now: new Date(`${date}T12:00:00`).toISOString(),
    ...(initialPlan && meal ? { planningSlot: meal } : {}),
    ...(!initialPlan && meal ? { planSlot: meal } : {}),
  };
}
