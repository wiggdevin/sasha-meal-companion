/**
 * The common-foods database: ~480 items from USDA SR Legacy (per 100 g,
 * with household portions) plus a few label-sourced items the user actually
 * uses. Built by scripts/build-food-db.py — do not hand-edit the JSON.
 *
 * Search is a small in-house scorer (token prefix, then subsequence), good
 * enough for "chkn brst" → "Chicken breast, roasted" over 500 rows with no
 * dependency. Their own Eats/presets list is searched alongside.
 */

import raw from "./food-db.json";
import type { Food } from "./foods";
import { buildPortions, type Portion } from "./foods/portions";
import { accountUnitGrams } from "./foods/unit-grams";
import { macroKcal } from "./scaling";
import type { LoggedFood, Macros } from "./types";

export type DbPortion = { label: string; grams: number };

export type DbFood = {
  id: string;
  name: string;
  category: string;
  sr: string;
  /** The SR Legacy FoodData Central id (the `fdc_sr_legacy` catalog `source_id`); absent on label rows. */
  fdcId?: number;
  /** The SR food group, which the catalog stores as the revision's `category`; absent on label rows. */
  srCategory?: string | null;
  per100g: { kcal: number; protein: number; carbs: number; fat: number; fiber: number };
  portions: DbPortion[];
  /** Off-plan for their colitis plan: "gluten" | "dairy" | "apple". Logging is still allowed. */
  flags: string[];
  /**
   * OPT-IN marker, set only by `mineAsDb` for an account food whose unit has no known gram weight
   * ("1 cup" of a home recipe, "1 ml" of a liquid of unknown density). The older functions
   * (`portionsFor`, `macrosForGrams`, `searchFoods`, lib/catalog/serving.ts) ignore it and behave as
   * before: the food carries the old stand-in unit weight (`LEGACY_UNIT_GRAMS`), whose per-100 g
   * figures cancel out so one portion is still exactly the entered macros. Only the serving-count
   * helpers read it: `logPortionsFor`, `macrosForPortion`, `gramsForDbPortion`, `loggedFoodFor`,
   * which count servings of `perServing` and record `grams: 0` (weight unknown, never a mass).
   */
  servingOnly?: true;
  /** With `servingOnly`: one unit's macros, as the account entered them. */
  perServing?: Macros;
};

export const FOOD_DB: DbFood[] = raw as DbFood[];
const BY_ID = new Map(FOOD_DB.map((f) => [f.id, f]));

export function dbFood(id: string): DbFood | undefined {
  return BY_ID.get(id);
}

/**
 * Off-plan markers for a food name — the same word lists as
 * lib/catalog-client.ts's offPlanFlags (kept local rather than imported to
 * avoid a food-db.ts <-> catalog-client.ts import cycle, since catalog-client
 * already imports searchFoods from here). Used for their own ("mine") foods,
 * which otherwise had no independent off-plan check downstream of the
 * one-time add-time gate in lib/foods.ts's bannedReason (audit finding #28).
 */
const DAIRY =
  /\b(milk|cheese|yogurt|butter|cream|whey|ghee|ice cream|cheesecake|latte|cappuccino|alfredo|ricotta|feta|brie|mozzarella|parmesan|cheddar|provolone|swiss|pudding|frozen yogurt|hot chocolate|chocolate milk)\b/i;
const DAIRY_OK =
  /\b(almond milk|oat milk|soy milk|coconut milk|coconut water|peanut butter|almond butter|cashew butter|sesame butter|sunflower seed butter|cocoa butter|butternut|buttercup)\b/i;
const GLUTEN =
  /\b(bread|bagel|muffin|croissant|bun|roll|pita|naan|flour tortilla|pancake|waffle|french toast|spaghetti|pasta|noodle|couscous|barley|farro|spelt|wheat|rye|semolina|malt|bulgur|cracker|pretzel|cookie|brownie|cake|donut|pie|cinnamon|pop-tart|ramen|lo mein|dumpling|pierogi|sandwich|burger|pizza|burrito|quesadilla|enchilada|egg roll|spring roll|corn dog|mac|macaroni|lasagna|ziti|gnocchi|biscuit|cornbread|granola|cheerios|corn flakes|cream of wheat|beer|soy sauce|teriyaki|fish sticks|breaded|fried chicken|chicken nuggets|chicken tenders|onion rings|mozzarella sticks|crab cake|meatball|meatloaf|pot pie|gyro|sub |toast|graham|goldfish|rice krispies|oatmeal cookie|oreo|kit kat|falafel|shepherd)\b/i;
