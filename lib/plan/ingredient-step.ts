/**
 * The meal card's ingredient stepper (components/SlotCardDetail.tsx), serving-aware (U8, owner
 * 2026-10-04: "nobody's going to eat a hundred grams of cayenne pepper or beef tallow"). A line
 * measured in grams steps by one of its food's portions when that portion is known ("1 tbsp",
 * 14 g), snapping to whole portions; otherwise by 25 g. A cup steps by a quarter, a count food by 1.
 * The portion is looked up by the caller (`portionForName` in lib/catalog/serving.ts): a slot line
 * cannot carry one through sync.
 *
 * Pure.
 */
import { formatGrams, shortLabel } from "@/lib/catalog/serving";
import type { FoodComponent } from "@/lib/types";

export type StepPortion = { label: string; grams: number };

const GRAM_STEP = 25;
/** Below this many grams a portion is too fine to step by on its own (a pinch); 25 g wins. */
const MIN_PORTION_GRAMS = 1;

function usable(component: Pick<FoodComponent, "unit">, portion: StepPortion | null | undefined): portion is StepPortion {
  return component.unit === "g" && !!portion && Number.isFinite(portion.grams) && portion.grams >= MIN_PORTION_GRAMS;
}

/** One step's size in the line's own unit. */
export function ingredientStep(component: Pick<FoodComponent, "unit">, portion?: StepPortion | null): number {
  if (usable(component, portion)) return portion.grams;
  if (component.unit === "g") return GRAM_STEP;
  if (component.unit === "cup") return 0.25;
  return 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPSILON = 1e-6;

/**
 * The quantity one press of + (1) or − (−1) leads to. By portion: up to the next whole portion, down
 * to the one before, never below one portion (a line already under one portion stays put going
 * down). Otherwise the unit step, never below its minimum (¼ cup, 1 of anything else).
 */
export function stepIngredientQty(component: Pick<FoodComponent, "unit" | "qty">, direction: -1 | 1,
  portion?: StepPortion | null): number {
  if (usable(component, portion)) {
    const count = component.qty / portion.grams;
    if (direction === 1) return round2((Math.floor(count + EPSILON) + 1) * portion.grams);
    const next = Math.ceil(count - EPSILON) - 1;
    return next >= 1 ? round2(next * portion.grams) : component.qty;
  }
  const minimum = component.unit === "cup" ? 0.25 : 1;
  return Math.max(minimum, round2(component.qty + ingredientStep(component) * direction));
}

const COUNT = /^(\d+(?:\.\d+)?)\s+([a-z]+)/i;
const FRACTIONS: Record<string, string> = { "0.25": "¼", "0.5": "½", "0.75": "¾" };

function formatCount(value: number): string {
  const whole = Math.floor(value);
  const glyph = FRACTIONS[String(Math.round((value - whole) * 100) / 100)];
  if (glyph) return whole > 0 ? `${whole}${glyph}` : glyph;
  return String(Math.round(value * 100) / 100);
}

/**
 * The amount a line shows: "2 tbsp · 28 g" when it is a clean number of a short portion
 * ("1 tbsp", "1 cup, chopped" → "cup"), else the weight alone, else `fallback` (the unit's own
 * text, for a line not measured in grams).
 */
export function ingredientQtyLabel(component: Pick<FoodComponent, "unit" | "qty">, portion: StepPortion | null | undefined,
  fallback: string): string {
  if (component.unit !== "g") return fallback;
  const grams = formatGrams(component.qty);
  if (!usable(component, portion)) return grams;
  const match = COUNT.exec(shortLabel(portion.label));
  const word = match ? match[2].toLowerCase() : "";
  if (!match || word.length > 6) return grams;
  const servings = (component.qty / portion.grams) * Number(match[1]);
  const quarters = Math.round(servings * 4);
  if (quarters < 1 || Math.abs(servings * 4 - quarters) > 0.02) return grams;
  return `${formatCount(quarters / 4)} ${word} · ${grams}`;
}
