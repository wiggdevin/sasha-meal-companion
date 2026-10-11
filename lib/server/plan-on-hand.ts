import "server-only";
/**
 * "Use what I have" (Plan-sheet chip `on_hand`): the foods this account has on hand on `date`, by
 * name, each with where it came from. Names only: every one is matched to a food the admission
 * read already allowed (lib/coach/suggest-shape.ts), so a pantry or list line never brings a food
 * past the account's rules, Avoid list or allergens.
 *
 *  - stated: what the person named in the sheet (typed in the box, or read from a photo);
 *  - pantry: confirmed pantry rows inside their 14-day box (`source = 'photo'` → "pantry photo"),
 *    less a row set to 0 g: that is how a person says it is used up (audit P03); an unknown
 *    amount (null) still counts;
 *  - list: shopping lines of a live period whose line box reaches `date` and that D7 counts as
 *    used (checked, a checked purchase window, or a manual line). Lines store no eaten state; a
 *    line that was bought and then eaten still counts until its box ends, the same rule shopping
 *    focus already uses.
 *
 * Pantry and lists exist only for accounts with Shopping access (`recipeAccessEnabled`); a failed
 * read is "nothing known on hand" from that source, never an error for the chip.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OnHandEntry } from "@/lib/coach/suggest-shape";
import { fetchAllChunked, fetchAllRows } from "@/lib/server/paged-read";
import { recipeAccessEnabled } from "@/lib/server/recipe-access";
import { addDays } from "@/lib/recipes-hub/put-in-meal";
import {
  LINE_BOX_EXTRA_DAYS, PANTRY_BOX_DAYS, lineActiveOn, pantryActiveOn, pantryAmountCounts,
} from "@/lib/shopping/focus";

type PantryRow = { name: string; confirmed_at: string; source: string | null;
  confirmed_grams: number | string | null };
type PeriodRow = { id: string; start_date: string; end_date: string };
type LineRow = { id: string; period_id: string; name: string; checked: boolean; origin: "plan" | "manual" };
type WindowRow = { line_id: string };

export async function readOnHand(client: SupabaseClient, userId: string,
  day: { date: string; zone: string }, stated: readonly string[] = []): Promise<OnHandEntry[]> {
  const entries: OnHandEntry[] = stated.map((name) => ({ name, source: "stated" as const }));
  if (!recipeAccessEnabled(userId)) return entries;
  const [pantry, lines] = await Promise.all([
    readPantry(client, userId, day).catch(logged("pantry")),
    readLines(client, userId, day.date).catch(logged("lines")),
  ]);
  return [...entries, ...pantry, ...lines];
}

function logged(what: string) {
  return (error: unknown): OnHandEntry[] => {
    console.warn(`plan-on-hand: ${what} read failed: ${error instanceof Error ? error.message : "unknown"}`);
    return [];
  };
}

async function readPantry(client: SupabaseClient, userId: string,
  day: { date: string; zone: string }): Promise<OnHandEntry[]> {
  const since = `${addDays(day.date, -PANTRY_BOX_DAYS - 1)}T00:00:00Z`;
  const rows = await fetchAllRows<PantryRow>((from, to) => client.from("shopping_pantry")
    .select("name,confirmed_at,source,confirmed_grams").eq("user_id", userId).is("deleted_at", null)
    .gte("confirmed_at", since).order("id").range(from, to));
  return rows.filter((row) => pantryAmountCounts(row.confirmed_grams)
    && pantryActiveOn({ confirmedAt: row.confirmed_at }, day.date, day.zone))
    .map((row) => ({ name: row.name, source: row.source === "photo" ? "pantry_photo" as const : "pantry" as const }));
}

async function readLines(client: SupabaseClient, userId: string, date: string): Promise<OnHandEntry[]> {
  const periods = await fetchAllRows<PeriodRow>((from, to) => client.from("shopping_periods")
    .select("id,start_date,end_date").eq("user_id", userId).is("deleted_at", null)
    .lte("start_date", date).gte("end_date", addDays(date, -LINE_BOX_EXTRA_DAYS))
    .order("id").range(from, to));
  if (periods.length === 0) return [];
  const ids = periods.map((row) => row.id);
  const [lines, windows] = await Promise.all([
    fetchAllChunked<string, LineRow>(ids, (batch, from, to) => client.from("shopping_lines")
      .select("id,period_id,name,checked,origin").eq("user_id", userId).is("deleted_at", null)
      .in("period_id", batch).order("id").range(from, to)),
    fetchAllChunked<string, WindowRow>(ids, (batch, from, to) => client.from("shopping_purchase_windows")
      .select("line_id").eq("user_id", userId).is("deleted_at", null).eq("checked", true)
      .in("period_id", batch).order("id").range(from, to)),
  ]);
  const byId = new Map(periods.map((row) => [row.id, { startDate: row.start_date, endDate: row.end_date }]));
  const checkedWindows = new Set(windows.map((row) => row.line_id));
  return lines.filter((line) => {
    const period = byId.get(line.period_id);
    return period !== undefined && lineActiveOn({ checked: line.checked === true, origin: line.origin },
      period, date, checkedWindows.has(line.id));
  }).map((line) => ({ name: line.name, source: "list" as const }));
}
