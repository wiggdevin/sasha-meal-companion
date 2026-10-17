/**
 * Grams are the only quantity the snapshot understands. Everything the sheet offers resolves to
 * grams here or not at all — a unit that needs a catalog portion returns null rather than a
 * guess, so the sheet blocks the food and says so instead of storing a zeroed item.
 *
 * `log_items.unit` stays free text in Phase 2 (spec, open question 4); these are the four values
 * Phase 2 writes. Pure. No I/O.
 */

export const LOG_UNITS = ["g", "oz", "portion", "each"] as const;
export type LogUnit = (typeof LOG_UNITS)[number];

const GRAMS_PER_OZ = 28.349523125;
const UNIT_SET: ReadonlySet<string> = new Set(LOG_UNITS);

export function isLogUnit(value: string): value is LogUnit {
  return UNIT_SET.has(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Grams to a tenth, and never a positive amount rounded down to nothing: a pinch is 0.1 g, not
 * 0 g, which would log no food at all and disable Log (calculation audit N1, W058).
 */
export function roundGrams(value: number): number {
  const rounded = round1(value);
  return rounded === 0 && value > 0 ? 0.1 : rounded;
}

function assertQty(qty: number): void {
  if (!Number.isFinite(qty) || qty < 0) {
    throw new RangeError(`qty must be a finite number >= 0, got ${qty}`);
  }
}

export function gramsForPortion(portion: { gramWeight: number }, qty: number): number {
  assertQty(qty);
  if (!Number.isFinite(portion.gramWeight) || portion.gramWeight <= 0) {
    throw new RangeError(`gramWeight must be a finite number > 0, got ${portion.gramWeight}`);
  }
  return roundGrams(portion.gramWeight * qty);
}

export function gramsFromUnit(qty: number, unit: LogUnit): number | null {
  assertQty(qty);
  if (unit === "g") return roundGrams(qty);
  if (unit === "oz") return roundGrams(qty * GRAMS_PER_OZ);
  return null;
}

/**
 * The grams a typed box holds, or null when it holds no number (audit 2026-10-10 A016). A decimal
 * comma reads as a point ("150,5" is 150.5), since a comma-decimal keypad types it; a sign, a lone
 * separator or any other character is not a weight, so the sheet logs nothing rather than the last
 * number it read.
 */
export function parseGramsText(text: string): number | null {
  const plain = (text ?? "").trim().replace(",", ".");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(plain)) return null;
  const n = Number(plain);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
