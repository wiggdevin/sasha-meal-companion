/**
 * The client half of compute_item_snapshot (migration 20260918090100).
 *
 * Same inputs, same rounding, same null rule, so an offline entry shows the numbers the server
 * will store and `snapshotsEqual` is a real assertion rather than a hope. architecture.md §3.3:
 * `amount` is the item's contribution in the nutrient's own unit with grams already applied;
 * `null` means the source did not measure the nutrient, `0` means it measured zero.
 *
 * Pure. No I/O.
 */

import { isNutrientCode, NUTRIENT_UNITS, type NutrientCode } from "./codes";

export type NutrientValue = {
  amount: number | null;
  unit: string;
  /** `per_unit`: an item of unknown mass, its own per-unit numbers × qty (t17). */
  basis: "per_100g" | "per_unit";
  /**
   * With `basis: "per_unit"` only: the EXACT per-unit number `amount` was computed from, never
   * rounded, so a count edit recomputes per_unit × qty and rounds once (t17 round 4).
   */
  per_unit?: number;
  source: string;
  source_version: string;
  revision_id: number | null;
};

/** Spec shape (contracts §4). Only the codes the source carries are present — read with
 *  `snapshotValue`, never by direct index. */
export type Snapshot = Record<NutrientCode, NutrientValue>;

export type SnapshotMeta = {
  source: string;
  source_version: string;
  revision_id: number | null;
  /** catalog_nutrients.unit by code, when the cached row carries one. */
  units?: Partial<Record<NutrientCode, string>>;
};

/**
 * A finite non-negative number as the exact decimal Postgres receives: digits and a power of ten.
 * supabase-js sends a JS number over the wire as `String(value)` (its shortest round-trip decimal
 * text), and Postgres parses that text into an exact `numeric` — so the client must read the same
 * text, not the double, to compute what the server computes.
 */
function toDecimal(value: number): { digits: bigint; scale: number } {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`expected a finite number >= 0, got ${value}`);
  }
  const text = value.toString(); // shortest round-trip form, the same text JSON.stringify sends
  const [mantissa, expPart] = text.toLowerCase().split("e");
  const exp = expPart ? Number(expPart) : 0;
  const [intPart, fracPart = ""] = mantissa.split(".");
  let digits = BigInt(`${intPart}${fracPart}`);
  let scale = fracPart.length - exp; // value = digits / 10^scale
  if (scale < 0) {
    digits *= BigInt(10) ** BigInt(-scale);
    scale = 0;
  }
  return { digits, scale };
}

/** round(digits / 10^scale, 4) half away from zero, returned as a JS number with at most 4 decimals. */
function roundScaled4(digits: bigint, scale: number): number {
  // BigInt(10n)-style literals need target >= ES2020 (tsconfig.json is out of this task's scope
  // to change), so every power-of-ten and comparison constant below goes through BigInt(...).
  if (scale <= 4) return Number(digits * BigInt(10) ** BigInt(4 - scale)) / 1e4;
  const divisor = BigInt(10) ** BigInt(scale - 4);
  const quotient = digits / divisor;
  const remainder = digits % divisor;
  const rounded = remainder * BigInt(2) >= divisor ? quotient + BigInt(1) : quotient;
  return Number(rounded) / 1e4;
}

/**
 * Postgres `round(numeric, 4)` rounds half away from zero on an exact decimal, computed on the
 * exact text the server receives — not on the IEEE double `value`. Doubles compound rounding
 * error before the halfway compare ever runs (2.8499999999999996 x 212.5 / 100 can drift to the
 * wrong side of a .5 boundary in double arithmetic while the exact decimal product does not), so
 * this reads `value`'s shortest round-trip decimal text via `toDecimal`/`roundScaled4` (BigInt,
 * no new dependency) instead of scaling and comparing as a double.
 */
export function round4(value: number): number {
  const { digits, scale } = toDecimal(value);
  return roundScaled4(digits, scale);
}

/** per100 x grams / 100 in exact decimal, rounded to 4 dp — byte-for-byte what compute_item_snapshot stores. */
function scaledAmount(per100: number, grams: number): number {
  const a = toDecimal(per100);
  const b = toDecimal(grams);
  return roundScaled4(a.digits * b.digits, a.scale + b.scale + 2);
}

export function computeSnapshot(
  per100g: Record<NutrientCode, number | null>,
  grams: number,
  meta: SnapshotMeta
): Snapshot {
  if (!Number.isFinite(grams) || grams < 0) {
    throw new RangeError(`grams must be a finite number >= 0, got ${grams}`);
  }
  const out: Partial<Record<NutrientCode, NutrientValue>> = {};
  for (const [key, per100] of Object.entries(per100g)) {
    if (!isNutrientCode(key)) continue;
    if (per100 === undefined) continue;
    out[key] = {
      amount: per100 === null ? null : scaledAmount(per100, grams),
      unit: meta.units?.[key] ?? NUTRIENT_UNITS[key],
      basis: "per_100g",
      source: meta.source,
      source_version: meta.source_version,
      revision_id: meta.revision_id,
    };
  }
  return out as Snapshot;
}

/**
 * The client half of compute_unit_snapshot (migration 20261211090000): an item whose mass is
 * unknown, its per-unit numbers × qty, the same exact-decimal rounding as the per-100 g path, and
 * each exact per-unit number kept beside its amount (`per_unit`), as the server stores it.
 * Unknown codes, non-finite and negative numbers are skipped (no entry), never 0.
 */
export function computeUnitSnapshot(
  perUnit: Partial<Record<string, number>>, qty: number, meta: SnapshotMeta,
): Snapshot {
  if (!Number.isFinite(qty) || qty <= 0) return {} as Snapshot;
  const q = toDecimal(qty);
  const out: Partial<Record<NutrientCode, NutrientValue>> = {};
  for (const [key, amount] of Object.entries(perUnit)) {
    if (!isNutrientCode(key)) continue;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) continue;
    const a = toDecimal(amount);
    out[key] = {
      amount: roundScaled4(a.digits * q.digits, a.scale + q.scale),
      per_unit: amount,
      unit: meta.units?.[key] ?? NUTRIENT_UNITS[key],
      basis: "per_unit",
      source: meta.source,
      source_version: meta.source_version,
      revision_id: meta.revision_id,
    };
  }
  return out as Snapshot;
}

export function snapshotValue(snapshot: Snapshot, code: NutrientCode): NutrientValue | undefined {
  return (snapshot as Partial<Record<NutrientCode, NutrientValue>>)[code];
}

/**
 * Amount and unit only. Provenance (source, source_version, revision_id) is deliberately not
 * compared: the offline client writes the cached revision's label and the server writes the
 * active one, and the parity test asserts those separately.
 *
 * The `- 1e-9` slack on the epsilon compare mirrors `round4`'s own slack: two already-rounded
 * amounts sitting exactly `epsilon` apart land a hair under that in binary floating point, and
 * without the slack the comparison reads them as inside tolerance when they are meant to be
 * exactly on the boundary (outside it).
 */
export function snapshotsEqual(a: Snapshot, b: Snapshot, epsilon = 1e-4): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) if (keysA[i] !== keysB[i]) return false;
  for (const key of keysA) {
    if (!isNutrientCode(key)) return false;
    const left = snapshotValue(a, key);
    const right = snapshotValue(b, key);
    if (!left || !right) return false;
    if (left.unit !== right.unit) return false;
    if (left.amount === null || right.amount === null) {
      if (left.amount !== right.amount) return false;
      continue;
    }
    if (Math.abs(left.amount - right.amount) > epsilon - 1e-9) return false;
  }
  return true;
}