const GLUTEN_OK = /\b(rice noodles|corn tortilla|rice cake|buckwheat|quinoa|gluten-free)\b/i;
const APPLE = /\bapple/i;

function offPlanFlags(name: string): string[] {
  const out: string[] = [];
  if (GLUTEN.test(name) && !GLUTEN_OK.test(name)) out.push("gluten");
  if (DAIRY.test(name) && !DAIRY_OK.test(name)) out.push("dairy");
  if (APPLE.test(name)) out.push("apple");
  return out;
}

const GRAMS_PER_OZ = 28.35;

/** Everyday portions first ("1 medium", "1 cup", "1 tbsp"), prep variants ("mashed", "chopped") last. */
function portionRank(label: string): number {
  const l = label.toLowerCase();
  let r = 0;
  if (/\bmedium\b/.test(l)) r -= 4;
  if (/\b(tbsp|tablespoon)\b/.test(l)) r -= 4;
  if (/\b(tsp|teaspoon)\b/.test(l)) r -= 3;
  if (/\b(large|small|slice|piece|each|unit|cup|oz|scoop|egg)\b/.test(l)) r -= 2;
  if (/^1 /.test(l)) r -= 1;
  if (/mashed|pureed|chopped|diced|sliced|shredded|yield|nlea|about|approx/.test(l)) r += 3;
  return r * 100 + Math.min(l.length, 60);
}

/** Portions shown to them: the food's own (everyday ones first), then 1 oz and 100 g. */
export function portionsFor(food: DbFood): DbPortion[] {
  const own = [...food.portions]
    .filter((p) => p.grams > 0)
    .sort((a, b) => portionRank(a.label) - portionRank(b.label))
    .slice(0, 4);
  const extra: DbPortion[] = [
    { label: "1 oz", grams: GRAMS_PER_OZ },
    { label: "100 g", grams: 100 },
  ];
  const seen = new Set(own.map((p) => p.label.toLowerCase()));
  return [...own, ...extra.filter((p) => !seen.has(p.label.toLowerCase()))];
}

/**
 * A stored energy is used when it is finite and >= 0 (a measured 0 stays 0), else Atwater: the same
 * one rule as lib/plan/catalog-component.ts `energyOf`. No bundled row has 0 kcal beside real macros,
 * so this changes no number today; it keeps the two readers from ever disagreeing.
 */
function storedKcal(food: DbFood): number | null {
  const kcal = food.per100g.kcal;
  return Number.isFinite(kcal) && kcal >= 0 ? kcal : null;
}

/** The same measured-else-Atwater fallback `macrosForGrams` already applies to one portion. */
function kcalPer100gFor(food: DbFood): number {
  return storedKcal(food) ?? macroKcal({ protein: food.per100g.protein, carbs: food.per100g.carbs, fat: food.per100g.fat });
}

/**
 * UI lane contract (lib/foods/portions.ts): the food's own everyday portions, ranked the same way
 * `portionsFor` ranks them but WITHOUT its "1 oz"/"100 g" extras — `buildPortions` always appends
 * its own synthetic 100 g tail, so adding those here would double it up. Offline portions have no
 * id of their own (`id: null`); the first one (after ranking) is the default, since DbPortion
 * carries no isDefault flag.
 */
function realPortionsFor(food: DbFood): { id: null; label: string; grams: number; isDefault: boolean }[] {
  return [...food.portions]
    .filter((p) => p.grams > 0)
    .sort((a, b) => portionRank(a.label) - portionRank(b.label))
    .slice(0, 4)
    .map((p, i) => ({ id: null, label: p.label, grams: p.grams, isDefault: i === 0 }));
}

/** The four fields `defaultPortion`/`portions` and a search card's own per100g panel need. */
function servingDataFor(food: DbFood): {
  kcalPer100g: number; per100g: { kcal: number; protein: number; carbs: number; fat: number };
  portions: Portion[]; defaultPortion: Portion | null;
} {
  const kcalPer100g = kcalPer100gFor(food);
  const { portions, defaultPortion } = buildPortions(realPortionsFor(food), kcalPer100g);
  return {
    kcalPer100g,
    per100g: { kcal: kcalPer100g, protein: food.per100g.protein, carbs: food.per100g.carbs, fat: food.per100g.fat },
    portions, defaultPortion,
  };
}

