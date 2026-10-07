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
  return round1(portion.gramWeight * qty);
}

export function gramsFromUnit(qty: number, unit: LogUnit): number | null {
  assertQty(qty);
  if (unit === "g") return round1(qty);
  if (unit === "oz") return round1(qty * GRAMS_PER_OZ);
  return null;
}
