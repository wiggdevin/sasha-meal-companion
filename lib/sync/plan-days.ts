/** The normalized plan row must also reach Today's legacy store during release A. */
import { serializePlanDay } from "./plan-day-queue";
import { withPlanAuthority } from "./plan-authority";
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import { loadStore, saveStoreFor } from "@/lib/store";
import { META_STORE, openAccountDb, OUTBOX_STORE, type OutboxOp } from "./idb";
import { recordPullHold } from "./row-queue";
import { planDayFields, planDayProjectionSchema } from "./plan-days-schema";
import type { ChangeRow } from "./types";

/**
 * Hold the mirror/outbox lock while checking pending writes and projecting. A queued local edit
 * owns both its optimistic mirror and its legacy day until the outbox settles it. Pulling an older
 * server row must not roll either back. Only plan fields are replaced; food logs and eaten marks
 * belong to other writers. Projection is silent so a pull does not enqueue another sync.
 */
export function applyPulledPlanDay(h: AccountHandle, change: ChangeRow): Promise<boolean> {
  return serializePlanDay(change.entity_key, () => applyPlanDay(h, change));
}

async function applyPlanDay(h: AccountHandle, change: ChangeRow): Promise<boolean> {
  const parsed = planDayProjectionSchema.safeParse(change.current ?? {});
  if (!parsed.success) {
    console.warn(`sync: skipping malformed plan day ${change.entity_key}`);
    return false;
  }
  const db = await openAccountDb(h);
  const tx = db.transaction(["plan_days", OUTBOX_STORE, META_STORE], "readwrite");
  const rows = tx.objectStore("plan_days");
  const [pending, mirror] = await Promise.all([
    tx.objectStore(OUTBOX_STORE).getAll() as Promise<OutboxOp[]>,
    rows.get(change.entity_key),
  ]);
  assertCurrent(h);
  if (pending.some((op) => op.entity === "plan_days" && op.entity_id === change.entity_key)) {
    // Held, and remembered: the pull reads it again once the day's queue is empty, so an op that
    // settles without reading the row back cannot lose this change (audit 2026-10-10 A168).
    await recordPullHold(tx.objectStore(META_STORE), change);
    await tx.done;
    return true;
  }
  if (typeof mirror?.rev === "number" && mirror.rev > change.rev) {
    await tx.done;
    return true;
  }
  if (change.current === null) await rows.delete(change.entity_key);
  else await rows.put(change.current, change.entity_key);

  // No awaits between reading the legacy day and writing it. A writer waiting for this IDB lock
  // commits its local update afterwards; unrelated fields on the current legacy day are preserved.
  const store = loadStore();
  const current = store.days[change.entity_key];
  const plan = parsed.data;
  // A normalized plan timestamp cannot advance the legacy timestamp: that would hide a later
  // legacy food log. The local authority marker protects plan fields when that log is merged.
  const day = withPlanAuthority({
    ...current, date: change.entity_key,
    ...planDayFields(plan),
  });
  saveStoreFor(h, { ...store, days: { ...store.days, [change.entity_key]: day } }, { silent: true });
  await tx.done;
  return true;
}
