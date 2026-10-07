/**
 * The store behind `POST /api/foods/signals` (Phase 18 W6). One call of `record_food_signals`
 * (migration 20261219090000) with the caller's own session client: security invoker, so RLS stores
 * every row under `auth.uid()` and nothing else. The function skips an event outside its slate or
 * its clock window (rejected) and a repeated `client_event_id` (duplicate), so a retry never
 * double-inserts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { dbFood } from "@/lib/food-db";
import { SIGNAL_EVENTS_MAX, SIGNAL_SLATE_MAX, signalRow, type FoodSignalEvent } from "@/lib/foods/signals";
import { readByIdBatches } from "@/lib/server/date-chunks";
import { parseFoodKey } from "@/lib/meals/food-key";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a key names a food the app can have issued: a catalog id, an account food uuid, or a
 * bundled food id that exists (lib/food-db.json, which holds every universe item). A
 * `food:<words>` key naming no bundled food is refused, so no hyphenated free text is stored.
 * Server-only: the phone contract (lib/foods/signals.ts) never loads the food table.
 */
export function issuedFoodKey(key: string): boolean {
  const parsed = parseFoodKey(key);
  if (!parsed) return false;
  if (parsed.kind === "catalog") return true;
  return UUID.test(parsed.id) || dbFood(parsed.id) !== undefined;
}

/**
 * Ids in the one owner read: every key a valid batch can carry (20 events of 8 keys), so a batch
 * is never split into a second round trip. 160 uuids keep the request line near 6 KB.
 */
const OWNER_READ_IDS = SIGNAL_EVENTS_MAX * SIGNAL_SLATE_MAX;

/** The `user_foods.id` a `food:<uuid>` key names (lower-cased), or null for any other key. */
function accountFoodId(key: string): string | null {
  const parsed = parseFoodKey(key);
  return parsed?.kind === "food" && UUID.test(parsed.id) ? parsed.id.toLowerCase() : null;
}

/**
 * The key check for a batch of events from `userId`: `issuedFoodKey`, plus every `food:<uuid>` key
 * must be one of the caller's own `user_foods` rows (soft-deleted ones count: an offline-queued tap
 * on a food deleted since is still the caller's food). One owner-scoped read per batch, and none
 * when the batch names no account food. Another account's food and a food that does not exist
 * read the same (absent), so the answer never says whether someone else's id exists. A failed
 * read fails closed: every account-food key is refused and the error code (only) is logged.
 */
export async function ownedFoodKeyCheck(
  client: SupabaseClient, userId: string, events: readonly FoodSignalEvent[],
): Promise<(key: string) => boolean> {
  const ids = [...new Set(events.flatMap((e) => e.offeredKeys).map(accountFoodId)
    .filter((id): id is string => id !== null))];
  if (ids.length === 0) return issuedFoodKey;
  let owned: Set<string>;
  try {
    const rows = await readByIdBatches(ids, async (batch) => {
      const { data, error } = await client.from("user_foods").select("id")
        .eq("user_id", userId).in("id", batch);
      if (error) throw new SignalStoreError(error.code ?? "unknown");
      return (data ?? []) as { id: string }[];
    }, OWNER_READ_IDS);
    owned = new Set(rows.map((row) => String(row.id).toLowerCase()));
  } catch (error) {
    console.warn("food signals: owner check failed; account-food keys refused", {
      code: error instanceof SignalStoreError ? error.code : "unexpected",
    });
    owned = new Set();
  }
  return (key) => {
    if (!issuedFoodKey(key)) return false;
    const id = accountFoodId(key);
    return id === null || owned.has(id);
  };
}

export type SignalStoreResult = { inserted: number; duplicates: number; rejected: number };

export class SignalStoreError extends Error {
  constructor(public readonly code: string) {
    super(`record_food_signals failed (${code})`);
    this.name = "SignalStoreError";
  }
}

export async function recordFoodSignals(
  client: SupabaseClient, events: readonly FoodSignalEvent[],
): Promise<SignalStoreResult> {
  const { data, error } = await client.rpc("record_food_signals", { p_events: events.map(signalRow) });
  if (error) throw new SignalStoreError(error.code ?? "unknown");
  const row = (Array.isArray(data) ? data[0] : data) as Partial<SignalStoreResult> | null;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  const inserted = n(row?.inserted);
  const duplicates = n(row?.duplicates);
  const rejected = n(row?.rejected);
  if (inserted === null || duplicates === null || rejected === null) {
    throw new SignalStoreError("bad_result");
  }
  return { inserted, duplicates, rejected };
}
