/**
 * The client half of the day-type toggle — T5, Sol amendment.
 *
 * Release A keeps the legacy localStorage store beside the normalized op-log
 * entities, so a write lands in both: Today reads the local store, while MCP
 * overlays normalized plan rows onto its legacy snapshot. The op is what syncs. The SQL `plan_days`
 * branch replaces the whole row from the payload, so a partial op would
 * erase `floor_day`, `swaps`, `slot_notes` and `item_overrides` — every op carries all five
 * fields, based on the mirror row, and clearing sends `day_type_override:
 * null` rather than dropping the key.
 */
import { accountFetch, accountHandle, accountJson, type AccountHandle } from "@/lib/device/account";
import { serializePlanDay } from "@/lib/sync/plan-day-queue";
import { withPlanAuthority } from "@/lib/sync/plan-authority";
import { getDay, loadStore, saveStoreFor } from "@/lib/store";
import { getRow } from "@/lib/sync/idb";
import { enqueueWithRow } from "@/lib/sync/outbox";
import { legacyPatch, projectOnlineEatenRow, type PlanDayPatch } from "@/lib/plan-day-projection";

export type { PlanDayPatch };
import type { DayTypeChoice } from "@/lib/plan-day";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import { ruleMarkFromWire } from "@/lib/foods/rule-mark-wire";
import type {
  EatenSlotState, FoodComponent, RuleMark, SlotId, SlotOverride, StoredDay,
} from "@/lib/types";


/**
 * The sheet's row, translated for `savePlanDay` — and nothing more. "Follow the
 * schedule" carries `dayType: null`, and that `null` is the whole message: an
 * omitted key means "leave the lock alone", so folding `null` into `undefined`
 * here would silently keep the old override in the normalized row.
 */
export function dayTypeChoicePatch(choice: DayTypeChoice): PlanDayPatch {
  return { dayTypeOverride: choice.dayType };
}

/** The normalized `plan_days` row — the snake_case shape the pull writes and SQL replaces. */
type PlanDayRow = {
  local_date?: string;
  day_type_override?: string | null;
  floor_day?: boolean;
  swaps?: unknown;
  slot_notes?: unknown;
  item_overrides?: unknown;
  eaten_slots?: Partial<Record<SlotId, EatenSlotState>>;
  day_complete_at?: string | null;
  rev?: number;
};

const pendingRecipeUndos = new Map<string, string>();


/**
 * Write the day-type patch to the legacy store and queue one complete
 * `plan_days` op, mirror row and op committed together.
 *
 * The mirror is the base, the legacy day overrides it (this device is the
 * local truth), and a field the patch names wins over both. The op goes out
 * first: an enqueue that rejects must leave the legacy day — and the snapshot
 * sync that follows it — untouched, so the two stores cannot disagree about a
 * write that never happened.
 */
/** Construct the patch only after earlier local writes or remote projections have settled. */
function patchPlanDay(
  date: string, makePatch: (day: StoredDay | undefined) => PlanDayPatch,
): Promise<StoredDay> {
  const h = accountHandle();
  return serializePlanDay(date, () => writePlanDay(h, date, makePatch(getDay(date))));
}

export function savePlanDay(date: string, patch: PlanDayPatch): Promise<StoredDay> {
  return patchPlanDay(date, () => patch);
}

