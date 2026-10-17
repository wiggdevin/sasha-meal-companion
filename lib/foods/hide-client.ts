/**
 * Hiding a neutral food from Foods › Other (W148). A neutral food has no Favorites or Avoid mark to
 * clear, so "Remove" on its row now hides it for good: the account's `user_foods` row is tombstoned
 * through the ordinary sync `delete` op and Undo is the matching `restore`. Nothing is deleted from
 * the server's history and no migration is involved: `deleted_at` is the stored hidden state. A
 * mark on any food is never touched here (`set_food_membership` is not called), and a food the
 * phone holds no mirrored row for is left to the caller's older path (`false`).
 */
import type { Food } from "@/lib/foods";
import { accountHandle, assertCurrent, isCurrent } from "@/lib/device/account";
import { loadStore, saveStore } from "@/lib/store";
import { getRow } from "@/lib/sync/idb";
import { enqueueWithRow } from "@/lib/sync/outbox";

async function tombstone(food: Food, kind: "delete" | "restore"): Promise<boolean> {
  const h = accountHandle();
  const row = await getRow(h, "user_foods", food.id);
  assertCurrent(h);
  if (!row || typeof row.rev !== "number" || !Number.isSafeInteger(row.rev)) return false;
  const now = new Date().toISOString();
  await enqueueWithRow(h, { ...row, deleted_at: kind === "delete" ? now : null, rev: row.rev + 1, updated_at: now }, {
    op_id: crypto.randomUUID(), entity: "user_foods", entity_id: food.id,
    kind, base_rev: row.rev, payload: {}, client_ts: now,
  });
  if (!isCurrent(h)) return true;
  const store = loadStore();
  if (kind === "delete") {
    const { [food.id]: _hidden, ...foods } = store.foods;
    saveStore({ ...store, foods });
  } else {
    saveStore({ ...store, foods: { ...store.foods, [food.id]: { ...food, updatedAt: now } } });
  }
  return true;
}

/** True when this phone holds the synced row `hideFood` would tombstone. */
export async function canHideFood(food: Food): Promise<boolean> {
  try {
    const row = await getRow(accountHandle(), "user_foods", food.id);
    return !!row && !row.deleted_at && typeof row.rev === "number" && Number.isSafeInteger(row.rev);
  } catch {
    return false;
  }
}

/** Hide a neutral food. False when this phone has no synced row for it (nothing was changed). */
export function hideFood(food: Food): Promise<boolean> {
  return tombstone(food, "delete");
}

/** Undo `hideFood`: the same row comes back with its note and numbers. */
export function unhideFood(food: Food): Promise<boolean> {
  return tombstone(food, "restore");
}
