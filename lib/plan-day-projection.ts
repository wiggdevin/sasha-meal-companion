/**
 * How a plan-day change lands in the legacy local store, split out of lib/plan-day-client.ts to
 * keep that module under its size budget (tests/speed/file-size.test.ts). No behaviour change.
 *
 * `projectOnlineEatenRow` applies the server's row after a recipe is eaten or undone online, and
 * forgets the meal snapshot (Phase 17 O2): that is a server log change the local hook never sees.
 */
import { invalidateMealSnapshot } from "@/lib/foods/meal-snapshot-store";
import type { AccountHandle } from "@/lib/device/account";
import { loadStore, saveStoreFor } from "@/lib/store";
import { putRow } from "@/lib/sync/idb";
import { withPlanAuthority } from "@/lib/sync/plan-authority";
import { planDayProjectionSchema } from "@/lib/sync/plan-days-schema";
import type {
  ConsumedRecipeSnapshot, DayType, EatenSlotState, SlotId, StoredDay,
} from "@/lib/types";

/**
 * Only the plan-level fields ride this patch. Anything else on `StoredDay`
 * (extras, eaten, weight, water) belongs to another op, and the payload below
 * would silently drop it.
 */
export type PlanDayPatch = {
  /** `null` clears the override; omitting the key leaves it alone. */
  dayTypeOverride?: DayType | null;
  floorDay?: boolean;
  swaps?: StoredDay["swaps"];
  notes?: StoredDay["notes"];
  itemOverrides?: StoredDay["itemOverrides"];
  eatenSlots?: Partial<Record<SlotId, EatenSlotState>>;
  /** ISO timestamp marks the day fully logged; `null` clears the mark; omitted leaves it alone. */
  dayCompleteAt?: string | null;
};

/**
 * The patch the legacy store gets. Written field by field on purpose: the local write
 * spreads whatever it is handed, so passing a key the patch never named would
 * write `undefined` over a value that was there — exactly how a bare
 * `floorDay` change used to unlock a day. Only an explicit `null` clears the
 * override, and the legacy store spells that "no field at all", not `null`.
 */
export function legacyPatch(patch: PlanDayPatch): Partial<StoredDay> {
  const out: Partial<StoredDay> = {};
  if (patch.dayTypeOverride === null) out.dayTypeOverride = undefined;
  else if (patch.dayTypeOverride !== undefined) out.dayTypeOverride = patch.dayTypeOverride;
  if (patch.floorDay !== undefined) out.floorDay = patch.floorDay;
  if (patch.swaps !== undefined) out.swaps = patch.swaps;
  if (patch.notes !== undefined) out.notes = patch.notes;
  if (patch.itemOverrides !== undefined) out.itemOverrides = patch.itemOverrides;
  if (patch.eatenSlots !== undefined) {
    out.eaten = Object.fromEntries(Object.entries(patch.eatenSlots)
      .filter((entry): entry is [SlotId, EatenSlotState] => entry[1]?.eaten_at !== null)
      .map(([slot, mark]) => [slot, mark.eaten_at]));
    out.consumedSlots = Object.fromEntries(Object.entries(patch.eatenSlots)
      .filter((entry): entry is [SlotId, EatenSlotState & { consumed: ConsumedRecipeSnapshot }] =>
        entry[1]?.eaten_at !== null && entry[1]?.consumed !== undefined)
      .map(([slot, mark]) => [slot, mark.consumed]));
  }
  if (patch.dayCompleteAt !== undefined) out.dayCompleteAt = patch.dayCompleteAt ?? undefined;
  return out;
}

export async function projectOnlineEatenRow(
  h: AccountHandle, date: string, row: Record<string, unknown>,
): Promise<StoredDay> {
  const parsed = planDayProjectionSchema.safeParse(row);
  if (!parsed.success || row.user_id !== h.userId || row.local_date !== date) {
    throw new Error("The saved eaten mark could not be read. Try again.");
  }
  await putRow(h, "plan_days", date, row);
  // A recipe eaten or undone is a server log change (Phase 17 O2): the meal snapshot is stale.
  await invalidateMealSnapshot(h);
  const patch = legacyPatch({ eatenSlots: parsed.data.eaten_slots ?? {} });
  const store = loadStore();
  const day = withPlanAuthority({ ...store.days[date], date, ...patch });
  saveStoreFor(h, { ...store, days: { ...store.days, [date]: day } });
  return day;
}
