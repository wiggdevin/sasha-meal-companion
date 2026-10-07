/**
 * Legacy unit → grams, and per-unit macros → per-100 g.
 *
 * Their foods carry macros per household unit ("1 cup of white rice"). The v2.1
 * `user_foods.per_100g` needs a gram weight for that unit. Dimensional units
 * (g, ml, oz) convert without any food knowledge; household units need the
 * food's own portion row, which `lib/food-db.json` already carries.
 *
 * Pure. No I/O. `perUnitTo100g` has two callers, and both skip it when `gramsPerUnit` returns
 * null: `lib/foods/prefs-client.ts` (`per100gFor`, on every Eats/Avoid mark, writes `{}` for an
 * unknown weight) and `lib/foods/starter-attestation.ts`.
 */

import { FOOD_DB, type DbFood, type DbPortion } from "./food-db";
import type { Food, FoodUnit } from "./foods";
import type { NutrientCode } from "./nutrients/codes";

const GRAMS_PER_OZ = 28.3495;

/** Units whose gram weight does not depend on the food. `ml` is not one: its weight is the liquid's. */
const DIMENSIONAL: Partial<Record<FoodUnit, number>> = { g: 1, oz: GRAMS_PER_OZ };

/**
 * Grams per millilitre for a liquid whose name EXACTLY matches a curated entry (lowercase, single
 * spaces). Fail closed: a density applies only to the plain liquid itself. A name that merely
 * contains one ("honey tea", "honey lemon water", "coffee yogurt", "roasted peanut oil") has no gram
 * weight here, so no invented mass is written; it takes the existing unknown-weight path.
 *
 * The names are the bundled food list's own liquids (lib/food-db.json) plus their obvious plain
 * spellings. Values: published densities, rounded (vegetable oils 0.91–0.93, honey 1.42, maple
 * syrup 1.32, whole/low-fat milk 1.03, plant milks, brewed drinks and broth about 1.0). The
 * household tbsp path can differ slightly for the same food: USDA weighs a tbsp of olive oil at
 * 13.5 g, where 15 ml × 0.92 is 13.8 g.
 */
const LIQUID_DENSITY: Readonly<Record<string, number>> = Object.freeze({
  ...Object.fromEntries([
    "olive oil", "extra virgin olive oil", "avocado oil", "coconut oil", "canola oil", "vegetable oil",
    "sesame oil", "sunflower oil", "peanut oil", "ghee",
  ].map((name) => [name, 0.92])),
  "honey": 1.42,
  "maple syrup": 1.32, "syrup, maple": 1.32,
  ...Object.fromEntries([
    "milk", "whole milk", "milk, whole", "2% milk", "milk, 2%", "1% milk", "skim milk", "milk, skim",
    "nonfat milk", "low-fat milk",
  ].map((name) => [name, 1.03])),
  ...Object.fromEntries([
    "heavy cream",
    "almond milk", "almond milk, unsweetened", "milk, almond", "oat milk", "oat milk (barista style)",
    "soy milk", "soy milk, unsweetened", "coconut milk beverage",
    "water", "sparkling water", "coffee", "coffee, black", "coffee, brewed", "black coffee", "espresso",
    "tea", "tea, black", "tea, brewed", "black tea", "green tea", "chicken broth",
  ].map((name) => [name, 1.0])),
});

