import "server-only";
/**
 * Shopping focus on the server (Phase 18 W11, D7): the reads every generator ranks by, and the
 * service-role write and Undo (migration 20261227090000), always for the session user's id, never
 * a value from a request body. The three `user_settings.shopping_focus_*` columns are
 * server-written: a direct client write is refused by a trigger, and the two functions are
 * executable by service_role only. Tenancy canary: tests/tenancy/admin-shopping-focus.test.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { readAccountZone, resolveAccountDay } from "@/lib/server/account-day";
import { fetchAllChunked, fetchAllRows } from "@/lib/server/paged-read";
import { recipeAccessEnabled } from "@/lib/server/recipe-access";
import { isIanaTimeZone } from "@/lib/health/contract";
import { addDays } from "@/lib/recipes-hub/put-in-meal";
import type { FocusRanking } from "@/lib/meals/plate";
import {
  dateIn, defaultFocusEnd, focusKeysFrom, focusRankingOn, LINE_BOX_EXTRA_DAYS, maxFocusEnd,
  PANTRY_BOX_DAYS, shoppingFocusActive, type FocusState,
} from "@/lib/shopping/focus";

/** The account's day and zone for focus: the phone's day when plausible, the stored zone, the
 *  request's zone, UTC last (lib/server/account-day.ts). Never the server's own local date. */
export type FocusDay = { date: string; zone: string };

export async function focusDay(client: SupabaseClient, userId: string,
  hints: { clientDay?: unknown; requestZone?: unknown }, now: Date): Promise<FocusDay> {
  const stored = await readAccountZone(client, userId);
  const requestZone = isIanaTimeZone(hints.requestZone) ? hints.requestZone as string : null;
  const day = resolveAccountDay({ purpose: "shopping-focus", storedZone: stored, requestZone,
    clientDay: hints.clientDay, now });
  return { date: day.date, zone: stored ?? requestZone ?? "UTC" };
}

/** The account's current `shopping_focus_until`, or null when never set. */
export async function getShoppingFocusUntil(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await client.from("user_settings").select("shopping_focus_until")
    .eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const value = (data as { shopping_focus_until?: unknown } | null)?.shopping_focus_until;
  return typeof value === "string" ? value : null;
}

type PeriodRow = { id: string; start_date: string; end_date: string };
type LineRow = { id: string; period_id: string; name: string; checked: boolean; origin: "plan" | "manual" };
type WindowRow = { line_id: string };
type PantryRow = { name: string; confirmed_at: string };

/**
 * The stored end and, while it is active, the D7 keys from today on: used lines of live periods
 * whose line box reaches today (a checked line, a checked purchase window, or a manual line) and
 * confirmed pantry items inside their 14 days. Soft-deleted periods, lines, windows and pantry
 * rows are never read. Every read is owner-filtered and paged; a failed page fails the whole read.
 */
export async function readShoppingFocusState(client: SupabaseClient, userId: string, day: FocusDay,
  now: Date): Promise<FocusState> {
  const until = await getShoppingFocusUntil(client, userId);
  if (!shoppingFocusActive(until, now)) return { until, keys: [] };
  const lastDay = dateIn(until as string, day.zone);
  const periods = await fetchAllRows<PeriodRow>((from, to) => client.from("shopping_periods")
    .select("id,start_date,end_date").eq("user_id", userId).is("deleted_at", null)
    .lte("start_date", lastDay).gte("end_date", addDays(day.date, -LINE_BOX_EXTRA_DAYS))
    .order("id").range(from, to));
  const ids = periods.map((row) => row.id);
  const [lines, windows] = ids.length ? await Promise.all([
    fetchAllChunked<string, LineRow>(ids, (batch, from, to) => client.from("shopping_lines")
      .select("id,period_id,name,checked,origin").eq("user_id", userId).is("deleted_at", null)
      .in("period_id", batch).order("id").range(from, to)),
    fetchAllChunked<string, WindowRow>(ids, (batch, from, to) => client.from("shopping_purchase_windows")
      .select("line_id").eq("user_id", userId).is("deleted_at", null).eq("checked", true)
      .in("period_id", batch).order("id").range(from, to)),
  ]) : [[], []];
  // A day of slack on the instant bound; the box itself is judged on the local date below.
  const since = `${addDays(day.date, -PANTRY_BOX_DAYS - 1)}T00:00:00Z`;
  const pantry = await fetchAllRows<PantryRow>((from, to) => client.from("shopping_pantry")
    .select("name,confirmed_at").eq("user_id", userId).is("deleted_at", null)
    .gte("confirmed_at", since).order("id").range(from, to));
  const keys = focusKeysFrom({
    periods: periods.map((row) => ({ id: row.id, startDate: row.start_date, endDate: row.end_date })),
    lines: lines.map((row) => ({ id: row.id, periodId: row.period_id, name: row.name,
      checked: row.checked === true, origin: row.origin })),
    checkedWindowLineIds: new Set(windows.map((row) => row.line_id)),
    pantry: pantry.map((row) => ({ name: row.name, confirmedAt: row.confirmed_at })),
    zone: day.zone,
  }).filter((row) => row.to >= day.date);
  return { until, keys };
}

