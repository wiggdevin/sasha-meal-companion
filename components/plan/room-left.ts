/**
 * The one budget figure a card's Plan flow may show (2026-10-04, owner: "The current macronutrients
 * I'm seeing aren't lining up with the breakfast card"). The slot target the panel plans to is this
 * slot's share of what is left of the day (lib/plan/slot-share.ts), protein first, so it is never the
 * meal's own numbers; it is said as room left, in words, beside the meal it would replace. Pure.
 */
import type { Macros } from "@/lib/types";

export function roomLeftLine(target: Macros | undefined): string | undefined {
  if (!target) return undefined;
  const kcal = Math.round(target.kcal);
  if (kcal < 1) return "Today’s calories are already planned or eaten.";
  const protein = Math.round(target.protein);
  // Said of the new ideas, so it never reads as a verdict on the meal shown above it (Kimi P0, 2026-10-04).
  return protein >= 1 ? `New ideas fit the room left for this meal: about ${kcal} kcal and ${protein} g protein.`
    : `New ideas fit the room left for this meal: about ${kcal} kcal.`;
}
