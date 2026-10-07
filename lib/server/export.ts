/**
 * Streaming, user-scoped export for kind=meals and kind=progress (Phase 2 spec, "API changes";
 * architecture §4.6). RLS does the tenancy work on a session client; the user_id filter is kept
 * anyway so the same function is safe under an admin client.
 *
 * Paging is keyset over (local_date, eaten_at, id), not offset, so a 12,000-row log exports with
 * no gap and no duplicate while the user keeps logging. Progress pages by `local_date` with a row cap of
 * (limit+1) × 20 (one row per nutrient code per date), so a full-history export never loads more
 * than one page of `daily_totals` rows.
 */

import { massOf } from "@/lib/log/mass";
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import { ODBL_NOTICE } from "@/lib/export/csv";
import { isNutrientCode, NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";
import { snapshotValue, type Snapshot } from "@/lib/nutrients/snapshot";
import { itemEnergy, type EnergySourceMix } from "@/lib/nutrients/energy";
import { microCoverage, type NutrientTotal } from "@/lib/nutrients/totals";
import { dayTypeFor } from "@/lib/plan";
import { readDailyEnergy, type DayEnergy } from "@/lib/server/day-energy";
import { decodeTextCursor, encodeTextCursor } from "@/lib/server/export-cursor";
import { targetsFromProfile } from "@/lib/server/targets";
import { streamWater, WATER_COLUMNS, waterRowValues } from "@/lib/server/export-water";
import type { WaterExportRow } from "@/lib/server/export-water";
import { settingsProfileFromRow, type UserSettingsProfileRow } from "@/lib/sync/user-settings";
import type { TargetProfile } from "@/lib/api-types";
import type { DayType, Macros, Settings } from "@/lib/types";
import { recipeNutritionStatus } from "@/lib/recipes/nutrients";
import { entryDaysInWindow, judgePartialItems, type EntryDay } from "@/lib/server/log-recipe-coverage";
import { readByDateChunks } from "@/lib/server/date-chunks";

// Kept on this module as the one import site every export kind is read from, even where the
// implementation lives elsewhere: water outgrew the 400-line house limit (T6 audit, P2), and the
// text cursor is shared by these two files without a value cycle between them.
export { decodeTextCursor, encodeTextCursor };
export { streamWater, WATER_COLUMNS, waterRowValues };
export type { WaterExportRow };

export type Nutr = { energy_kcal: number | null; protein_g: number | null;
  carbohydrate_g: number | null; fat_g: number | null; fiber_g: number | null };

/** Which energy field supplied `energy_kcal` (lib/nutrients/energy.ts); null when unknown. */
type EnergyProvenance = { energy_kcal_source: EnergySourceMix };

export type MealExportRow = Nutr & EnergyProvenance & { local_date: string; eaten_at: string; tz: string;
  slot: string; entry_id: string; item_seq: number; food_name: string; brand: string | null;
  source: string; source_version: string; food_revision_id: number | null;
  /** null: an unknown mass (t17) — the qty and unit are the amount. Never exported as 0. */
  qty: number; unit: string; grams: number | null; note: string | null;
  /** "true" when the item is a saved recipe whose nutrition is only partly measured (#21). */
  nutrition_partial: "true" | "false" };

export type ProgressExportRow = Nutr & EnergyProvenance & { local_date: string; day_type: DayType;
  target_revision: number | null; kcal_target: number | null;
  micro_coverage_pct: number; items_logged: number;
  /** Items that day logged from a partly measured recipe (#21): its kcal counts them partially. */
  partial_recipe_items: number };

export type ExportJson<T> = { rows: T[]; next_cursor: string | null; notices: string[] };
export type ExportCursor = { local_date: string; eaten_at: string; id: string };
export type ExportOpts = { from?: string; to?: string; limit: number; cursor?: string };

export const MEAL_COLUMNS = ["local_date", "eaten_at", "tz", "slot", "entry_id", "item_seq",
  "food_name", "brand", "source", "source_version", "food_revision_id", "qty", "unit", "grams",
  "energy_kcal", "energy_kcal_source", "protein_g", "carbohydrate_g", "fat_g", "fiber_g", "note",
  "nutrition_partial"];

export const PROGRESS_COLUMNS = ["local_date", "day_type", "target_revision", "kcal_target", "energy_kcal",
  "energy_kcal_source", "protein_g", "carbohydrate_g", "fat_g", "fiber_g", "micro_coverage_pct", "items_logged",
  "partial_recipe_items"];

export type RecipeExportRow = Nutr & { recipe_id: string; name: string; revision_rev: number;
  created_at: string; servings: number; seq: number; food_ref_id: string; description: string;
  grams: number;
  /** The revision's stored coverage, and whether its per-serving figures are whole (#21). */
  nutrition_coverage: number; nutrition_complete: boolean };
export type FavoriteExportRow = { kind: string; id: string; name: string; sort: number;
  added_at: string };

export const RECIPE_COLUMNS = ["recipe_id", "name", "revision_rev", "created_at", "servings",
  "seq", "food_ref_id", "description", "grams", "energy_kcal", "protein_g", "carbohydrate_g",
  "fat_g", "fiber_g", "nutrition_coverage", "nutrition_complete"];
export const FAVORITE_COLUMNS = ["kind", "id", "name", "sort", "added_at"];

function values(columns: string[], row: object): (string | number | null)[] {
  return columns.map((c) => (row as Record<string, string | number | null>)[c] ?? null);
}

export function recipeRowValues(row: RecipeExportRow) {
  return values(RECIPE_COLUMNS, { ...row, nutrition_complete: String(row.nutrition_complete) });
}
export function favoriteRowValues(row: FavoriteExportRow) { return values(FAVORITE_COLUMNS, row); }

export function encodeCursor(cursor: ExportCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): ExportCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(422, "bad_request", "malformed cursor");
  }
  const c = parsed as Partial<ExportCursor>;
  if (typeof c?.local_date !== "string" || typeof c?.eaten_at !== "string"
    || typeof c?.id !== "string") {
    throw new HttpError(422, "bad_request", "malformed cursor");
  }
  return { local_date: c.local_date, eaten_at: c.eaten_at, id: c.id };
}

