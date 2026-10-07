/**
 * Informational micronutrient context. architecture.md §3.1: micros have no rings, no targets
 * and no red states — amount first, percentage muted. Fiber is shown against their 20–25 g band
 * (targets.md), not against the 25 g AI, which is why fiberBandState does not read a DriRow.
 *
 * Pure. No I/O.
 */

import { FIBER_BAND_G, type NutrientCode } from "./codes";
import type { NutrientTotal } from "./totals";

export type DriRow = {
  code: NutrientCode;
  refType: "RDA" | "AI" | "UL" | "EAR";
  value: number;
  unit: string;
};

/** Grams per one of the unit. Only the mass family converts; kcal never does. */
const GRAMS_PER_UNIT: Record<string, number> = { g: 1, mg: 1e-3, "µg": 1e-6, ug: 1e-6 };

export function percentDri(
  total: NutrientTotal | undefined,
  dri: DriRow | undefined
): number | null {
  if (!total || !dri) return null;
  if (total.itemsWithValue === 0) return null;
  if (!(dri.value > 0)) return null;
  const from = GRAMS_PER_UNIT[total.unit];
  const to = GRAMS_PER_UNIT[dri.unit];
  if (from === undefined || to === undefined) return null;
  const amountInDriUnit = (total.amount * from) / to;
  return Math.round((amountInDriUnit / dri.value) * 1000) / 10;
}

export function fiberBandState(fiberG: number | null): "under" | "in-band" | "over" | "unknown" {
  if (fiberG === null || !Number.isFinite(fiberG)) return "unknown";
  if (fiberG < FIBER_BAND_G.min) return "under";
  if (fiberG > FIBER_BAND_G.max) return "over";
  return "in-band";
}

/**
 * contracts §2 (Lane I Task 1's contract change) — Lane I's `DayNutrients` is the only Phase 2
 * consumer. A hand-written mirror of the twelve rows migration …090300_phase2_catalog_dri_seed.sql
 * seeds into `catalog_dri`; Task 10's psql assertion checks the two agree so this can never drift
 * from the seed unnoticed.
 */
export const DRI_FEMALE_19_30: readonly DriRow[] = [
  { code: "fiber_total", refType: "AI", value: 25, unit: "g" },
  { code: "iron", refType: "RDA", value: 18, unit: "mg" },
  { code: "calcium", refType: "RDA", value: 1000, unit: "mg" },
  { code: "potassium", refType: "AI", value: 2600, unit: "mg" },
  { code: "magnesium", refType: "RDA", value: 310, unit: "mg" },
  { code: "zinc", refType: "RDA", value: 8, unit: "mg" },
  { code: "vitamin_c", refType: "RDA", value: 75, unit: "mg" },
  { code: "vitamin_d", refType: "RDA", value: 15, unit: "µg" },
  { code: "vitamin_b12", refType: "RDA", value: 2.4, unit: "µg" },
  { code: "folate_dfe", refType: "RDA", value: 400, unit: "µg" },
  { code: "vitamin_a_rae", refType: "RDA", value: 700, unit: "µg" },
  { code: "sodium", refType: "AI", value: 1500, unit: "mg" },
];
