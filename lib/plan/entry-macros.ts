/**
 * What one logged entry adds to the day. Split out of lib/resolve.ts (400-line cap), which
 * re-exports every name here. Pure.
 */

import { MACRO_CODES, type NutrientCode } from "@/lib/nutrients/codes";
import { itemKcal } from "@/lib/nutrients/energy";
import type { Snapshot } from "@/lib/nutrients/snapshot";
import { totalsFor } from "@/lib/nutrients/totals";
import type { LoggedFood, LoggedItem, Macros } from "@/lib/types";

/**
 * Phase 2 acceptance 5: the rings read from logged snapshots. `null` means this entry has nothing
 * measured — a pre-Phase-2 extra, or a migrated legacy meal item — and the caller uses the stored
 * `macros` instead, so an old log keeps totalling exactly as it did.
 */
export function measuredItems(items: LoggedItem[] | undefined): { snapshot: Snapshot }[] {
  return (items ?? []).filter((i) => Object.keys(i.snapshot ?? {}).length > 0) as { snapshot: Snapshot }[];
}

export function snapshotMacros(items: LoggedItem[] | undefined): Macros | null {
  const all = items ?? [];
  const measured = measuredItems(all);
  if (measured.length === 0) return null;
  const totals = totalsFor(measured);
  const at = (code: NutrientCode): number => totals.get(code)?.amount ?? 0;
  // One energy rule (lib/nutrients/energy.ts): reported, else calculated; an item with neither
  // adds nothing to the sum rather than a measured-looking 0.
  const kcalFor = (s: Snapshot): number => itemKcal(s) ?? 0;
  const base: Macros = {
    kcal: measured.reduce((sum, i) => sum + kcalFor(i.snapshot), 0),
    protein: at(MACRO_CODES.protein),
    carbs: at(MACRO_CODES.carbs),
    fat: at(MACRO_CODES.fat),
  };
  const unmeasured = all.filter((i) => Object.keys(i.snapshot ?? {}).length === 0);
  return unmeasured.reduce(
    (acc, i) => ({
      kcal: acc.kcal + (i.macros?.kcal ?? 0),
      protein: acc.protein + (i.macros?.protein ?? 0),
      carbs: acc.carbs + (i.macros?.carbs ?? 0),
      fat: acc.fat + (i.macros?.fat ?? 0),
    }),
    base
  );
}

export function entryMacros(entry: LoggedFood): Macros {
  return snapshotMacros(entry.items) ?? entry.macros;
}