/** Grams in one millilitre of the named liquid, or null unless the name is a curated liquid. */
export function gramsPerMl(name: string): number | null {
  return LIQUID_DENSITY[name.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/**
 * Their food names are not food-db ids. Where slugifying the name does not land
 * on a row, this table names the row by hand. Each entry is the nearest USDA
 * preparation; a comment marks the two where the preparation differs.
 */
const NAME_TO_DB: Record<string, string> = {
  "chicken breast, cooked": "chicken-breast-roasted",
  "sirloin steak, cooked": "sirloin-steak-broiled",
  "ahi tuna, cooked": "tuna-yellowfin-cooked",
  "canned albacore, drained": "albacore-tuna-canned-in-water",
  "eggs, large": "egg-whole-large",
  "white potato, peeled & boiled": "potato-boiled-peeled",
  "sweet potato, peeled & cooked": "sweet-potato-baked",
  "butternut squash, roasted": "butternut-squash-baked",
  "banana, medium": "banana",
  "melon (cantaloupe)": "cantaloupe",
  "avocado mayo": "avocado-mayo-primal",
  "salmon, cooked": "salmon-atlantic-farmed-cooked",
  "canned salmon, drained": "canned-salmon-pink",
  "cod / white fish, cooked": "cod-cooked",
  "scallops, cooked": "scallops-raw", // raw row; only the oz weight is used
  "sardines, canned": "sardines-canned-in-oil",
  "pork tenderloin, cooked": "pork-tenderloin-roasted",
  "lamb loin, cooked, trimmed": "lamb-chop-broiled",
  "egg whites": "egg-white",
  "pear, peeled, medium": "pear",
  "pumpkin purée": "pumpkin-canned",
  "cassava / yuca, cooked": "cassava-raw", // raw row; cup weight is close enough for the backfill
  "rice cake, plain": "rice-cake",
  "fruit pouch, pear or banana base": "fruit-pouch",
  "sunflower butter": "sunflower-seed-butter",
  "olives, ripe": "olives-black",
};

/** Foods with no database row at all. Values are the standard household weights. */
const DIRECT_GRAMS: Record<string, Partial<Record<FoodUnit, number>>> = {
  "mct oil": { tbsp: 14 },
  "duck fat": { tbsp: 12.8 },
};

// Built on first use: lib/food-db.ts imports this module (mineAsDb), so reading FOOD_DB while
// this module initialises would hit the import cycle before FOOD_DB exists.
let byId: Map<string, DbFood> | null = null;
let byName: Map<string, DbFood> | null = null;
function dbMaps(): { byId: Map<string, DbFood>; byName: Map<string, DbFood> } {
  byId ??= new Map(FOOD_DB.map((f) => [f.id, f]));
  byName ??= new Map(FOOD_DB.map((f) => [f.name.toLowerCase(), f]));
  return { byId, byName };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function dbRowForName(name: string): DbFood | null {
  const key = name.trim().toLowerCase();
  const { byId, byName } = dbMaps();
  const aliased = NAME_TO_DB[key];
  if (aliased) return byId.get(aliased) ?? null;
  return byName.get(key) ?? byId.get(slugify(key)) ?? null;
}

const CUP_RE = /^(1|0?\.5)\s+cup\b/;
const TBSP_RE = /^1\s+(tbsp|tablespoon)\b/;
const TSP_RE = /^1\s+(tsp|teaspoon)\b/;
const PREP_RE = /mashed|pureed|puree|yield/;
const MEASURE_WORD = /^(cup|cups|tbsp|tablespoon|tsp|teaspoon|oz|ounce|g|gram|ml|nlea|fl)\b/;

function cupGrams(portions: DbPortion[]): number | null {
  const rank = (l: string): number =>
    /^1 cup$/.test(l) ? 0 : /cubes|pieces|chunks/.test(l) ? 1 : /diced|slices|sliced/.test(l) ? 2 : 3;
  const cands = portions
    .map((p) => ({ label: p.label.toLowerCase().trim(), grams: p.grams }))
    .filter((p) => CUP_RE.test(p.label) && !PREP_RE.test(p.label))
    .sort((a, b) => rank(a.label) - rank(b.label));
  if (cands.length === 0) return null;
  return /^0?\.5/.test(cands[0].label) ? cands[0].grams * 2 : cands[0].grams;
}

function spoonGrams(portions: DbPortion[], unit: "tbsp" | "tsp"): number | null {
  const lower = portions.map((p) => ({ label: p.label.toLowerCase().trim(), grams: p.grams }));
  const tbsp = lower.find((p) => TBSP_RE.test(p.label));
  const tsp = lower.find((p) => TSP_RE.test(p.label));
  const cup = cupGrams(portions);
  if (unit === "tbsp") {
    if (tbsp) return tbsp.grams;
    if (tsp) return tsp.grams * 3;
    return cup === null ? null : cup / 16;
  }
  if (tsp) return tsp.grams;
  if (tbsp) return tbsp.grams / 3;
  return cup === null ? null : cup / 48;
}

/** "Eggs, large" wants the large egg, not the medium one: the name picks the size. */
function wholeGrams(name: string, portions: DbPortion[]): number | null {
  const lower = portions.map((p) => ({ label: p.label.toLowerCase().trim(), grams: p.grams }));
  const n = name.toLowerCase();
  for (const size of ["medium", "large", "small"]) {
    if (!n.includes(size)) continue;
    const hit = lower.find((p) => new RegExp(`^1\\s+${size}\\b`).test(p.label));
    if (hit) return hit.grams;
  }
  const named = lower.find((p) => {
    const m = /^1\s+([a-z]+)/.exec(p.label);
    return m !== null && !MEASURE_WORD.test(m[1]);
  });
  return named ? named.grams : null;
}

function labelledGrams(portions: DbPortion[], word: "pouch" | "can"): number | null {
  const hit = portions.find((p) => new RegExp(`^1\\s+${word}\\b`).test(p.label.toLowerCase().trim()));
  return hit ? hit.grams : null;
}

export function gramsPerUnit(name: string, unit: FoodUnit): number | null {
  const fixed = DIMENSIONAL[unit];
  if (fixed !== undefined) return fixed;
  if (unit === "ml") return gramsPerMl(name);
  const direct = DIRECT_GRAMS[name.trim().toLowerCase()]?.[unit];
  if (direct !== undefined) return direct;
  const row = dbRowForName(name);
  if (!row) return null;
  if (unit === "cup") return cupGrams(row.portions);
  if (unit === "tbsp" || unit === "tsp") return spoonGrams(row.portions, unit);
  if (unit === "whole") return wholeGrams(name, row.portions);
  if (unit === "pouch" || unit === "can") return labelledGrams(row.portions, unit);
  return null;
}

const KCAL_PER_G = { protein: 4, carbohydrate: 4, fat: 9 } as const;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Per-unit macros → the `user_foods.per_100g` map. Energy is Atwater over the
 * rounded macros, so the stored numbers are self-consistent: a reader that
 * re-derives kcal from the three gram values gets the same answer.
 *
 * The keys are NUTRIENT_CODES, not the `_g` spellings this returned until T9 §5:
 * `compute_item_snapshot` inner-joins `jsonb_each(per_100g)` on `catalog_nutrients.code`, so a
 * key that is not a code is dropped from the snapshot in silence. lib/foods/adopt-client.ts's
 * `per100gFromBundled` already spoke the codes; this is the same vocabulary.
 */
export function perUnitTo100g(
  perUnit: Food["perUnit"], gramsPerUnit: number
): Partial<Record<NutrientCode, number>> {
  if (!(gramsPerUnit > 0)) throw new Error("gramsPerUnit must be greater than zero");
  const k = 100 / gramsPerUnit;
  const protein = round1(perUnit.protein * k);
  const carbohydrate = round1(perUnit.carbs * k);
  const fat_total = round1(perUnit.fat * k);
  const energy_kcal = Math.round(
    protein * KCAL_PER_G.protein + carbohydrate * KCAL_PER_G.carbohydrate + fat_total * KCAL_PER_G.fat
  );
  return { protein, carbohydrate, fat_total, energy_kcal };
}
