/**
 * Which meal a suggestion is for, read off the slot's clock time (2026-10-03, owner report:
 * "High protein" for Meal 1 at 7:30 am came back as 387 g of scallops with a banana). A slot id
 * such as "meal-1" says nothing about the time of day, so the clock decides. The bands live in
 * lib/meals/occasion.ts (Phase 17 O1), the one copy the layout, swaps and coach all read.
 *
 * Pure. No I/O.
 */

import { clockLabel, clockMinutes, isUntimed, occasionAt, type Occasion } from "@/lib/meals/occasion";
import { templateFor } from "@/lib/meals/templates";

export { clockLabel, clockMinutes, isUntimed };

/** The coach's name for an occasion; one set of clock bands lives in lib/meals/occasion.ts. */
export type MealType = Occasion;

/**
 * The slot clock time the build reads, when the caller can give one. `slotClock` is the planned
 * time of a named slot ("07:30"); `timeOfDay` is the turn's own clock ("7:30 AM"), the fallback for
 * a request that names no slot or a slot whose time is not known.
 */
export type MealClockPorts = {
  slotClock?: (slot: string, signal?: AbortSignal) => Promise<string | null>;
  timeOfDay?: () => string;
};

/** The meal type at a clock time. A snack request is always a snack, whatever the time. */
export function mealTypeAt(
  clock: string | null | undefined, kind: "meal" | "snack" | "recipe" = "meal",
): MealType {
  if (kind === "snack") return "snack";
  return occasionAt(clock);
}

/**
 * Lunch, dinner and an overnight meal share the savoury-main template; the rest have their own.
 * An untimed meal follows its anchor (lib/meals/templates.ts, the one copy).
 */
export const templateOf = templateFor;

/**
 * The clock this build is for: a named slot's planned time, else the turn's own clock. A request
 * that names a slot never falls back to "now" (2026-10-03 audit, MAJOR 5): planning breakfast at
 * 20:00 is still breakfast, and a slot with no readable time is "other", not dinner. A port that
 * fails or is missing simply leaves the time unknown.
 */
export async function resolveMealClock(
  slot: string | null | undefined, ports: MealClockPorts, signal?: AbortSignal,
): Promise<string | null> {
  if (slot) {
    try {
      return clockLabel(await ports.slotClock?.(slot, signal));
    } catch {
      // The slot time is a ranking hint, never a reason to fail the build.
      return null;
    }
  }
  try {
    return clockLabel(ports.timeOfDay?.() ?? null);
  } catch {
    return null;
  }
}
