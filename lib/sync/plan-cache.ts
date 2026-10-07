import { isCurrent as isCurrentHandle, type AccountHandle } from "@/lib/device/account";
import { loadStore, saveStoreFor } from "@/lib/store";
import { openAccountDb, OUTBOX_STORE, type OutboxOp } from "./idb";
import { serializePlanDay } from "./plan-day-queue";
import { withPlanAuthority } from "./plan-authority";
import { planDayFields, planDayProjectionSchema } from "./plan-days-schema";

/** Recover consumed feed rows after the legacy store is lost. Cached rows without an owner are
 * deliberately excluded. An existing normalized day or pending local edit owns its plan fields. */
export async function restoreCachedPlanDays(
  h: AccountHandle, isCurrent: () => boolean = () => isCurrentHandle(h),
): Promise<number> {
  const db = await openAccountDb(h);
  const keys = await db.getAllKeys("plan_days");
  // Phase 9 §0.2: a read that finishes after a switch is dropped (audit plan r2 finding 7).
  if (!isCurrentHandle(h)) return 0;
  let restored = 0;
  for (const key of keys) {
    if (!isCurrent()) break;
    if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    await serializePlanDay(key, async () => {
      if (!isCurrent()) return;
      // Read again under the same lock as local writers, never project an earlier enumeration.
      const tx = db.transaction(["plan_days", OUTBOX_STORE], "readwrite");
      const [row, pending] = await Promise.all([
        tx.objectStore("plan_days").get(key),
        tx.objectStore(OUTBOX_STORE).getAll() as Promise<OutboxOp[]>,
      ]);
      if (!isCurrentHandle(h)) { await tx.done; return; }
      const parsed = planDayProjectionSchema.safeParse(row);
      if (isCurrent() && row?.user_id === h.userId && row.local_date === key && parsed.success
        && !pending.some((op) => op.entity === "plan_days" && op.entity_id === key)) {
        const store = loadStore();
        const current = store.days[key];
        if (!(current as { _normalizedPlan?: boolean } | undefined)?._normalizedPlan) {
          const day = withPlanAuthority({ ...current, date: key, ...planDayFields(parsed.data) });
          saveStoreFor(h, { ...store, days: { ...store.days, [key]: day } }, { silent: true });
          restored += 1;
        }
      }
      await tx.done;
    });
  }
  return restored;
}
