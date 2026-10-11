/**
 * Amounts, in the one direction that matters: their words (or the model's) to grams (spec §7).
 *
 * A vague measure returns null on purpose. "A handful" has no gram weight, and inventing one would
 * put a number in their day that nothing stands behind; null sends the item to the stepper instead.
 * A volume unit with no portion row is the same case: grams per cup is a density, and we have none.
 * So is a count with no portion row (audit 2026-10-10 A007, A044): "two bananas" or "8 shrimp" has
 * no weight here, and the caller keeps the model's own grams rather than a flat 100 g a piece.
 *
 * A portion row's gram weight is the weight of the amount its label names: `import-fdc.py`
 * `portion_label` writes "<amount> <unit> …", so "0.5 cup" weighs half a cup (A006).
 *
 * Pure. No I/O.
 */

const GRAMS_PER_OZ = 28.3495;

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

/**
 * The amount a portion label starts with: "0.5 cup" → 0.5, "1/2 cup" → 0.5, "1 1/2 cups" → 1.5,
 * "2 tbsp" → 2. A label with no leading amount ("NLEA serving", "slice") is one of itself.
 */
export function portionAmount(description: string): number {
  const text = (description ?? "").trim();
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)(?![\d.\/])/);
  if (mixed) return positiveOr1(Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]));
  const fraction = text.match(/^(\d+)\/(\d+)(?![\d.\/])/);
  if (fraction) return positiveOr1(Number(fraction[1]) / Number(fraction[2]));
  const decimal = text.match(/^(\d+(?:\.\d+)?|\.\d+)(?![\d\/])/);
  return decimal ? positiveOr1(Number(decimal[1])) : 1;
}

function positiveOr1(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function usable(p: CapturePortion): boolean {
  return Number.isFinite(p.gramWeight) && p.gramWeight > 0;
}

/**
 * The portion row whose label names the unit, preferring one of exactly one unit ("1 cup" over
 * "0.5 cup") so the matched row reads the way the user said it.
 */
export function matchPortion(unit: string, portions: CapturePortion[]): CapturePortion | null {
  const want = unit.toLowerCase();
  const words = (p: CapturePortion) => p.description.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const word of [want, `${want}s`]) {
    const named = portions.filter((p) => usable(p) && words(p).includes(word));
    const one = named.find((p) => portionAmount(p.description) === 1);
    if (one ?? named[0]) return one ?? named[0];
  }
  return null;
}

/** Grams for `qty` of `unit`, or null when nothing here can weigh it (the caller keeps its own). */
export function gramsFor(qty: number, unit: string, portions: CapturePortion[]): number | null {
  if (!Number.isFinite(qty) || qty < 0) return null;
  const want = unit.toLowerCase();
  if (want === "g") return qty;
  if (want === "oz") return qty * GRAMS_PER_OZ;
  const portion = matchPortion(want, portions);
  if (!portion) return null;
  return (qty * portion.gramWeight) / portionAmount(portion.description);
}