export function macrosForGrams(food: DbFood, grams: number): Macros {
  const k = grams / 100;
  const protein = Math.round(food.per100g.protein * k * 10) / 10;
  const carbs = Math.round(food.per100g.carbs * k * 10) / 10;
  const fat = Math.round(food.per100g.fat * k * 10) / 10;
  // USDA kcal (Atwater with fibre etc.) is the truer number; fall back to macros.
  const stored = storedKcal(food);
  const kcal = stored !== null ? Math.round(stored * k) : macroKcal({ protein, carbs, fat });
  return { protein, carbs, fat, kcal };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function servingMacros(food: DbFood, servings: number): Macros {
  const unit = food.perServing;
  if (!unit) throw new Error(`${food.name} carries no per-serving macros`);
  return { protein: r1(unit.protein * servings), carbs: r1(unit.carbs * servings),
    fat: r1(unit.fat * servings), kcal: Math.round(unit.kcal * servings) };
}

/**
 * The portions a serving-aware log sheet offers (opt-in; the UI lane's LogFoodSheet switch). A
 * weighed food: `portionsFor`. A `servingOnly` food: its own unit only, since "1 oz" or "100 g" of
 * a food with no known weight is not an amount anyone can state.
 */
export function logPortionsFor(food: DbFood): DbPortion[] {
  // grams 0: the stand-in weight the older callers use is never handed to new code as a mass.
  return food.servingOnly ? [{ label: food.portions[0].label, grams: 0 }] : portionsFor(food);
}

/** A `servingOnly` food is counted in its own unit only; any other portion is a caller bug. */
function ownServing(food: DbFood, portion: DbPortion): void {
  if (portion.label !== food.portions[0]?.label) {
    throw new Error(`${food.name} has no known weight; count it in "${food.portions[0]?.label}" (logPortionsFor)`);
  }
}

/**
 * `qty` of one of the food's portions. A weighed food goes through its grams (`macrosForGrams`) at
 * full precision: a density such as 0.92 g per ml is never rounded before it is scaled, and only
 * the final macros are rounded, once. A serving-only food is counted in servings, so one "1 cup"
 * is exactly the entered macros.
 */
export function macrosForPortion(food: DbFood, portion: DbPortion, qty: number): Macros {
  if (!food.servingOnly) return macrosForGrams(food, portion.grams * qty);
  ownServing(food, portion);
  return servingMacros(food, qty);
}

/**
 * Grams in `qty` of a portion, or null when the weight is not known. The same product the macros
 * are scaled from, rounded once to 0.01 g so a density survives (1 ml of milk is 1.03 g, not 1.0).
 */
export function gramsForDbPortion(food: DbFood, portion: DbPortion, qty: number): number | null {
  if (!food.servingOnly) return Math.round(portion.grams * qty * 100) / 100;
  ownServing(food, portion);
  return null;
}

/**
 * The logged card for `qty` of a portion — the builder the log sheet and the label path switch to
 * (UI lane follow-up). A serving-only food records `grams: 0` (weight unknown, never a mass) and
 * its entered macros; a weighed food records its real grams.
 */
export function loggedFoodFor(food: DbFood, portion: DbPortion, qty: number,
  extra: { id: string; at: string }): LoggedFood {
  return {
    id: extra.id,
    foodId: food.id,
    name: food.name,
    portionLabel: portion.label,
    qty,
    grams: gramsForDbPortion(food, portion, qty) ?? 0,
    macros: macrosForPortion(food, portion, qty),
    flags: food.flags.length ? food.flags : undefined,
    at: extra.at,
  };
}

// ---------------------------------------------------------------- search

export type SearchHit = {
  id: string;
  name: string;
  source: "db" | "mine";
  flags: string[];
  score: number;
  /** UI lane contract (lib/foods/portions.ts) — the same shape the online catalog hit carries. */
  kcalPer100g: number | null;
  per100g: { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null } | null;
  portions: Portion[];
  defaultPortion: Portion | null;
  /** Opt-in (see `DbFood.servingOnly`): an account food with no known weight, and its entered macros. */
  servingOnly?: true;
  perServing?: Macros;
};

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9%/&' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Does `q` appear in `word` as a subsequence (chkn → chicken)? */
function subsequence(q: string, word: string): boolean {
  let i = 0;
  for (const ch of word) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}

/** A plain-plural query token also tries its likely singular form ("eggs" → "egg"). */
function pluralForms(q: string): string[] {
  const forms = [q];
  if (q.endsWith("es") && q.length > 4) forms.push(q.slice(0, -2));
  if (q.endsWith("s") && !q.endsWith("ss") && q.length > 2) forms.push(q.slice(0, -1));
  return forms;
}

function scoreTokenAgainst(q: string, words: string[], joined: string): number {
  if (words.some((w) => w === q)) return 10;
  if (words.some((w) => w.startsWith(q))) return 6;
  if (joined.includes(q)) return 4;
  if (q.length >= 3 && words.some((w) => subsequence(q, w))) return 2;
  return 0;
}

function scoreName(query: string[], name: string): number {
  const words = tokens(name);
  const joined = words.join(" ");
  let score = 0;
  for (const q of query) {
    const best = Math.max(...pluralForms(q).map((form) => scoreTokenAgainst(form, words, joined)));
    if (best === 0) return 0; // every query token must land somewhere
    score += best;
  }
  // Shorter names win ties: "Banana" over "Banana bread".
  return score * 100 - Math.min(joined.length, 80);
}

/** An account food's hit: the usual serving data, plus the opt-in serving-only marker. */
function hitDataFor(db: DbFood): ReturnType<typeof servingDataFor> & Pick<SearchHit, "servingOnly" | "perServing"> {
  return { ...servingDataFor(db), ...(db.servingOnly ? { servingOnly: true, perServing: db.perServing } : {}) };
}

/**
 * Search the database and their own foods together. Their foods rank above the
 * database on equal score, because they are the ones the user already eats.
 */
export function searchFoods(
  query: string,
  mine: Record<string, Food> = {},
  limit = 12
): SearchHit[] {
  const q = tokens(query);
  if (q.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const f of Object.values(mine)) {
    if (f.status !== "eats") continue;
    const s = scoreName(q, f.name);
    if (s > 0) hits.push({ id: f.id, name: f.name, source: "mine", flags: offPlanFlags(f.name), score: s + 50,
      ...hitDataFor(mineAsDb(f)) });
  }
  for (const f of FOOD_DB) {
    const s = scoreName(q, f.name);
    if (s > 0) hits.push({ id: f.id, name: f.name, source: "db", flags: f.flags, score: s,
      ...servingDataFor(f) });
  }
  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

/**
 * The stand-in unit weights `mineAsDb` has always used when no real weight is known. They are not
 * masses: with them the per-100 g figures are scaled by the same number, so one portion is still
 * exactly the entered macros on the older gram path. Kept unchanged so no older caller regresses;
 * the serving-count helpers (`servingOnly`) replace them as each caller switches.
 */
const LEGACY_UNIT_GRAMS: Record<string, number> = {
  oz: GRAMS_PER_OZ, cup: 240, tbsp: 15, tsp: 5, whole: 100, pouch: 99, can: 140, g: 1, ml: 1,
};

/**
 * Their own food expressed in the same per-portion shape, so one sheet handles both. A unit with a
 * known weight (a banana is 118 g, olive oil 0.92 g per ml) converts to true per-100 g values. A
 * unit with no known weight keeps the old stand-in weight for the older callers and is marked
 * `servingOnly` with its entered macros for the serving-count helpers.
 */
export function mineAsDb(f: Food): DbFood {
  const known = accountUnitGrams(f);
  const grams = known ?? LEGACY_UNIT_GRAMS[f.unit] ?? 100;
  const scale = 100 / grams;
  return {
    id: f.id,
    name: f.name,
    category: f.role,
    sr: "their list",
    per100g: {
      protein: f.perUnit.protein * scale,
      carbs: f.perUnit.carbs * scale,
      fat: f.perUnit.fat * scale,
      kcal: macroKcal(f.perUnit) * scale,
      fiber: 0,
    },
    portions: [{ label: `1 ${f.unit === "whole" ? "each" : f.unit}`, grams }],
    flags: offPlanFlags(f.name),
    ...(known === null ? { servingOnly: true as const, perServing: { ...f.perUnit, kcal: macroKcal(f.perUnit) } } : {}),
  };
}
