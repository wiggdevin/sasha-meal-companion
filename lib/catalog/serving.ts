/**
 * Serving-aware food lines (U8, owner 2026-10-04: "the food search or ingredient search is all done
 * in 100 gram increments … should be serving aware. So per serving, what is that? How much does it
 * weigh and how many calories … nobody's going to eat a hundred grams of cayenne pepper or beef
 * tallow").
 *
 * The backend lane adds serving data to search hits, food details and the offline cache
 * (`lib/foods/portions.ts` there, PR #356): `defaultPortion`, `portions` (real portions, then a
 * synthetic "100 g" tail), `kcalPer100g` and `per100g`; a detail carries the portions and the
 * four-nutrient panel as `servingPortions` / `simplePer100g`, because its own `portions` and
 * `per100g` keep their older shapes. This module is the UI's only reader of those fields. Every one
 * is optional and checked here, so the UI works before and after that change is deployed: with no
 * serving data a line falls back to "100 g · N kcal", then to the caller's own text.
 *
 * The bundled foods (`lib/food-db.ts`) and the account's own foods can state a serving today, so
 * an offline row reads the same way.
 *
 * Pure, apart from the session memo at the bottom.
 */
import { currentAccountOrNull, onAccountGone } from "@/lib/device/account";
import { dbFood, FOOD_DB, portionsFor, type DbFood } from "@/lib/food-db";
import { UNIT_LABELS, type Food } from "@/lib/foods";
import { unitGrams } from "@/lib/foods/display";
import { macroKcal } from "@/lib/scaling";

/** One serving: "1 tbsp", 14 g, 126 kcal. `id` null is the 100 g tail or an offline portion. */
export type Portion = { id: string | null; label: string; grams: number; kcal: number | null };
export type Per100 = { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null };
export type Serving = {
  /** Real portions, then the 100 g tail when the source sends one. */
  portions: Portion[];
  /** The portion a pick starts from; never the 100 g tail. */
  defaultPortion: Portion | null;
  kcalPer100g: number | null;
  per100g: Per100 | null;
  /** What the per-100 figures are per: grams, or millilitres for the account's own `ml` food. */
  per100Unit?: "g" | "ml";
};

const NONE: Serving = { portions: [], defaultPortion: null, kcalPer100g: null, per100g: null };

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asPortion(value: unknown): Portion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const grams = finite(raw.grams);
  if (!label || grams === null || grams <= 0) return null;
  const id = typeof raw.id === "string" ? raw.id : typeof raw.id === "number" ? String(raw.id) : null;
  return { id, label, grams, kcal: finite(raw.kcal) };
}

function asPer100(value: unknown): Per100 | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  // A detail's own `per100g` is the full nutrient map ({ energy_kcal: { amount } }): not this shape.
  if (!("kcal" in raw)) return null;
  return { kcal: finite(raw.kcal), protein: finite(raw.protein), carbs: finite(raw.carbs), fat: finite(raw.fat) };
}

/**
 * The serving data on a search hit or catalog row (`portions`, `per100g`), a food detail
 * (`servingPortions`, `simplePer100g`) or a cached revision. Anything missing or malformed reads as
 * absent; a legacy `portions` array (`description` / `gramWeight`) is not mistaken for portions.
 */
export function servingOf(source: unknown): Serving {
  if (!source || typeof source !== "object") return NONE;
  const raw = source as Record<string, unknown>;
  const list = Array.isArray(raw.servingPortions) ? raw.servingPortions
    : Array.isArray(raw.portions) ? raw.portions : [];
  const portions = list.map(asPortion).filter((portion): portion is Portion => portion !== null);
  const per100g = asPer100(raw.simplePer100g) ?? asPer100(raw.per100g);
  const kcalPer100g = finite(raw.kcalPer100g) ?? per100g?.kcal ?? null;
  return { portions, defaultPortion: asPortion(raw.defaultPortion), kcalPer100g, per100g };
}

