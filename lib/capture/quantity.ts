/**
 * Amounts, in the one direction that matters: their words (or the model's) to grams (spec §7).
 *
 * A vague measure returns null on purpose. "A handful" has no gram weight, and inventing one would
 * put a number in their day that nothing stands behind; null sends the item to the stepper instead.
 * A volume unit with no portion row is the same case: grams per cup is a density, and we have none.
 *
 * Pure. No I/O.
 */

const GRAMS_PER_OZ = 28.3495;
const DEFAULT_WHOLE_GRAMS = 100;

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  half: 0.5, quarter: 0.25,
};

/** The units the prompts allow (lib/ai/prompts.ts UNITS) plus the spellings people use. */
const UNIT_WORDS: Record<string, string> = {
  g: "g", gram: "g", grams: "g", gs: "g",
  oz: "oz", ounce: "oz", ounces: "oz",
  cup: "cup", cups: "cup",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  slice: "slice", slices: "slice",
  piece: "piece", pieces: "piece",
  whole: "whole",
};

/** Measures with no gram weight. Refused, never rounded into a number. */
const VAGUE = new Set(["handful", "handfuls", "bunch", "some", "few", "bit", "scoop", "scoops",
  "serving", "servings", "portion", "portions", "plate", "bowl"]);

function readQty(token: string): number | null {
  const word = WORD_NUMBERS[token];
  if (word !== undefined) return word;
  const fraction = token.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const bottom = Number(fraction[2]);
    return bottom === 0 ? null : Number(fraction[1]) / bottom;
  }
  const n = Number(token);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseAmount(text: string): { qty: number; unit: string } | null {
  const tokens = (text ?? "").toLowerCase().replace(/[^a-z0-9/.\s]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const qty = readQty(tokens[i]);
    if (qty === null) continue;
    for (const next of tokens.slice(i + 1, i + 3)) {
      if (VAGUE.has(next)) return null;
      const unit = UNIT_WORDS[next];
      if (unit) return { qty, unit };
    }
    // A bare count with no unit word is a count of the food itself: "two eggs".
    return { qty, unit: "whole" };
  }
  return null;
}

export type CapturePortion = { id: number | null; description: string; gramWeight: number };
export type Per100g = Record<string, number | null>;

export function matchPortion(unit: string, portions: CapturePortion[]): CapturePortion | null {
  const want = unit.toLowerCase();
  const words = (p: CapturePortion) => p.description.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return portions.find((p) => words(p).includes(want))
    ?? portions.find((p) => words(p).includes(`${want}s`))
    ?? null;
}

export function gramsFor(
  qty: number, unit: string, portions: CapturePortion[], per100g: Per100g
): number | null {
  if (!Number.isFinite(qty) || qty < 0) return null;
  const want = unit.toLowerCase();
  if (want === "g") return qty;
  if (want === "oz") return qty * GRAMS_PER_OZ;
  const portion = matchPortion(want, portions);
  if (portion) return qty * portion.gramWeight;
  // No portion row. A count of a whole food still has a defensible default; a volume does not.
  if ((want === "whole" || want === "piece") && Object.keys(per100g).length > 0) {
    return qty * DEFAULT_WHOLE_GRAMS;
  }
  return null;
}
