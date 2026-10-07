/**
 * The client half of the daily_totals view (migration 20260918090200).
 *
 * Coverage is items-carrying-a-value / all items that day — architecture.md §3.3 — so a 5 g
 * sprinkle of an uncharacterised spice costs the same coverage as a 200 g main. That is the
 * architecture's rule, and the spec's open question 1 names it; do not weight by grams here
 * without amending architecture.md first.
 *
 * Pure. No I/O.
 */

import { isNutrientCode, NUTRIENT_UNITS, TRACKED_MICROS, type NutrientCode } from "./codes";
import { round4, snapshotValue, type Snapshot } from "./snapshot";

export type NutrientTotal = {
  code: NutrientCode;
  amount: number;
  unit: string;
  itemsWithValue: number;
  itemsTotal: number;
  coverage: number;
};

export function totalsFor(items: { snapshot: Snapshot }[]): Map<NutrientCode, NutrientTotal> {
  const itemsTotal = items.length;
  const out = new Map<NutrientCode, NutrientTotal>();
  if (itemsTotal === 0) return out;

  for (const { snapshot } of items) {
    for (const key of Object.keys(snapshot)) {
      if (!isNutrientCode(key)) continue;
      const value = snapshotValue(snapshot, key);
      if (!value) continue;
      const row = out.get(key) ?? { code: key, amount: 0, unit: value.unit ?? NUTRIENT_UNITS[key],
        itemsWithValue: 0, itemsTotal, coverage: 0 };
      if (value.amount !== null) {
        row.amount = round4(row.amount + value.amount);
        row.itemsWithValue += 1;
      }
      out.set(key, row);
    }
  }
  for (const row of out.values()) row.coverage = round4(row.itemsWithValue / itemsTotal);
  return out;
}

export function microCoverage(
  totals: Map<NutrientCode, NutrientTotal>,
  codes: readonly NutrientCode[] = TRACKED_MICROS
): { covered: number; tracked: number; pct: number } {
  const tracked = codes.length;
  let covered = 0;
  for (const code of codes) if ((totals.get(code)?.itemsWithValue ?? 0) > 0) covered += 1;
  return { covered, tracked, pct: tracked === 0 ? 0 : Math.round((covered / tracked) * 100) };
}