/** Called only while patchPlanDay owns this date; helpers must not reacquire its queue. */
async function writePlanDay(h: AccountHandle, date: string, patch: PlanDayPatch): Promise<StoredDay> {
  const legacyDay = getDay(date) ?? { date };
  const prospective: StoredDay = { ...legacyDay, ...legacyPatch(patch) };
  const mirror = (await getRow(h, "plan_days", date)) as PlanDayRow | undefined;
  const rev = typeof mirror?.rev === "number" ? mirror.rev : null;
  const payload = {
    local_date: date,
    day_type_override: patch.dayTypeOverride !== undefined
      ? patch.dayTypeOverride
      : (prospective.dayTypeOverride ?? mirror?.day_type_override ?? null),
    floor_day: prospective.floorDay ?? mirror?.floor_day ?? false,
    swaps: prospective.swaps ?? mirror?.swaps ?? {},
    slot_notes: prospective.notes ?? mirror?.slot_notes ?? {},
    // The fifth field this op must carry. The SQL branch replaces the whole row, so leaving it out
    // would delete every slot edited that day the next time Floor Day or
    // picked a swap — see this file's header.
    item_overrides: prospective.itemOverrides ?? mirror?.item_overrides ?? {},
    // Omit = keep on the server (migration `_sync_upsert`). Only a patch that
    // names `eatenSlots` may replace the stored ticks; defaulting a missing
    // mirror field to `{}` here would clear them instead.
    ...(patch.eatenSlots !== undefined ? { eaten_slots: patch.eatenSlots } : {}),
    ...(patch.dayCompleteAt !== undefined ? { day_complete_at: patch.dayCompleteAt } : {}),
  };

  await enqueueWithRow(h, { ...mirror, ...payload, rev: (rev ?? 0) + 1 }, {
    op_id: crypto.randomUUID(),
    entity: "plan_days",
    entity_id: date,
    kind: rev === null ? "create" : "update",
    base_rev: rev,
    payload,
    client_ts: new Date().toISOString(),
  });

  // Normalized plan changes have their own revision. Advancing the legacy whole-day timestamp
  // here would hide an independent remote food log older than this plan edit.
  const store = loadStore();
  const day = withPlanAuthority({ ...store.days[date], date, ...legacyPatch(patch) });
  saveStoreFor(h, { ...store, days: { ...store.days, [date]: day } });
  return day;
}

/**
 * Flip Floor Day for `date` through the same `plan_days` op `savePlanDay` already sends for the
 * day-type lock, instead of writing the legacy store only (audit 2026-09-13 finding #10 — the
 * Today screen's own Floor Day toggle never reached the outbox).
 */
export function toggleFloorDay(date: string): Promise<StoredDay> {
  return patchPlanDay(date, (day) => ({ floorDay: !(day?.floorDay ?? false) }));
}

/** Set (`mealId`) or clear (`null`) one slot's swap for `date` and queue the sync alongside it —
 *  the Today screen's swap picker (audit 2026-09-13 finding #10). */
export function saveSwap(date: string, slot: SlotId, mealId: string | null): Promise<StoredDay> {
  const mutationId = crypto.randomUUID();
  return patchPlanDay(date, (day) => {
    const swaps = { ...(day?.swaps ?? {}) };
    if (mealId === null) delete swaps[slot];
    else swaps[slot] = mealId;
    const itemOverrides = { ...(day?.itemOverrides ?? {}) };
    itemOverrides[slot] = { ...(itemOverrides[slot] ?? {
      baseMealId: null, components: [], followPlan: true,
    }), mutationId };
    return { swaps, itemOverrides };
  });
}

/**
 * Record what was actually eaten in one slot on `date`, or pass `null` to drop back to the plan.
 *
 * The override carries the whole component list, so the slot re-sums to what is on it and nothing
 * else on the card is resized — the logging rule of 2026-09-14. The edit is scoped to this one
 * date; making it the usual choice is a separate, deliberate act.
 */
export function saveItemOverride(
  date: string, slot: SlotId, override: SlotOverride | null
): Promise<StoredDay> {
  const mutationId = crypto.randomUUID();
  return patchPlanDay(date, (day) => {
    const current = { ...(day?.itemOverrides ?? {}) };
    if (override === null) delete current[slot];
    else current[slot] = !override.followPlan || override.cleared || override.removed || override.added
      ? { ...override, mutationId } : override;
    return { itemOverrides: current };
  });
}

/** Persist a tick or untick tombstone through the account-owned plan row. */
export function saveEatenSlot(
  date: string,
  slot: SlotId,
  eatenAt: string | null,
  changedAt: string,
  generated?: { baseMealId: string; title: string; components: FoodComponent[] },
): Promise<StoredDay> {
  return writeEatenSlot(date, slot, eatenAt, changedAt, generated);
}

