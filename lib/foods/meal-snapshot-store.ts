/**
 * The phone's copy of the meal snapshot (Phase 17 O2, D2), with the eligible set it was read with.
 *
 * Account-scoped twice over: it lives in the account's own IndexedDB (`smc-u-<userId>`, the META
 * store beside the outbox), and a read refuses a record whose `accountId` is not the reading
 * account. A switch to another account therefore never reads it.
 *
 * Invalidation has one hook, in lib/sync/idb.ts: every local write to a snapshot input
 * (`SNAPSHOT_INPUTS`: a log committed, edited, moved, deleted or pulled from another device, a
 * coach apply or undo, an Eats or settings change) deletes the copy and moves a persistent
 * watermark in the same transaction. A food-rules change (no local row) and a recipe eaten or
 * undone (a server RPC) call `invalidateMealSnapshot`. A snapshot is stored only when the
 * watermark has not moved since its read started, so another tab's change or a reload in between
 * is never overwritten by an older answer.
 */
import { currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { onFoodRulesChanged } from "@/lib/foods/rules-epoch";
import { snapshotUsable, type MealSnapshotV2 } from "@/lib/meals/snapshot";
import { snapshotV3Usable, type MealSnapshotV3 } from "@/lib/meals/snapshot-v3";
import type { EligibleFoods } from "@/lib/server/eligible-foods";
import {
  deleteMeta, forgetMealSnapshot, getMeta, MEAL_SNAPSHOT_KEY, mealSnapshotEpoch, putMealSnapshotIfCurrent,
  settleSnapshotForget,
} from "@/lib/sync/idb";

export { MEAL_SNAPSHOT_KEY };

export type StoredMealSnapshot = {
  /** v2 (a closed account, Phase 17 O2) or v3 (an open food-world account, Phase 18 W8). */
  snapshot: MealSnapshotV2 | MealSnapshotV3;
  eligible: EligibleFoods;
  /** The watermark the read started under. */
  epoch: number;
};

/** The watermark a read starts under; -1 when it cannot be read (the answer is then not kept). */
export async function snapshotEpoch(h: AccountHandle): Promise<number> {
  try {
    await settleSnapshotForget(h);
    return await mealSnapshotEpoch(h);
  } catch {
    return -1;
  }
}

/** Forget this account's snapshot (best-effort; callers never wait on it to proceed). */
export async function invalidateMealSnapshot(h: AccountHandle | null = currentAccountOrNull()): Promise<void> {
  if (!h) return;
  await forgetMealSnapshot(h).catch(() => undefined);
}

onFoodRulesChanged(() => { void invalidateMealSnapshot(); });

/**
 * Keep a snapshot read under `epoch`. "stale": a snapshot input changed since the read started,
 * so its evidence must not be used; "skipped": it could not be kept (no watermark readable, or
 * not this account's), which says nothing against it.
 */
export async function saveMealSnapshot(h: AccountHandle, snapshot: MealSnapshotV2 | MealSnapshotV3, eligible: EligibleFoods,
  epoch: number): Promise<"stored" | "stale" | "skipped"> {
  if (snapshot.accountId !== h.userId || epoch < 0) return "skipped";
  await settleSnapshotForget(h).catch(() => undefined);
  const record: StoredMealSnapshot = { snapshot, eligible, epoch };
  return (await putMealSnapshotIfCurrent(h, record, epoch)) ? "stored" : "stale";
}

/**
 * This account's snapshot when it may still seed a new suggestion: the same account, the current
 * ranking contract, no older than 7 days, and stored under the current watermark. Otherwise null.
 */
export async function readMealSnapshot(h: AccountHandle, now: number = Date.now()):
  Promise<StoredMealSnapshot | null> {
  // A local input write whose (deferred) forget has not run yet: run it first.
  await settleSnapshotForget(h).catch(() => undefined);
  let record: StoredMealSnapshot | undefined;
  let epoch: number;
  try {
    record = await getMeta<StoredMealSnapshot>(h, MEAL_SNAPSHOT_KEY);
    epoch = await mealSnapshotEpoch(h);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || !record.snapshot || !record.eligible) return null;
  if (record.snapshot.accountId !== h.userId) {
    void deleteMeta(h, MEAL_SNAPSHOT_KEY).catch(() => undefined);
    return null;
  }
  const usable = record.snapshot.schemaVersion === 3 ? snapshotV3Usable(record.snapshot, h.userId, now)
    : snapshotUsable(record.snapshot, h.userId, now);
  return record.epoch === epoch && usable ? record : null;
}
