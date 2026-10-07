/**
 * One display rule for every nutrient, so `—` and `0` never trade places.
 * Spec: null → "—", never "0"; kcal to 1, macros to 0.1 g, micros to their unit.
 *
 * Pure. No I/O.
 */

import { NUTRIENT_UNITS, type NutrientCode } from "./codes";

const DECIMALS: Record<string, number> = { kcal: 0, g: 1, mg: 1, "µg": 1, ug: 1 };

export function formatAmount(code: NutrientCode, amount: number | null, unit: string): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  const shown = unit || NUTRIENT_UNITS[code];
  const decimals = DECIMALS[shown] ?? 1;
  return `${amount.toFixed(decimals)} ${shown}`;
}
