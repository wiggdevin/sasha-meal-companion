/**
 * The day's selected energy, read from `daily_energy` (migration 20261210090000): per item, the
 * reported `energy_kcal`, else the calculated `energy_kcal_calc`, else unknown — summed after the
 * per-item choice. The TS twin of that rule is lib/nutrients/energy.ts. Every server reader of a
 * day's calories (expenditure intake, the progress export, the log/MCP/coach day totals) goes
 * through here instead of `daily_totals`' reported-only `energy_kcal` row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { NUTRIENT_UNITS } from "@/lib/nutrients/codes";
import { sourceMix, type EnergySourceMix } from "@/lib/nutrients/energy";
import type { NutrientTotal } from "@/lib/nutrients/totals";
import { readByDateChunks } from "@/lib/server/date-chunks";

export const DAILY_ENERGY_VIEW = "daily_energy";

export type DayEnergy = {
  localDate: string;
  /** null: no item that day had usable energy (unknown, never 0). */
  kcal: number | null;
  itemsWithValue: number;
  itemsTotal: number;
  coverage: number;
  source: EnergySourceMix;
};

type Row = Record<string, unknown>;

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function dayEnergyFromRow(row: Row, localDate?: string): DayEnergy {
  const amount = row.amount === null || row.amount === undefined ? null : Number(row.amount);
  return {
    localDate: localDate ?? String(row.local_date).slice(0, 10),
    kcal: amount !== null && Number.isFinite(amount) ? amount : null,
    itemsWithValue: count(row.items_with_value),
    itemsTotal: count(row.items_total),
    coverage: count(row.coverage),
    source: sourceMix(count(row.reported_items), count(row.calculated_items)),
  };
}

const COLUMNS =
  "local_date, amount, items_with_value, items_total, coverage, reported_items, calculated_items";

/** Every date in [from, to] with live items, keyed by local date. One row per date. */
export async function readDailyEnergy(
  client: SupabaseClient, userId: string, from: string, to: string,
): Promise<Map<string, DayEnergy>> {
  const rows = await readByDateChunks(from, to, async (start, end) => {
    const { data, error } = await client.from(DAILY_ENERGY_VIEW).select(COLUMNS)
      .eq("user_id", userId).gte("local_date", start).lte("local_date", end)
      .order("local_date", { ascending: true });
    if (error) throw error;
    return (data ?? []) as Row[];
  });
  return new Map(rows.map((row) => {
    const day = dayEnergyFromRow(row);
    return [day.localDate, day];
  }));
}

/** One date through RLS (the caller's own day). */
export async function dayEnergy(
  client: SupabaseClient, userId: string, localDate: string,
): Promise<DayEnergy | null> {
  const { data, error } = await client.from(DAILY_ENERGY_VIEW).select(COLUMNS)
    .eq("user_id", userId).eq("local_date", localDate).maybeSingle();
  if (error) throw error;
  return data ? dayEnergyFromRow(data as Row, localDate) : null;
}

/** One date through the privileged boundary (§2.2 rule 3), bound by `p_user_id`. */
export async function dayEnergyPrivileged(
  admin: SupabaseClient, userId: string, localDate: string,
): Promise<DayEnergy | null> {
  const { data, error } = await admin.rpc("get_daily_energy",
    { p_user_id: userId, p_local_date: localDate });
  if (error) throw error;
  const row = (data as Row[] | null)?.[0];
  return row ? dayEnergyFromRow(row, localDate) : null;
}

/** The selected energy as the `energy_kcal` entry of a day's nutrient totals; null when unknown. */
export function energyNutrientTotal(day: DayEnergy | null): NutrientTotal | null {
  if (!day || day.kcal === null) return null;
  return { code: "energy_kcal", amount: day.kcal, unit: NUTRIENT_UNITS.energy_kcal,
    itemsWithValue: day.itemsWithValue, itemsTotal: day.itemsTotal, coverage: day.coverage };
}