export function mealRowValues(row: MealExportRow): (string | number | null)[] {
  return MEAL_COLUMNS.map((c) => (row as unknown as Record<string, string | number | null>)[c]);
}

export function progressRowValues(row: ProgressExportRow): (string | number | null)[] {
  return PROGRESS_COLUMNS.map((c) =>
    (row as unknown as Record<string, string | number | null>)[c]);
}

function amount(snapshot: Snapshot, code: NutrientCode): number | null {
  return snapshotValue(snapshot, code)?.amount ?? null;
}

function provenance(snapshot: Snapshot): { source: string; source_version: string } {
  for (const key of Object.keys(snapshot)) {
    if (!isNutrientCode(key)) continue;
    const value = snapshotValue(snapshot, key);
    if (value) return { source: value.source, source_version: value.source_version };
  }
  return { source: "", source_version: "" };
}

type EntryRow = { id: string; local_date: string; eaten_at: string; tz: string; slot: string;
  note: string | null; log_items: { seq: number; qty: number; unit: string; grams: number | null;
    food_ref_id: string; food_revision_id: number | null; snapshot: Snapshot;
    nutrition_partial?: boolean | null }[] };

function applyWindow<T>(q: T, opts: ExportOpts): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = q as any;
  if (opts.from) query = query.gte("local_date", opts.from);
  if (opts.to) query = query.lte("local_date", opts.to);
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    query = query.or([`local_date.gt.${c.local_date}`,
      `and(local_date.eq.${c.local_date},eaten_at.gt.${c.eaten_at})`,
      `and(local_date.eq.${c.local_date},eaten_at.eq.${c.eaten_at},id.gt.${c.id})`].join(","));
  }
  return query as T;
}

