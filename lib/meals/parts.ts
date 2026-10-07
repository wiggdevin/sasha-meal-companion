/**
 * Food → the parts it can play on a plate (Phase 17 O1, D4), and each part's portion band in the
 * food's own unit.
 *
 * A food may play several parts, and is used once per plate: eggs, yogurt, cottage cheese and a
 * protein shake are an anchor or a second protein; lentils, dal and beans an anchor or a starch;
 * edamame an anchor or a vegetable. The parts come from the stored role first, then the same
 * name rules the coach uses (`sidePartOf`, the curated families), never from a new word list.
 *
 * Bands are the coach's (`portionBand`, lib/coach/portion-bands.ts) with one correction for the
 * layout: that table's oat band (30–90 g) is for dry oats, so a COOKED porridge gets a bowl band.
 * When a food's unit has no known gram weight, its band is read in calories instead, through a
 * typical energy density for the part (documented in DENSITY).
 *
 * Pure. No I/O.
 */

import type { Food } from "@/lib/foods";
import { portionBand, sidePartOf, type Part, type PortionBand } from "@/lib/coach/portion-bands";
import { PAIRING_FAMILIES, type PairingFamily } from "@/lib/meals/data/pairings";
import { EXTRA_FAMILIES } from "@/lib/meals/data/cuisine";
import { macroKcal } from "@/lib/scaling";
import { accountUnitGrams } from "@/lib/foods/unit-grams";

export type { Part };

const FAMILIES: readonly PairingFamily[] = [...PAIRING_FAMILIES, ...EXTRA_FAMILIES];

const familyCache = new Map<string, PairingFamily | null>();

/** The curated family a food belongs to (the coach's table, then the cuisine additions). */
export function mealFamily(name: string): PairingFamily | null {
  const lower = name.toLowerCase();
  return remember(familyCache, lower, () => FAMILIES.find((row) => row.match.test(lower)) ?? null);
}

// A protein shake anchors its own snack or breakfast; beside a cooked plate it is incoherent.
const SECOND_PROTEIN = new Set(["eggs", "greek yogurt", "cottage cheese", "smoked salmon"]);
const STARCHY_PROTEIN = new Set(["legumes", "dal"]);

/** Caches keyed by what the answer depends on, so an edited food is never read stale. */
const signature = (food: Food) =>
  `${food.name}|${food.role}|${food.unit}|${food.perUnit.protein}|${food.perUnit.carbs}|${food.perUnit.fat}`;
function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  if (cache.size > 4000) cache.clear();
  const value = make();
  cache.set(key, value);
  return value;
}

const partsCache = new Map<string, Part[]>();

/** The parts a food can play, its main part first. */
export function partsOf(food: Food): Part[] {
  return remember(partsCache, signature(food), () => derivePartsOf(food));
}

function derivePartsOf(food: Food): Part[] {
  const side = sidePartOf(food.name);
  const family = mealFamily(food.name);
  // An anchor by its curated family or its nutrition, not only by its stored role: inferred roles
  // file dal and black beans under carbs and paneer under fat (GPT-6 Sol O1 audit, BLOCK 2).
  // A vegetable or fruit never leads a plate unless the account filed it as a protein: broccoli is
  // protein-dense by share (~27 %) and "green beans" matches the legume family by name.
  const produce = food.role !== "protein" && (side === "veg" || side === "fruit");
  // A family name alone is not enough: "Chicken flavored rice" names poultry and is 6 % protein.
  const denseEnough = family ? proteinShare(food) >= 0.18 : food.role === "carb" && proteinShare(food) >= 0.25;
  if (food.role === "protein" || (!produce && denseEnough)) {
    const parts: Part[] = ["anchor"];
    if (family && SECOND_PROTEIN.has(family.key)) parts.push("protein");
    // A legume, or a mixed dish whose own nutrition carries the starch ("Chicken and rice").
    if ((family && STARCHY_PROTEIN.has(family.key)) || side === "starch" || carriesOwnStarch(food)) {
      parts.push("starch");
    }
    if (side === "veg") parts.push("veg");
    return parts;
  }
  if (food.role === "carb") {
    if (side === "starch" || side === "fruit" || side === "veg") return [side];
    return side === "fat" && food.perUnit.fat > 0 ? ["fat"] : ["starch"];
  }
  return ["fat"];
}

