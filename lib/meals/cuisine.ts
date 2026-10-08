/**
 * The account's stated cuisines as a plate-ranking term (onb3, owner direction 2026-10-08: picked
 * cuisines must visibly shape the plan). `user_settings.cuisines` held up to six cuisines, and no
 * plate changed with them: the cuisine-tagged sides of ./data/cuisine.ts apply to every account,
 * and the pack tiers (lib/foods/universe/data/packs.ts) reached only an open account's `pref-2`
 * taste values, at a 0.15 weight.
 *
 * A plate's cuisine factor is 1 + CUISINE_WEIGHT × the calorie-weighted share of its foods that
 * belong to a stated cuisine, by their best pack tier (core 1, common 0.6, occasional 0.3), with a
 * side the curated table lists for that cuisine's pairing group (./data/cuisine.ts CUISINE_SIDES)
 * counted as core. It multiplies the plate score, so it only reorders plates that are already
 * built from admitted foods: it never adds, removes or re-judges a food, and a food of no stated
 * cuisine keeps its full score (factor 1, never a penalty). No stated cuisine: no factor at all,
 * and every plate is byte for byte what it was.
 *
 * Pure. No I/O.
 */
import type { Food } from "@/lib/foods";
import { baseFoodName } from "@/lib/foods/base-name";
import { dbFood } from "@/lib/food-db";
import { PACKS } from "@/lib/foods/universe/data/packs";
import { CUISINE_PAIRING_GROUP, CUISINES, type CuisineKey, type Tier } from "@/lib/foods/universe/vocabulary";
import { CUISINE_SIDES, type Cuisine as PairingGroup } from "@/lib/meals/data/cuisine";
import { pairingRank } from "@/lib/coach/meal-pairings";
import { mealFamily, type Part } from "@/lib/meals/parts";
import type { TemplateKey } from "@/lib/meals/templates";

/** How far a plate wholly of core foods of a stated cuisine rises over one of none. */
export const CUISINE_WEIGHT = 0.6;
const TIER_SCORE: Record<Tier, number> = { core: 1, common: 0.6, occasional: 0.3 };

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

/** "Ground beef 90/10, cooked" and "Ground beef 85/15, cooked" are one food for a cuisine. */
const looseName = (name: string) => baseFoodName(name).replace(/[\d/%.]+/g, " ").replace(/\s+/g, " ").trim();

type TierTable = Map<string, Partial<Record<CuisineKey, Tier>>>;
let tiersByName: TierTable | null = null;

/** Pack tiers keyed by the bundled food's exact name and by its loose base name. */
function tierTable(): TierTable {
  if (tiersByName) return tiersByName;
  const table: TierTable = new Map();
  const add = (key: string, cuisine: CuisineKey, tier: Tier) => {
    if (!key) return;
    const row = table.get(key) ?? {};
    const held = row[cuisine];
    if (!held || TIER_SCORE[tier] > TIER_SCORE[held]) row[cuisine] = tier;
    table.set(key, row);
  };
  for (const cuisine of CUISINES) {
    for (const tier of ["core", "common", "occasional"] as const) {
      for (const id of PACKS[cuisine][tier]) {
        const name = dbFood(id)?.name;
        if (!name) continue;
        add(`=${name.toLowerCase()}`, cuisine, tier);
        add(`~${looseName(name)}`, cuisine, tier);
      }
    }
  }
  tiersByName = table;
  return table;
}

/** A food's best tier score across the stated cuisines (0 for none). */
export function cuisineTierScore(food: Pick<Food, "name">, ranking: CuisineRanking): number {
  const table = tierTable();
  const row = table.get(`=${food.name.toLowerCase()}`) ?? table.get(`~${looseName(food.name)}`);
  if (!row) return 0;
  return Math.max(0, ...ranking.cuisines.map((cuisine) => (row[cuisine] ? TIER_SCORE[row[cuisine]!] : 0)));
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
