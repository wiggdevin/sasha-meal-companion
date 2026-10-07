import { MACRO_CODES, type NutrientCode } from "@/lib/nutrients/codes";
import { itemKcal } from "@/lib/nutrients/energy";
import { snapshotValue, type Snapshot } from "@/lib/nutrients/snapshot";

type Row = Record<string, unknown>;
export type MealRow = Row & { tz: string; log_items?: Row[] };

/**
 * Each exported column and the snapshot nutrient code it reads (architecture.md §3.3). The
 * snapshot is keyed by nutrient code (`protein`, `carbohydrate`, `fat_total`), never by the
 * column name; this is the same mapping lib/server/export.ts uses for the meals CSV.
 */
const NUTRIENT_COLUMNS: ReadonlyArray<readonly [column: string, code: NutrientCode]> = [
  ["energy_kcal", MACRO_CODES.kcal],
  ["protein_g", MACRO_CODES.protein],
  ["carbohydrate_g", MACRO_CODES.carbs],
  ["fat_g", MACRO_CODES.fat],
];

/** One CSV line per item, so a meal with three foods is three rows. An unmeasured or absent
 *  nutrient stays null (unknown), never 0. */
export function flattenMeals(rows: MealRow[]): Row[] {
  const out: Row[] = [];
  for (const entry of rows) {
    const { log_items: items, ...head } = entry;
    if (!items?.length) { out.push(head); continue; }
    for (const item of items) {
      const { snapshot: rawSnapshot, ...itemRest } = item;
      const snapshot = (rawSnapshot ?? {}) as Snapshot;
      const nutrients: Row = {};
      for (const [column, code] of NUTRIENT_COLUMNS) {
        nutrients[column] = snapshotValue(snapshot, code)?.amount ?? null;
      }
      // Energy follows the one per-item rule (lib/nutrients/energy.ts): reported, else calculated.
      nutrients.energy_kcal = itemKcal(snapshot);
      out.push({ ...head, ...itemRest, ...nutrients });
    }
  }
  return out;
}