/** food_ref_id → display name and brand, for the page's refs only. */
async function namesFor(client: SupabaseClient, refIds: string[]) {
  const names = new Map<string, { food_name: string; brand: string | null }>();
  if (refIds.length === 0) return names;
  const refs = await client.from("food_refs")
    .select("id, catalog_food_id, user_food_id, user_foods(name, brand)").in("id", refIds);
  if (refs.error) throw refs.error;

  const catalogIds = (refs.data ?? []).map((r) => r.catalog_food_id as number | null)
    .filter((v): v is number => v != null);
  const byCatalogId = new Map<number, { description: string; brand: string | null }>();
  if (catalogIds.length > 0) {
    const revs = await client.from("catalog_food_revisions")
      .select("catalog_food_id, description, brand").in("catalog_food_id", catalogIds)
      .eq("is_active", true);
    if (revs.error) throw revs.error;
    for (const r of revs.data ?? []) {
      byCatalogId.set(r.catalog_food_id as number,
        { description: r.description as string, brand: (r.brand as string | null) ?? null });
    }
  }
  for (const ref of refs.data ?? []) {
    const own = (ref as unknown as { user_foods?: { name: string; brand: string | null } | null })
      .user_foods;
    const cat = ref.catalog_food_id == null
      ? undefined : byCatalogId.get(ref.catalog_food_id as number);
    names.set(ref.id as string, {
      food_name: own?.name ?? cat?.description ?? "(unknown food)",
      brand: own?.brand ?? cat?.brand ?? null });
  }
  return names;
}

export async function streamMeals(
  client: SupabaseClient, userId: string, opts: ExportOpts
): Promise<ExportJson<MealExportRow>> {
  const base = client.from("log_entries")
    .select("id, local_date, eaten_at, tz, slot, note, " +
      "log_items(seq, qty, unit, grams, food_ref_id, food_revision_id, snapshot, nutrition_partial)")
    .eq("user_id", userId).is("deleted_at", null);
  const { data, error } = await applyWindow(base, opts)
    .order("local_date", { ascending: true }).order("eaten_at", { ascending: true })
    .order("id", { ascending: true }).limit(opts.limit + 1);
  if (error) throw error;

  const entries = (data ?? []) as unknown as EntryRow[];
  const hasMore = entries.length > opts.limit;
  const page = hasMore ? entries.slice(0, opts.limit) : entries;
  const refIds = [...new Set(page.flatMap((e) => e.log_items.map((i) => i.food_ref_id)))];
  const ordered = page.flatMap((entry) => [...entry.log_items].sort((a, b) => a.seq - b.seq));
  const [names, judged] = await Promise.all([namesFor(client, refIds),
    // #21: a partly measured recipe's numbers are exported, and said to be partial — from the
    // item's recorded flag, else the recipe's current revision (rows before 20261210090400).
    judgePartialItems(client, ordered, { onError: "throw", userId })]);
  const partial = new Set(ordered.filter((_, index) => judged[index] !== null));

  const rows: MealExportRow[] = [];
  const notices = new Set<string>();
  for (const entry of page) {
    for (const item of [...entry.log_items].sort((a, b) => a.seq - b.seq)) {
      const snapshot = (item.snapshot ?? {}) as Snapshot;
      const { source, source_version } = provenance(snapshot);
      if (source === "off") notices.add(ODBL_NOTICE);
      const name = names.get(item.food_ref_id);
      const energy = itemEnergy(snapshot);
      rows.push({ local_date: entry.local_date, eaten_at: entry.eaten_at, tz: entry.tz,
        slot: entry.slot, entry_id: entry.id, item_seq: item.seq,
        food_name: name?.food_name ?? "(unknown food)", brand: name?.brand ?? null,
        source, source_version, food_revision_id: item.food_revision_id,
        qty: Number(item.qty), unit: item.unit, grams: massOf(item.grams),
        energy_kcal: energy?.kcal ?? null, energy_kcal_source: energy?.source ?? null,
        protein_g: amount(snapshot, "protein"),
        carbohydrate_g: amount(snapshot, "carbohydrate"), fat_g: amount(snapshot, "fat_total"),
        fiber_g: amount(snapshot, "fiber_total"), note: entry.note,
        nutrition_partial: partial.has(item) ? "true" : "false" });
    }
  }
  const last = page.at(-1);
  return { rows, notices: [...notices],
    next_cursor: hasMore && last
      ? encodeCursor({ local_date: last.local_date, eaten_at: last.eaten_at, id: last.id })
      : null };
}

export type TotalRow = { local_date: string; nutrient_code: string; amount: number | null;
  items_with_value: number; items_total: number; coverage: number };