/** The server atomically checks the accepted selection before recording recipe history, then says
 *  whether the recipe still fits the CURRENT food rules (`ruleMark`; logging marks, never refuses). */
export function saveRecipeEatenSlot(
  date: string, slot: SlotId, selection: AcceptedRecipeSelection,
  actualServings: number, requestId: string,
): Promise<{ day: StoredDay; ruleMark: RuleMark | null }> {
  if (!Number.isFinite(actualServings) || actualServings <= 0 || actualServings > 20
    || selection.localDate !== date || selection.slotId !== slot) {
    return Promise.reject(new Error("Invalid accepted meal or eaten amount."));
  }
  const h = accountHandle();
  return serializePlanDay(date, async () => {
    const response = await accountFetch(h, "/api/recipes/consumed", {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, localDate: date, slotId: slot,
        selectionId: selection.id, planRevision: selection.planRevision, actualServings }),
    }, { budget: "prefs" });
    if (!response.ok) {
      const detail = await accountJson<{ message?: string }>(h, response);
      throw new Error(response.status === 409
        ? "This meal changed. Refresh Today and open it again."
        : detail.message ?? "The eaten mark did not save. Try again.");
    }
    const result = await accountJson<{ row: Record<string, unknown>; ruleMark?: unknown }>(h, response);
    return { day: await projectOnlineEatenRow(h, date, result.row), ruleMark: ruleMarkFromWire(result.ruleMark) };
  });
}


function writeEatenSlot(
  date: string, slot: SlotId, eatenAt: string | null, changedAt: string,
  generated?: { baseMealId: string; title: string; components: FoodComponent[] },
): Promise<StoredDay> {
  const h = accountHandle();
  return serializePlanDay(date, async () => {
    const mirror = await getRow(h, "plan_days", date) as PlanDayRow | undefined;
    const day = getDay(date);
    const previousMark = mirror?.eaten_slots?.[slot];
    if (eatenAt === null && (previousMark?.consumed || day?.consumedSlots?.[slot])) {
      if (!previousMark?.consumed || !previousMark.changed_at) {
        throw new Error("Refresh Today before undoing this logged recipe.");
      }
      const key = `${h.userId}:${date}:${slot}:${previousMark.changed_at}`;
      const requestId = pendingRecipeUndos.get(key) ?? crypto.randomUUID();
      pendingRecipeUndos.set(key, requestId);
      const response = await accountFetch(h, "/api/recipes/consumed", {
        method: "DELETE", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, localDate: date, slotId: slot,
          expectedChangedAt: previousMark.changed_at }),
      }, { budget: "prefs" });
      if (!response.ok) {
        const detail = await accountJson<{ message?: string }>(h, response);
        throw new Error(response.status === 409
          ? "This logged meal changed. Refresh Today before undoing it."
          : detail.message ?? "The undo did not save. Try again.");
      }
      const result = await accountJson<{ row: Record<string, unknown> }>(h, response);
      const saved = await projectOnlineEatenRow(h, date, result.row);
      pendingRecipeUndos.delete(key);
      return saved;
    }
    if (eatenAt && (previousMark?.consumed || day?.consumedSlots?.[slot])) {
      throw new Error("This consumed recipe is already logged. Undo it before logging again.");
    }
    const itemOverrides = { ...(day?.itemOverrides ?? {}) };
    const previous = itemOverrides[slot];
    if (eatenAt && generated && (!previous || previous.followPlan) && !previous?.cleared) {
      const { followPlan: _followPlan, ...saved } = previous ?? { baseMealId: null, components: [] };
      void _followPlan;
      itemOverrides[slot] = { ...saved, baseMealId: generated.baseMealId,
        title: generated.title, components: generated.components };
    }
    return writePlanDay(h, date, {
      ...(eatenAt && generated ? { itemOverrides } : {}),
      eatenSlots: {
        ...localEatenSlots(day),
        ...(mirror?.eaten_slots ?? {}),
        [slot]: { eaten_at: eatenAt, changed_at: changedAt,
          ...(previousMark?.history_epoch ? { history_epoch: previousMark.history_epoch } : {}) },
      },
    });
  });
}