/** A bundled food's serving: its everyday portion first (the same ranking the log sheet uses). */
export function servingOfDbFood(food: DbFood): Serving {
  const kcalPer100g = food.per100g.kcal > 0 ? food.per100g.kcal
    : Math.round(macroKcal({ protein: food.per100g.protein, carbs: food.per100g.carbs, fat: food.per100g.fat }));
  const own = new Set(food.portions.filter((p) => p.grams > 0).map((p) => p.label.toLowerCase()));
  const real = portionsFor(food).filter((p) => own.has(p.label.toLowerCase()))
    .map((p): Portion => ({ id: null, label: p.label, grams: p.grams, kcal: kcalFor(p.grams, kcalPer100g) }));
  return {
    portions: [...real, { id: null, label: "100 g", grams: 100, kcal: kcalPer100g }],
    defaultPortion: real[0] ?? null,
    kcalPer100g,
    per100g: { kcal: kcalPer100g, protein: food.per100g.protein, carbs: food.per100g.carbs, fat: food.per100g.fat },
  };
}

/**
 * The account's own food: a gram food states 100 g and a millilitre food 100 ml (the Foods page's
 * own base, lib/foods/display.ts `per100Base`); a household unit states one of it ("1 tbsp"), with
 * its weight when that is known exactly. A food with no nutrition states none.
 */
export function servingOfFood(food: Pick<Food, "name" | "unit" | "perUnit" | "nutritionUnknown">): Serving {
  const perUnit = macroKcal(food.perUnit);
  if (!Number.isFinite(perUnit) || perUnit < 0 || (perUnit === 0 && food.nutritionUnknown)) return NONE;
  const grams = unitGrams(food);
  if (food.unit === "g" || food.unit === "ml") {
    const kcalPer100g = Math.round(perUnit * 100);
    const base = food.unit;
    return { ...NONE, kcalPer100g, per100Unit: base,
      portions: [{ id: null, label: `100 ${base}`, grams: 100, kcal: kcalPer100g }] };
  }
  const portion: Portion = { id: null, label: `1 ${UNIT_LABELS[food.unit]}`, grams: grams ?? 0, kcal: Math.round(perUnit) };
  return { ...NONE, defaultPortion: portion, portions: [portion],
    kcalPer100g: grams ? Math.round((perUnit * 100) / grams) : null };
}

export function kcalFor(grams: number, kcalPer100g: number | null): number | null {
  return kcalPer100g === null ? null : Math.round((grams * kcalPer100g) / 100);
}

/** "14 g", "4.5 g", "28.4 g" → whole grams from 10 g up, one decimal below. */
export function formatGrams(grams: number): string {
  const value = grams >= 10 ? Math.round(grams) : Math.round(grams * 10) / 10;
  return `${value} g`;
}

/** Household words the source data writes out, said the short way so a 12 px line keeps its calories. */
const SHORT_WORDS: [RegExp, string][] = [[/\btablespoons?\b/gi, "tbsp"], [/\bteaspoons?\b/gi, "tsp"]];

/** "1 tablespoon" → "1 tbsp"; every other label as written. */
export function shortLabel(label: string): string {
  return SHORT_WORDS.reduce((text, [word, short]) => text.replace(word, short), label.trim());
}

/** Whether a portion's own label already names its weight or volume ("100 g", "1 bar (40 g)",
 *  "100 ml"), so no weight is added after it. */
export function labelHasGrams(label: string): boolean {
  return /\d\s?(g|ml)\b/i.test(label);
}

/** "1 tbsp (14 g)": the label, with its weight added when the label does not already say it. */
export function portionName(portion: Pick<Portion, "label" | "grams">): string {
  const label = shortLabel(portion.label);
  return portion.grams > 0 && !labelHasGrams(label) ? `${label} (${formatGrams(portion.grams)})` : label;
}

/**
 * The one serving line: "1 tbsp (14 g) · 126 kcal" from the default portion, "100 g · 900 kcal"
 * ("100 ml · 42 kcal" for a millilitre food) with no real portion, or null when the source states
 * neither (the caller keeps its own text).
 */
