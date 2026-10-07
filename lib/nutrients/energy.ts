/**
 * One rule for a logged item's energy, everywhere it is read (calculation audit 2026-10-05,
 * findings 17-19): use the reported `energy_kcal` when its amount is a finite number >= 0, else
 * the Atwater-calculated `energy_kcal_calc` under the same test, else the energy is unknown.
 * Unknown is `null`, never 0: a caller that sums treats it as "adds nothing and lowers coverage".
 *
 * The SQL twin is the `daily_energy` view (migration 20261210090000_daily_energy): same order,
 * same test (a JSON number >= 0), so a day summed here equals that view's row for the same day.
 *
 * Pure. No I/O.
 */

import { round4 } from "./snapshot";

export type EnergySource = "reported" | "calculated";
export type ItemEnergy = { kcal: number; source: EnergySource };

/** Any snapshot-shaped map: the typed `Snapshot`, a raw jsonb row, or a partial fixture. */
export type EnergySnapshot =
  | Readonly<Record<string, { readonly amount?: unknown } | null | undefined>>
  | null
  | undefined;

function usable(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The item's selected energy and which field supplied it, or null when neither is usable. */
export function itemEnergy(snapshot: EnergySnapshot): ItemEnergy | null {
  const reported = usable(snapshot?.energy_kcal?.amount);
  if (reported !== null) return { kcal: reported, source: "reported" };
  const calculated = usable(snapshot?.energy_kcal_calc?.amount);
  if (calculated !== null) return { kcal: calculated, source: "calculated" };
  return null;
}

/** The selected kcal alone; null means unknown. */
export function itemKcal(snapshot: EnergySnapshot): number | null {
  return itemEnergy(snapshot)?.kcal ?? null;
}

/** Which sources a sum drew on: one of them, both ("mixed"), or none (null). */
export type EnergySourceMix = EnergySource | "mixed" | null;

export type EnergyTotal = {
  /** Sum of the selected energy; null when no item had a usable value. */
  kcal: number | null;
  itemsWithValue: number;
  itemsTotal: number;
  /** itemsWithValue / itemsTotal, 4 dp; 0 for an empty list. */
  coverage: number;
  reportedItems: number;
  calculatedItems: number;
};

/** Per-item selection first, then the sum and the coverage — never the other way round. */
export function energyTotal(snapshots: readonly EnergySnapshot[]): EnergyTotal {
  let kcal: number | null = null;
  let reportedItems = 0;
  let calculatedItems = 0;
  for (const snapshot of snapshots) {
    const energy = itemEnergy(snapshot);
    if (!energy) continue;
    kcal = round4((kcal ?? 0) + energy.kcal);
    if (energy.source === "reported") reportedItems += 1;
    else calculatedItems += 1;
  }
  const itemsTotal = snapshots.length;
  const itemsWithValue = reportedItems + calculatedItems;
  return { kcal, itemsWithValue, itemsTotal, reportedItems, calculatedItems,
    coverage: itemsTotal === 0 ? 0 : round4(itemsWithValue / itemsTotal) };
}

export function sourceMix(reportedItems: number, calculatedItems: number): EnergySourceMix {
  if (reportedItems > 0 && calculatedItems > 0) return "mixed";
  if (reportedItems > 0) return "reported";
  if (calculatedItems > 0) return "calculated";
  return null;
}
