import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import { RECIPE_MACROS, type RecipeMacroKey } from "@/lib/recipe-catalog/types";
import type { Macros } from "@/lib/types";
import type { MacroFact } from "@/lib/recipes-hub/hub";

export type DayAfter = {
  /** What the day will total once one serving is eaten; null where the serving's value is unknown. */
  after: Record<RecipeMacroKey, number | null>;
  /** The day's targets from its effective revision; null before a profile exists. */
  targets: Macros | null;
};

/**
 * The day's totals once one serving of a recipe is eaten on `date` (owner, 2026-10-04: the macro strip
 * turns from "per serving" to "your day after this"): everything already eaten or logged that day, as
 * the Today screen resolves it, plus the serving. Read from the phone's own store, so it costs no
 * request. An unknown serving value stays unknown rather than adding 0.
 */
/** What `date` already holds, as the Today screen resolves it, and its targets. */
export function dayEaten(date: string): { eaten: Macros; targets: Macros | null } {
  const day = resolveDay(loadStore(), date);
  return { eaten: day.consumed, targets: day.targets };
}

export function dayAfterServing(date: string, serving: Record<RecipeMacroKey, MacroFact>): DayAfter {
  const day = resolveDay(loadStore(), date);
  const after = Object.fromEntries(RECIPE_MACROS.map((key) => {
    const value = serving[key].value;
    return [key, value === null ? null : day.consumed[key] + value];
  })) as Record<RecipeMacroKey, number | null>;
  return { after, targets: day.targets };
}