/** `targets` is null when the date has no target revision: the export states the gap, it does
 *  not derive a number the revision authority never published. */
export function targetFor(
  localDate: string,
  settings: Settings,
  override: DayType | undefined,
  profile: TargetProfile | null = null,
): { day_type: DayType; targets: Macros | null; target_revision: number | null } {
  const selected = profile ? targetsFromProfile(profile) : null;
  const effectiveSettings = selected?.revision
    ? { ...settings, trainingWeekdays: selected.revision.inputs.trainingWeekdays }
    : settings;
  const day_type = dayTypeFor(localDate, override, effectiveSettings);
  const category = day_type === "rest" ? "rest" : "training";
  return { day_type, targets: selected?.resolved[category] ?? null,
    target_revision: profile?.rev ?? null };
}

export type ProgressGrouping = {
  byDate: Map<string, Map<NutrientCode, NutrientTotal>>;
  itemsByDate: Map<string, number>;
  /** The raw read hit the cap (there is a sentinel row past it), so at least one more date of
   *  data exists beyond what's returned here — regardless of how many complete dates that left
   *  behind. `streamProgress`'s `cap` assumes exactly `NUTRIENT_CODES.length` rows per date; if a
   *  date ever carries more (finding 85: a future nutrient code added to the catalog but not
   *  mirrored into NUTRIENT_CODES), dropping the one partial last date can still leave exactly
   *  `opts.limit` complete dates, so `dates.length > opts.limit` alone can under-report this. */
  truncated: boolean;
};

/**
 * Group rows by date. When the read came back with more rows than the cap (the sentinel row past
 * it) the last date may be partial, so it is dropped and the caller re-reads it on the next page.
 * Exactly `cap` rows means the data ended there and every date is complete.
 */
export function groupTotalsByDate(rows: TotalRow[], cap: number): ProgressGrouping {
  const byDate = new Map<string, Map<NutrientCode, NutrientTotal>>();
  const itemsByDate = new Map<string, number>();
  for (const row of rows) {
    const code = row.nutrient_code;
    itemsByDate.set(row.local_date, row.items_total);
    if (!isNutrientCode(code)) continue;
    const day = byDate.get(row.local_date) ?? new Map<NutrientCode, NutrientTotal>();
    day.set(code, { code, amount: Number(row.amount ?? 0), unit: NUTRIENT_UNITS[code],
      itemsWithValue: row.items_with_value, itemsTotal: row.items_total,
      coverage: Number(row.coverage) });
    byDate.set(row.local_date, day);
  }
  const truncated = rows.length > cap;
  if (truncated) {
    const last = [...byDate.keys()].sort().at(-1);
    if (last !== undefined) { byDate.delete(last); itemsByDate.delete(last); }
  }
  return { byDate, itemsByDate, truncated };
}

async function loadSettings(client: SupabaseClient, userId: string): Promise<Settings> {
  const row = await client.from("user_settings")
    .select("training_kcal, rest_kcal, protein_g, protein_locked, slot_times, shift_minutes, changed_at, height_cm, birth_year, sex, body_fat_pct, weight_kg, activity_level, goal, training_weekdays, diet_prefs, onboarded_at")
    .eq("user_id", userId).maybeSingle();
  if (row.error) throw row.error;
  return {
    trainingKcal: row.data?.training_kcal ?? null,
    restKcal: row.data?.rest_kcal ?? null,
    proteinG: row.data?.protein_g ?? null,
    proteinLocked: row.data?.protein_locked ?? true,
    slotTimes: (row.data?.slot_times ?? {}) as Settings["slotTimes"],
    shiftMinutes: row.data?.shift_minutes ?? 0,
    changedAt: row.data?.changed_at ?? null,
    ...settingsProfileFromRow((row.data ?? {}) as UserSettingsProfileRow),
  };
}

async function loadOverrides(client: SupabaseClient, userId: string, dates: string[]) {
  const overrides = await client.from("plan_days")
    .select("local_date, day_type_override").eq("user_id", userId).in("local_date", dates);
  if (overrides.error) throw overrides.error;
  return new Map((overrides.data ?? []).map((r) =>
    [r.local_date as string, (r.day_type_override ?? undefined) as DayType | undefined]));
}

