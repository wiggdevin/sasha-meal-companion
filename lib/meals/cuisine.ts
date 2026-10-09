/**
 * The account's stated cuisines as a plate-ranking term (onb3, owner direction 2026-10-08: picked
 * cuisines must visibly shape the plan). `user_settings.cuisines` held up to six cuisines, and no
 * plate changed with them: the cuisine-tagged sides of ./data/cuisine.ts apply to every account.
 *
 * A plate's cuisine factor is 1 + CUISINE_WEIGHT × the calorie-weighted share of its foods that a
 * stated cuisine leans on (./data/cuisine.ts CUISINE_STAPLES: core 1, common 0.6), with a side the
 * curated table lists for that cuisine's pairing group (CUISINE_SIDES) counted as core. It
 * multiplies the plate score, so it only reorders plates already built from admitted foods: it
 * never adds, removes or re-judges a food, and a food of no stated cuisine keeps its full score
 * (factor 1, never a penalty). No stated cuisine: no factor, every plate byte for byte unchanged.
 *
 * Reads curated meal data only, never the food universe (which stays inert for a closed account).
 *
 * Pure. No I/O.
 */
import type { Food } from "@/lib/foods";
import { CUISINE_PAIRING_GROUP, CUISINES, type CuisineKey } from "@/lib/profile/cuisines";
import { CUISINE_SIDES, CUISINE_STAPLES, type Cuisine as PairingGroup } from "@/lib/meals/data/cuisine";
import { pairingRank } from "@/lib/coach/meal-pairings";
import { mealFamily, type Part } from "@/lib/meals/parts";
import type { TemplateKey } from "@/lib/meals/templates";

/** How far a plate wholly of core foods of a stated cuisine rises over one of none. */
export const CUISINE_WEIGHT = 0.6;
const CORE = 1;
const COMMON = 0.6;

export type CuisineRanking = {
  /** The stated cuisines, in vocabulary order (the identity of the ranking). */
  cuisines: readonly CuisineKey[];
  /** The pairing groups those cuisines map onto. */
  groups: ReadonlySet<PairingGroup>;
};

/** The ranking for an account's stored cuisines; undefined when none is stated (no term). */
export function cuisineRanking(stored: readonly string[] | null | undefined): CuisineRanking | undefined {
  const cuisines = CUISINES.filter((key) => stored?.includes(key));
  if (!cuisines.length) return undefined;
  return { cuisines, groups: new Set(cuisines.map((key) => CUISINE_PAIRING_GROUP[key])) };
}

/** A stable key for memo tables. */
export function cuisineKey(ranking: CuisineRanking | undefined): string {
  return ranking ? ranking.cuisines.join(",") : "";
}

/** A food's best staple score across the stated cuisines (0 for none). */
export function cuisineTierScore(food: Pick<Food, "name">, ranking: CuisineRanking): number {
  let best = 0;
  for (const cuisine of ranking.cuisines) {
    const staples = CUISINE_STAPLES[cuisine];
    if (!staples) continue;
    if (pairingRank(food.name, staples.core) >= 0) return CORE;
    if (pairingRank(food.name, staples.common) >= 0) best = COMMON;
  }
  return best;
}

/** Whether the curated table lists `side` beside `anchor` for one of the stated pairing groups. */
function listedForGroup(anchor: Food | null, side: Food, part: Part, template: TemplateKey,
  ranking: CuisineRanking): boolean {
  if (part === "anchor" || part === "protein") return false;
  const family = anchor ? mealFamily(anchor.name)?.key ?? "*" : "*";
  return CUISINE_SIDES.some((row) => (row.family === family || row.family === "*")
    && row.template === template && row.cuisines.some((group) => ranking.groups.has(group))
    && pairingRank(side.name, row.sides[part as keyof typeof row.sides] ?? []) >= 0);
}

/** The plate's cuisine factor (>= 1). `rows` carry each food's part and its calories. */
export function cuisineFactor(rows: readonly { food: Food; part: Part; kcal: number }[],
  template: TemplateKey, ranking: CuisineRanking): number {
  const anchor = rows.find((row) => row.part === "anchor")?.food ?? null;
  let total = 0;
  let weighted = 0;
  for (const row of rows) {
    const kcal = Math.max(0, row.kcal);
    total += kcal;
    const score = listedForGroup(anchor, row.food, row.part, template, ranking) ? 1
      : cuisineTierScore(row.food, ranking);
    weighted += kcal * score;
  }
  return total > 0 ? 1 + CUISINE_WEIGHT * (weighted / total) : 1;
}