/**
 * The coach generators' focus input for `date` (compose_meal, suggest_options): undefined for an
 * account without Shopping access (D7 "Elsewhere these signals are empty"), with focus off, or on
 * any failed read (a ranking preference never fails a suggestion).
 */
export async function focusRankingFor(client: SupabaseClient, userId: string, date: string,
  now: Date = new Date()): Promise<(FocusRanking & { id: string }) | undefined> {
  if (!recipeAccessEnabled(userId)) return undefined;
  try {
    const day = await focusDay(client, userId, { clientDay: date }, now);
    return focusRankingOn(await readShoppingFocusState(client, userId, day, now), date, now, day.zone);
  } catch (error) {
    console.warn(`shopping-focus: read failed: ${error instanceof Error ? error.message : "unknown"}`);
    return undefined;
  }
}

/**
 * D7's default end: the open live shopping period's own end (its last moment in the account's
 * zone), or FOCUS_DEFAULT_DAYS out with none open; `days` (explicit, 1-31) overrides both, still
 * capped at FOCUS_MAX_DAYS out. The server decides this, never the model or the phone.
 */
export async function resolveFocusEnd(
  client: SupabaseClient, userId: string, now: Date, day: FocusDay, days?: number,
): Promise<string> {
  const max = maxFocusEnd(now);
  if (days !== undefined) {
    const requested = new Date(now.getTime() + days * 86_400_000).toISOString();
    return requested > max ? max : requested;
  }
  const { data, error } = await client.from("shopping_periods").select("end_date")
    .eq("user_id", userId).is("deleted_at", null).lte("start_date", day.date).gte("end_date", day.date)
    .order("end_date", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  const openEnd = (data as { end_date?: unknown } | null)?.end_date;
  const resolved = defaultFocusEnd(now, typeof openEnd === "string" ? openEnd : null, day.zone);
  return resolved > max ? max : resolved;
}

export type FocusWrite = { actionId: string; until: string | null; previous: string | null };

type RpcAnswer = { status?: unknown; actionId?: unknown; until?: unknown; previous?: unknown };
const instantOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Writes the server-decided end (null = off) for the session user; returns the write's receipt. */
export async function setShoppingFocus(userId: string, until: string | null): Promise<FocusWrite> {
  const { data, error } = await adminClient().rpc("shopping_focus_set", { p_user_id: userId, p_until: until });
  if (error) throw new HttpError(503, "shopping_focus_unavailable", "That didn't save. Try again.", { cause: error });
  const answer = (data ?? {}) as RpcAnswer;
  if (answer.status === "no_settings") {
    throw new HttpError(409, "settings_missing", "Finish setting up your profile first.");
  }
  if (answer.status !== "applied" || typeof answer.actionId !== "string") {
    throw new HttpError(503, "shopping_focus_unavailable", "That didn't save. Try again.");
  }
  return { actionId: answer.actionId, until: instantOrNull(answer.until), previous: instantOrNull(answer.previous) };
}

export type FocusUndo = { status: "undone" | "superseded"; until: string | null };

/**
 * Undo one write, compare-and-set: the stored previous value comes back only while that write is
 * still the latest; otherwise `superseded`, nothing written.
 */
export async function undoShoppingFocus(userId: string, actionId: string): Promise<FocusUndo> {
  const { data, error } = await adminClient().rpc("shopping_focus_undo", { p_user_id: userId, p_action_id: actionId });
  if (error) throw new HttpError(503, "shopping_focus_unavailable", "That didn't undo. Try again.", { cause: error });
  const answer = (data ?? {}) as RpcAnswer;
  if (answer.status === "undone" || answer.status === "superseded") {
    return { status: answer.status, until: instantOrNull(answer.until) };
  }
  if (answer.status === "no_settings") return { status: "superseded", until: null };
  throw new HttpError(503, "shopping_focus_unavailable", "That didn't undo. Try again.");
}