/**
 * The device's own ticks for this date, in mirror shape. The patch replaces the
 * whole map, so a slot the mirror has not seen yet would be dropped from
 * `StoredDay.eaten` without this union; the mirror still wins on any shared
 * slot, so an untick tombstone is never resurrected. Each local timestamp is
 * both `eaten_at` and `changed_at`, the shape design §3.7 already specifies.
 */
function localEatenSlots(day: StoredDay | undefined): Partial<Record<SlotId, EatenSlotState>> {
  const entries = Object.entries(day?.eaten ?? {})
    .filter((entry): entry is [SlotId, string] => typeof entry[1] === "string")
    .map(([slot, eatenAt]) => [slot, { eaten_at: eatenAt, changed_at: eatenAt,
      ...(day?.consumedSlots?.[slot] ? { consumed: day.consumedSlots[slot] } : {}) }] as const);
  return Object.fromEntries(entries);
}

/** Set (or, for a blank note, clear) one slot's note for `date` and queue the sync alongside it —
 *  the same trim/delete-if-empty rule `lib/store.ts`'s `setSlotNote` used before this wrapper
 *  existed (audit 2026-09-13 finding #10). */
export function saveSlotNote(date: string, slot: SlotId, note: string): Promise<StoredDay> {
  return patchPlanDay(date, (day) => {
    const notes = { ...(day?.notes ?? {}) };
    const trimmed = note.trim();
    if (trimmed) notes[slot] = trimmed;
    else delete notes[slot];
    return { notes };
  });
}

/** Save the meal, note and date-specific clock time in one durable sync operation. */
export function saveMealEdit(
  date: string, slot: SlotId, baseMealId: string | null,
  edit: { components?: FoodComponent[] | null; planned: FoodComponent[]; note?: string;
    time?: string | null; title?: string | null },
): Promise<StoredDay> {
  if (edit.time !== undefined && edit.time !== null
    && !/^([01]\d|2[0-3]):[0-5]\d$/.test(edit.time)) {
    return Promise.reject(new Error("Choose a valid meal time."));
  }
  const mutationId = edit.components !== undefined || edit.title !== undefined
    ? crypto.randomUUID() : null;
  return patchPlanDay(date, (day) => {
    const itemOverrides = { ...(day?.itemOverrides ?? {}) };
    const override: SlotOverride = itemOverrides[slot]
      ? { ...itemOverrides[slot]!, baseMealId }
      : { baseMealId, components: edit.planned, followPlan: true };
    if (edit.components === null) {
      override.components = edit.planned;
      override.followPlan = true;
    } else if (edit.components !== undefined) {
      override.components = edit.components;
      delete override.followPlan;
    }
    if (edit.time === null) delete override.time;
    else if (edit.time !== undefined) override.time = edit.time;
    if (edit.components === null || edit.title === null) delete override.title;
    else if (edit.title !== undefined) {
      // Plan storage allows 80 characters; the coach's separate live-wire boundary clamps to 40.
      const title = edit.title.trim().slice(0, 80);
      if (title) override.title = title;
      else delete override.title;
    }
    if (mutationId) override.mutationId = mutationId;
    // A time-only edit keeps a cleared/removed card hidden. New food or a new title is an
    // intentional replacement and must bring it back into the date's visible plan.
    if (edit.components === null || (edit.components?.length ?? 0) > 0
      || (edit.title !== undefined && edit.title !== null && edit.title.trim().length > 0)) {
      delete override.cleared;
      delete override.removed;
    }
    if (override.followPlan && override.time === undefined && override.title === undefined
      && override.mutationId === undefined) {
      delete itemOverrides[slot];
    }
    else itemOverrides[slot] = override;
    const patch: PlanDayPatch = { itemOverrides };
    if (edit.note !== undefined) {
      const notes = { ...(day?.notes ?? {}) };
      const note = edit.note.trim();
      if (note) notes[slot] = note;
      else delete notes[slot];
      patch.notes = notes;
    }
    return patch;
  });
}