export function servingLine(serving: Serving): string | null {
  const portion = serving.defaultPortion;
  if (portion) {
    const kcal = portion.kcal ?? (portion.grams > 0 ? kcalFor(portion.grams, serving.kcalPer100g) : null);
    return kcal === null ? portionName(portion) : `${portionName(portion)} · ${kcal} kcal`;
  }
  return serving.kcalPer100g === null ? null
    : `100 ${serving.per100Unit ?? "g"} · ${Math.round(serving.kcalPer100g)} kcal`;
}

/** What a search row needs to find its serving: the row itself, and where an offline row came from. */
export type ServingRow = { offline: boolean; offlineFoodId?: string; offlineSource?: "db" | "mine" };

/**
 * A search row's serving: the backend's fields when the row carries them, else, for an offline row,
 * the bundled food or the account's own food it came from.
 */
export function rowServing(row: ServingRow, mine: Record<string, Food> = {}): Serving {
  const sent = servingOf(row);
  if (sent.defaultPortion || sent.kcalPer100g !== null || !row.offline || !row.offlineFoodId) return sent;
  if (row.offlineSource === "mine") {
    const food = mine[row.offlineFoodId];
    return food ? servingOfFood(food) : sent;
  }
  const food = dbFood(row.offlineFoodId);
  return food ? servingOfDbFood(food) : sent;
}

/** `servingLine` for a search row (CatalogSearch, AddFoodSheet): null keeps the row's own text. */
export function rowServingLine(row: ServingRow, mine: Record<string, Food> = {}): string | null {
  return servingLine(rowServing(row, mine));
}

/** A portion pill: "1 tbsp · 14 g · 126 kcal" (the weight once, even when the label holds it). */
export function portionPill(portion: Pick<Portion, "label" | "grams" | "kcal">): string {
  const parts = [shortLabel(portion.label)];
  if (portion.grams > 0 && !labelHasGrams(portion.label)) parts.push(formatGrams(portion.grams));
  if (portion.kcal !== null) parts.push(`${portion.kcal} kcal`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- the meal-card ingredient stepper

/**
 * A food's portion, remembered by name for this session and this account. A slot's ingredient line
 * keeps only name, qty, unit, role and macros: the sync schema (`lib/sync/plan-days-schema.ts`)
 * strips any other key and the eaten snapshot is strict, so a portion cannot ride on the component.
 * The stepper looks it up instead: what this account added it with in this session, else the bundled
 * food of that name. The memo belongs to the account bound when it was written: another account in
 * the same tab starts from nothing, and an account leaving clears it (Sol review S2, 2026-10-04).
 */
const remembered = new Map<string, Pick<Portion, "label" | "grams">>();
let rememberedFor: string | null = null;
onAccountGone(() => forgetPortions());

function key(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** The memo for the account bound now; written for another account, it is dropped first. */
function memo(): Map<string, Pick<Portion, "label" | "grams">> {
  const owner = currentAccountOrNull()?.userId ?? null;
  if (owner !== rememberedFor) {
    remembered.clear();
    rememberedFor = owner;
  }
  return remembered;
}

export function rememberPortion(name: string, portion: Pick<Portion, "label" | "grams"> | null): void {
  if (portion && portion.grams > 0 && !/^100 (g|ml)$/i.test(portion.label)) memo().set(key(name), portion);
}

export function forgetPortions(): void {
  remembered.clear();
  rememberedFor = null;
}

let byName: Map<string, DbFood> | null = null;

/** The bundled food with exactly this name, if any (case-insensitive). */
export function bundledFoodNamed(name: string): DbFood | undefined {
  byName ??= new Map(FOOD_DB.map((food) => [key(food.name), food]));
  return byName.get(key(name));
}

export function portionForName(name: string,
  bundled: (name: string) => DbFood | undefined = bundledFoodNamed): Pick<Portion, "label" | "grams"> | null {
  const known = memo().get(key(name));
  if (known) return known;
  const food = bundled(name);
  return food ? servingOfDbFood(food).defaultPortion : null;
}