async function loadTargetProfiles(
  client: SupabaseClient,
  userId: string,
  through: string | undefined,
): Promise<TargetProfile[]> {
  if (!through) return [];
  const rows = await client.from("target_profiles").select("*")
    .eq("user_id", userId).lte("effective_from", through)
    .order("effective_from", { ascending: true }).order("rev", { ascending: true });
  if (rows.error) throw rows.error;
  return (rows.data ?? []) as TargetProfile[];
}

function profileForDate(profiles: TargetProfile[], localDate: string): TargetProfile | null {
  let selected: TargetProfile | null = null;
  for (const profile of profiles) {
    if (profile.effective_from > localDate) break;
    selected = profile;
  }
  return selected;
}

/** One row per local date: the day's totals against the day's target. */
const addDaysTo = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayAfter = (date: string) => addDaysTo(date, 1);

/** The account's first or last logged date (non-deleted entries); undefined when none. */
async function loggedEdge(client: SupabaseClient, userId: string, ascending: boolean) {
  const { data, error } = await client.from("log_entries").select("local_date")
    .eq("user_id", userId).is("deleted_at", null)
    .order("local_date", { ascending }).limit(1);
  if (error) throw error;
  return (data?.[0] as { local_date?: string } | undefined)?.local_date;
}

/**
 * The dates one progress page holds, and whether more follow. Every daily_totals date is a logged
 * date, and a logged day can have no daily_totals row at all (only empty snapshots), so the LOGGED
 * dates decide the page. They are read in date windows (lib/server/date-chunks.ts: a full window
 * splits, never truncates), walking forward only until the page is full plus one.
 */
