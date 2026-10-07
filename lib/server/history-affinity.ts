/**
 * The account's own occasion history, read for its meal snapshot (Phase 17 O2, D1 and D3).
 *
 * Tenancy (D3): every read runs on the caller's own client (RLS) with an explicit `user_id` filter
 * on `log_entries`, live rows only (`deleted_at is null`), stamped rows only (`occasion is not
 * null`; old rows stay null and are never guessed), over a bounded 90-day window read in date
 * chunks (lib/server/date-chunks.ts) so the row cap can never drop days. Items are read through
 * their parent's RLS by entry id and only `entry_id, food_ref_id` are selected.
 *
 * Output: per snapshot food, per occasion, a score (lib/meals/history.ts) and a watermark that
 * moves when any counted entry is added, edited, moved or deleted. Never notes, times, amounts or
 * items. Nothing here is written anywhere: not `food_facets`, not a shared cache, not telemetry.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { historyScores, historyWindowStart, type HistoryLog, type HistoryScores } from "@/lib/meals/history";
import { OCCASIONS, type Occasion } from "@/lib/meals/occasion";
import { readByDateChunks, ROW_CAP } from "@/lib/server/date-chunks";

/** A snapshot food and the identities its logs may carry. */
export type HistoryFood = {
  id: string;
  userRefId: string | null;
  catalogRefId: string | null;
  userFoodId: string | null;
  catalogFoodId: number | null;
};

type EntryRow = { id: string; local_date: string; occasion: string; rev: number };
type ItemRow = { entry_id: string; food_ref_id: string };
type RefRow = { id: string; kind: string; catalog_food_id: number | null; user_food_id: string | null };

const ID_BATCH = 100;

async function readEntries(client: SupabaseClient, userId: string, from: string, to: string): Promise<EntryRow[]> {
  return readByDateChunks(from, to, async (start, end) => {
    const { data, error } = await client.from("log_entries").select("id,local_date,occasion,rev")
      .eq("user_id", userId).is("deleted_at", null).not("occasion", "is", null)
      .gte("local_date", start).lte("local_date", end);
    if (error) throw error;
    return (data ?? []) as EntryRow[];
  });
}

/** Items for a set of entries, split further whenever a batch meets the row cap. */
async function readItems(client: SupabaseClient, ids: readonly string[]): Promise<ItemRow[]> {
  if (!ids.length) return [];
  if (ids.length > ID_BATCH) {
    const out: ItemRow[] = [];
    for (let i = 0; i < ids.length; i += ID_BATCH) out.push(...await readItems(client, ids.slice(i, i + ID_BATCH)));
    return out;
  }
  const { data, error } = await client.from("log_items").select("entry_id,food_ref_id").in("entry_id", [...ids]);
  if (error) throw error;
  const rows = (data ?? []) as ItemRow[];
  if (rows.length < ROW_CAP) return rows;
  if (ids.length === 1) throw new Error(`More than ${ROW_CAP - 1} items on one entry; refusing to truncate`);
  const middle = Math.ceil(ids.length / 2);
  return [...await readItems(client, ids.slice(0, middle)), ...await readItems(client, ids.slice(middle))];
}

async function readRefs(client: SupabaseClient, ids: readonly string[]): Promise<RefRow[]> {
  const out: RefRow[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const { data, error } = await client.from("food_refs").select("id,kind,catalog_food_id,user_food_id")
      .in("id", ids.slice(i, i + ID_BATCH));
    if (error) throw error;
    out.push(...((data ?? []) as RefRow[]));
  }
  return out;
}

const isOccasion = (value: string): value is Occasion => (OCCASIONS as readonly string[]).includes(value);

/**
 * The (food, occasion, date) triples for this account's current snapshot foods. A logged ref maps
 * to a snapshot food by the ref itself, or by the own food row or catalog food it names.
 */
export async function readOccasionHistory(
  client: SupabaseClient, userId: string, foods: readonly HistoryFood[], today: string,
): Promise<{ logs: HistoryLog[]; watermark: string }> {
  const entries = (await readEntries(client, userId, historyWindowStart(today), today))
    .filter((row) => isOccasion(row.occasion));
  const watermark = createHash("sha256").update(entries
    .map((row) => `${row.id}:${row.rev}:${row.occasion}:${row.local_date}`).sort().join("\n"))
    .digest("hex").slice(0, 32);
  if (!entries.length || !foods.length) return { logs: [], watermark };
  const byRef = new Map<string, string>();
  const byUserFood = new Map<string, string>();
  const byCatalog = new Map<number, string>();
  for (const food of [...foods].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (food.userRefId && !byRef.has(food.userRefId)) byRef.set(food.userRefId, food.id);
    if (food.catalogRefId && !byRef.has(food.catalogRefId)) byRef.set(food.catalogRefId, food.id);
    if (food.userFoodId && !byUserFood.has(food.userFoodId)) byUserFood.set(food.userFoodId, food.id);
    if (food.catalogFoodId !== null && !byCatalog.has(food.catalogFoodId)) byCatalog.set(food.catalogFoodId, food.id);
  }
  const items = await readItems(client, entries.map((row) => row.id));
  const unknown = [...new Set(items.map((item) => item.food_ref_id).filter((ref) => !byRef.has(ref)))];
  for (const ref of await readRefs(client, unknown)) {
    const food = (ref.user_food_id ? byUserFood.get(ref.user_food_id) : undefined)
      ?? (ref.catalog_food_id !== null ? byCatalog.get(ref.catalog_food_id) : undefined);
    if (food) byRef.set(ref.id, food);
  }
  // The watermark also covers which foods each counted entry holds: an item swap moves it even
  // when the entry's rev did not.
  const itemsMark = createHash("sha256").update(items.map((item) => `${item.entry_id}:${item.food_ref_id}`)
    .sort().join("\n")).digest("hex").slice(0, 16);
  // Only items of this account's own entries read above count, whatever RLS let through.
  const entryById = new Map(entries.map((row) => [row.id, row]));
  const logs: HistoryLog[] = [];
  for (const item of items) {
    const entry = entryById.get(item.entry_id);
    const food = byRef.get(item.food_ref_id);
    if (entry && food) logs.push({ food, occasion: entry.occasion as Occasion, localDate: entry.local_date });
  }
  return { logs, watermark: `${watermark}.${itemsMark}` };
}

/** Scores per snapshot food id, with the watermark for the snapshot's `inputsHash`. */
export async function historyAffinity(
  client: SupabaseClient, userId: string, foods: readonly HistoryFood[], today: string,
): Promise<{ scores: HistoryScores; watermark: string }> {
  const { logs, watermark } = await readOccasionHistory(client, userId, foods, today);
  return { scores: historyScores(logs, today), watermark };
}
