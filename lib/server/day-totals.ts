/**
 * The day's nutrient totals, read two ways: through RLS for the caller's own day, and through the
 * privileged boundary for the MCP get_day tool (§2.2 rule 3). Moved out of lib/server/log.ts
 * unchanged (T9 §2) — the readers have no caller in common with the commit path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DayTotals } from "@/lib/log/contract";
import { isNutrientCode, NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";
import { microCoverage, type NutrientTotal } from "@/lib/nutrients/totals";
import { dayEnergy, dayEnergyPrivileged, energyNutrientTotal, type DayEnergy }
  from "@/lib/server/day-energy";

type DailyTotalRow = { nutrient_code: string; amount: number | null;
  items_with_value: number; items_total: number; coverage: number | null };

/**
 * `energy` is the day's `daily_energy` row: its per-item selected sum (lib/nutrients/energy.ts)
 * replaces the reported-only `energy_kcal` sum IN PLACE, so the response keeps the shape and order
 * T9 §2 froze (tests/log/commit-route-move.test.ts). With no usable energy that day the row stays
 * as `daily_totals` has it: amount 0 with itemsWithValue 0 and coverage 0, the contract's existing
 * "measured nothing" form for every nutrient in this list.
 */
function totalsFromRows(rows: DailyTotalRow[], localDate: string, energy: DayEnergy | null): DayTotals {
  const totals = new Map<NutrientCode, NutrientTotal>();
  const selected = energyNutrientTotal(energy);
  for (const row of rows) {
    const code = row.nutrient_code;
    if (!isNutrientCode(code)) continue;
    if (code === "energy_kcal" && selected) { totals.set(code, selected); continue; }
    totals.set(code, { code, amount: Number(row.amount ?? 0), unit: NUTRIENT_UNITS[code],
      itemsWithValue: Number(row.items_with_value ?? 0),
      itemsTotal: Number(row.items_total ?? 0), coverage: Number(row.coverage ?? 0) });
  }
  // Every item's energy came from energy_kcal_calc and none carried an energy_kcal key at all.
  if (selected && !totals.has("energy_kcal")) totals.set("energy_kcal", selected);
  return { local_date: localDate, nutrients: [...totals.values()],
    micro_coverage_pct: microCoverage(totals).pct };
}

export async function dayTotals(
  client: SupabaseClient, userId: string, localDate: string
): Promise<DayTotals> {
  const [{ data, error }, energy] = await Promise.all([
    client.from("daily_totals")
      .select("nutrient_code, amount, items_with_value, items_total, coverage")
      .eq("user_id", userId).eq("local_date", localDate),
    dayEnergy(client, userId, localDate),
  ]);
  if (error) throw error;
  return totalsFromRows((data ?? []) as DailyTotalRow[], localDate, energy);
}

/** Phase 2: real nutrients for the MCP get_day tool, through the privileged boundary (§2.2 rule 3). */
export async function dayTotalsPrivileged(
  admin: SupabaseClient, userId: string, localDate: string
): Promise<DayTotals> {
  const [{ data, error }, energy] = await Promise.all([
    admin.rpc("get_daily_totals", { p_user_id: userId, p_local_date: localDate }),
    dayEnergyPrivileged(admin, userId, localDate),
  ]);
  if (error) throw error;
  return totalsFromRows((data ?? []) as DailyTotalRow[], localDate, energy);
}


/**
 * Each date's privileged totals with the #21 caveats a coach tool must pass on (review round 9):
 * `energy_is_lower_bound` + `partial_recipe_items` when a logged item is a partly measured recipe
 * serving, `nutrition_unchecked` when that check could not run. `dates` must be ascending.
 */
export async function dayTotalsWithCaveats(
  admin: SupabaseClient, userId: string, dates: readonly string[],
): Promise<(DayTotals & Record<string, unknown>)[]> {
  const { dayTotalsCaveats, entryDaysInWindow } = await import("@/lib/server/log-recipe-coverage");
  const [totals, check] = await Promise.all([
    Promise.all(dates.map((date) => dayTotalsPrivileged(admin, userId, date))),
    entryDaysInWindow(admin, userId, dates[0], dates.at(-1)!, "mark")]);
  return totals.map((day, i) => ({ ...day, ...dayTotalsCaveats(check.days.get(dates[i])) }));
}