async function progressPageDates(client: SupabaseClient, userId: string, opts: ExportOpts):
  Promise<{ page: string[]; hasMore: boolean }> {
  const from = opts.cursor ? dayAfter(decodeCursor(opts.cursor).local_date)
    : opts.from ?? await loggedEdge(client, userId, true);
  const to = opts.to ?? await loggedEdge(client, userId, false);
  if (!from || !to || from > to) return { page: [], hasMore: false };
  const found = new Set<string>();
  for (let start = from; start <= to && found.size <= opts.limit; start = addDaysTo(start, 31)) {
    const end = addDaysTo(start, 30) < to ? addDaysTo(start, 30) : to;
    const rows = await readByDateChunks<{ local_date: string }>(start, end, async (a, z) => {
      const { data, error } = await client.from("log_entries").select("local_date")
        .eq("user_id", userId).is("deleted_at", null).gte("local_date", a).lte("local_date", z)
        .order("local_date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as { local_date: string }[];
    });
    for (const row of rows) found.add(row.local_date);
  }
  const sorted = [...found].sort();
  return { page: sorted.slice(0, opts.limit), hasMore: sorted.length > opts.limit };
}

/** daily_totals rows for [from, to], read in date windows so the row cap never cuts a day. */
async function readTotalsWindow(client: SupabaseClient, userId: string, from: string, to: string) {
  return readByDateChunks<TotalRow>(from, to, async (a, z) => {
    const { data, error } = await client.from("daily_totals")
      .select("local_date, nutrient_code, amount, items_with_value, items_total, coverage")
      .eq("user_id", userId).gte("local_date", a).lte("local_date", z)
      .order("local_date", { ascending: true });
    if (error) throw error;
    return (data ?? []) as TotalRow[];
  }, 31);
}

export async function streamProgress(
  client: SupabaseClient, userId: string, opts: ExportOpts
): Promise<ExportJson<ProgressExportRow>> {
  // Review round 10: the page is chosen from logged dates first, then exactly those dates' totals
  // and entry counts are read — both in date windows — so no day can be cut off and exported with
  // null macros, and the cursor follows the page.
  const { page, hasMore } = await progressPageDates(client, userId, opts);
  const [totalRows, logged] = page.length === 0
    ? [[] as TotalRow[], { days: new Map<string, EntryDay>() }]
    : await Promise.all([readTotalsWindow(client, userId, page[0], page.at(-1)!),
      entryDaysInWindow(client, userId, page[0], page.at(-1)!, "throw")]);
  const { byDate, itemsByDate } = groupTotalsByDate(totalRows, Number.POSITIVE_INFINITY);

  const [settings, overrideByDate, targetProfiles, energyByDate] = await Promise.all([
    loadSettings(client, userId),
    loadOverrides(client, userId, page),
    loadTargetProfiles(client, userId, page.at(-1)),
    // The day's calories are the per-item selected energy, not daily_totals' reported-only row.
    page.length === 0 ? new Map<string, DayEnergy>()
      : readDailyEnergy(client, userId, page[0], page.at(-1)!),
  ]);

  const rows: ProgressExportRow[] = page.map((local_date) => {
    const totals = byDate.get(local_date) ?? new Map<NutrientCode, NutrientTotal>();
    const { day_type, targets, target_revision } = targetFor(
      local_date,
      settings,
      overrideByDate.get(local_date),
      profileForDate(targetProfiles, local_date),
    );
    const get = (code: NutrientCode) => totals.get(code)?.amount ?? null;
    const energy = energyByDate.get(local_date);
    return { local_date, day_type, target_revision, kcal_target: targets?.kcal ?? null,
      energy_kcal: energy?.kcal ?? null, energy_kcal_source: energy?.source ?? null,
      protein_g: get("protein"),
      carbohydrate_g: get("carbohydrate"), fat_g: get("fat_total"), fiber_g: get("fiber_total"),
      micro_coverage_pct: microCoverage(totals).pct,
      items_logged: itemsByDate.get(local_date) ?? logged.days.get(local_date)?.items ?? 0,
      partial_recipe_items: logged.days.get(local_date)?.partial ?? 0 };
  });
  const last = page.at(-1);
  return { rows, notices: [],
    next_cursor: hasMore && last ? encodeCursor({ local_date: last, eaten_at: "", id: "" }) : null };
}

/** food_ref_id → the food's display name and the source it came from (for the ODbL notice). */
async function refDetails(client: SupabaseClient, refIds: string[]) {
  const out = new Map<string, { description: string; source: string }>();
  if (refIds.length === 0) return out;
  const refs = await client.from("food_refs")
    .select("id, catalog_food_id, user_food_id, user_foods(name)").in("id", refIds);
  if (refs.error) throw refs.error;
  const catalogIds = (refs.data ?? []).map((r) => r.catalog_food_id as number | null)
    .filter((v): v is number => v != null);
  const byId = new Map<number, { description: string; source: string }>();
  if (catalogIds.length > 0) {
    const [revs, foods] = await Promise.all([
      client.from("catalog_food_revisions").select("catalog_food_id, description")
        .in("catalog_food_id", catalogIds).eq("is_active", true),
      client.from("catalog_foods").select("id, source").in("id", catalogIds),
    ]);
    if (revs.error) throw revs.error;
    if (foods.error) throw foods.error;
    const sources = new Map((foods.data ?? []).map((f) => [f.id as number, f.source as string]));
    for (const r of revs.data ?? []) {
      byId.set(r.catalog_food_id as number, { description: r.description as string,
        source: sources.get(r.catalog_food_id as number) ?? "" });
    }
  }
  for (const ref of refs.data ?? []) {
    const own = (ref as unknown as { user_foods?: { name: string } | null }).user_foods;
    const cat = ref.catalog_food_id == null ? undefined : byId.get(ref.catalog_food_id as number);
    out.set(ref.id as string, { description: own?.name ?? cat?.description ?? "(unknown food)",
      source: own ? "user" : cat?.source ?? "" });
  }
  return out;
}

/** One row per revision item, every revision, so an edit's history exports with it. */
export async function streamRecipes(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<RecipeExportRow>> {
  let query = client.from("recipes")
    .select("id, name, servings, recipe_revisions(id, rev, created_at, nutrients_per_serving, " +
      "recipe_items(seq, grams, food_ref_id))")
    .eq("user_id", userId).is("deleted_at", null);
  if (opts.cursor) query = query.gt("id", decodeTextCursor(opts.cursor));
  const { data, error } = await query.order("id", { ascending: true }).limit(opts.limit + 1);
  if (error) throw error;

  type Rev = { rev: number; created_at: string; nutrients_per_serving: Record<string, number | null>;
    recipe_items: { seq: number; grams: number; food_ref_id: string }[] };
  type Recipe = { id: string; name: string; servings: number; recipe_revisions: Rev[] };
  const all = (data ?? []) as unknown as Recipe[];
  const hasMore = all.length > opts.limit;
  const page = hasMore ? all.slice(0, opts.limit) : all;
  const details = await refDetails(client, [...new Set(page.flatMap((r) =>
    r.recipe_revisions.flatMap((v) => v.recipe_items.map((i) => i.food_ref_id))))]);

  const rows: RecipeExportRow[] = [];
  const notices = new Set<string>();
  for (const recipe of page) {
    for (const revision of [...recipe.recipe_revisions].sort((a, b) => a.rev - b.rev)) {
      const n = revision.nutrients_per_serving ?? {};
      const status = recipeNutritionStatus(n);
      for (const item of [...revision.recipe_items].sort((a, b) => a.seq - b.seq)) {
        const detail = details.get(item.food_ref_id);
        if (detail?.source === "off") notices.add(ODBL_NOTICE);
        rows.push({ recipe_id: recipe.id, name: recipe.name, revision_rev: revision.rev,
          created_at: revision.created_at, servings: Number(recipe.servings), seq: item.seq,
          food_ref_id: item.food_ref_id, description: detail?.description ?? "(unknown food)",
          grams: Number(item.grams),
          energy_kcal: n.energy_kcal ?? null, protein_g: n.protein ?? null,
          carbohydrate_g: n.carbohydrate ?? null, fat_g: n.fat_total ?? null,
          fiber_g: n.fiber_total ?? null,
          nutrition_coverage: status.coverage, nutrition_complete: status.nutritionComplete });
      }
    }
  }
  const last = page.at(-1);
  return { rows, notices: [...notices],
    next_cursor: hasMore && last ? encodeTextCursor(last.id) : null };
}

export async function streamFavorites(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<FavoriteExportRow>> {
  // added_at reads created_at, not updated_at: a re-sort touches updated_at on every one of these
  // rows, and "date added" must not move just because the user reordered the strip (contracts §3).
  const [foods, recipes, meals] = await Promise.all([
    client.from("favorites_foods").select("food_ref_id, sort, created_at")
      .eq("user_id", userId).is("deleted_at", null),
    client.from("favorites_recipes").select("recipe_id, sort, created_at, recipes(name)")
      .eq("user_id", userId).is("deleted_at", null),
    client.from("favorites_meals").select("id, name, sort, created_at")
      .eq("user_id", userId).is("deleted_at", null),
  ]);
  for (const result of [foods, recipes, meals]) if (result.error) throw result.error;

  const details = await refDetails(client,
    (foods.data ?? []).map((f) => f.food_ref_id as string));
  const notices = new Set<string>();
  const all: FavoriteExportRow[] = [
    ...(foods.data ?? []).map((f) => {
      const detail = details.get(f.food_ref_id as string);
      if (detail?.source === "off") notices.add(ODBL_NOTICE);
      return { kind: "food", id: f.food_ref_id as string,
        name: detail?.description ?? "(unknown food)", sort: Number(f.sort),
        added_at: f.created_at as string };
    }),
    ...(recipes.data ?? []).map((r) => ({ kind: "recipe", id: r.recipe_id as string,
      name: (r as unknown as { recipes?: { name: string } | null }).recipes?.name ?? "(recipe)",
      sort: Number(r.sort), added_at: r.created_at as string })),
    ...(meals.data ?? []).map((m) => ({ kind: "meal", id: m.id as string, name: m.name as string,
      sort: Number(m.sort), added_at: m.created_at as string })),
  ].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));

  const after = opts.cursor ? decodeTextCursor(opts.cursor) : "";
  const remaining = all.filter((row) => `${row.kind}:${row.id}` > after);
  const hasMore = remaining.length > opts.limit;
  const rows = remaining.slice(0, opts.limit);
  const last = rows.at(-1);
  return { rows, notices: [...notices],
    next_cursor: hasMore && last ? encodeTextCursor(`${last.kind}:${last.id}`) : null };
}