/**
 * Protein's share of a food's calories. A non-protein-role food anchors with a curated family at
 * 18 % (chickpeas ~21 %, paneer ~27 %), or as a carb at 25 % (lentils ~31 %, black beans ~27 %);
 * bread (~20 %) and quinoa (~15 %) without a family never do. Fat-role cheeses need a family.
 */
function proteinShare(food: Food): number {
  const kcal = macroKcal(food.perUnit);
  return kcal > 0 ? (4 * food.perUnit.protein) / kcal : 0;
}

/** Carbs bring at least 30 % of an anchor's calories: the dish carries its own starch. */
function carriesOwnStarch(food: Food): boolean {
  const kcal = macroKcal(food.perUnit);
  return kcal > 0 && (4 * food.perUnit.carbs) / kcal >= 0.3;
}

/** Whether a food's nutrition can carry a part: an anchor needs protein, a starch carbs. */
export function carriesPart(food: Food, part: Part): boolean {
  const { protein, carbs, fat } = food.perUnit;
  if (part === "anchor" || part === "protein") return protein > 0;
  if (part === "starch" || part === "fruit") return carbs > 0;
  if (part === "fat") return fat > 0;
  return macroKcal(food.perUnit) > 0;
}

/** Grams in one of the food's units: the starter's own weight, then the unit table. */
export function gramsOf(food: Food): number | null {
  return accountUnitGrams(food);
}

const COOKED_PORRIDGE = /\b(?:oatmeal|porridge|congee|grits)\b.*\bcooked\b|\bcooked\b.*\b(?:oat|porridge)/;

/** The gram band for a food in a part: the coach's band, with a bowl band for cooked porridge. */
export function bandFor(name: string, part: Part): PortionBand {
  if (part === "starch" && COOKED_PORRIDGE.test(name.toLowerCase())) {
    return { min: 120, typical: 240, max: 350, step: 10 };
  }
  return portionBand(name, part);
}

/** kcal per gram assumed for a part when a unit's weight is unknown (lean meat ~1.6, oil ~9). */
const DENSITY: Record<Part, number> = {
  anchor: 1.6, protein: 1.5, starch: 1.3, veg: 0.35, fruit: 0.6, fat: 6,
};

export type UnitBand = { lo: number; hi: number; typical: number; grams: number | null };

const bandCache = new Map<string, UnitBand | null>();

/** The band in the food's own unit (2 oz, 1.5 cups, 1 tbsp). */
export function unitBand(food: Food, part: Part): UnitBand | null {
  return remember(bandCache, `${signature(food)}|${part}`, () => deriveUnitBand(food, part));
}

function deriveUnitBand(food: Food, part: Part): UnitBand | null {
  const band = bandFor(food.name, part);
  const grams = gramsOf(food);
  if (grams) {
    return { lo: band.min / grams, hi: band.max / grams, typical: band.typical / grams, grams };
  }
  const kcal = macroKcal(food.perUnit);
  if (!(kcal > 0)) return null;
  const per = DENSITY[part] / kcal;
  return { lo: band.min * per, hi: band.max * per, typical: band.typical * per, grams: null };
}

/**
 * Whether an amount sits inside the band. The upper bound is hard; the lower bound allows one
 * household unit that is a little lighter than the band's floor (a 29 g slice of bread).
 */
export function withinBand(food: Food, part: Part, qty: number): boolean {
  const band = unitBand(food, part);
  if (!band || !(qty > 0)) return false;
  return qty <= band.hi + 1e-9 && qty >= band.lo * 0.8 - 1e-9;
}

/** "Chicken breast, roasted" → "Chicken breast": the name a plate title uses. */
export function displayName(name: string): string {
  return name.split(",")[0].replace(/\s*\(.*?\)\s*/g, " ").trim().replace(/\s+/g, " ");
}

/** Code-point order: identical on every runtime and locale (phone/server parity, D2). */
export function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One food per name: duplicate account rows of a food are one choice. */
const keyCache = new Map<string, string>();

export function foodKey(food: Food): string {
  // A pure function of the name, remembered: the plate search asks it for every pool food per anchor.
  return remember(keyCache, food.name, () => food.name.trim().toLowerCase().replace(/\s+/g, " "));
}
