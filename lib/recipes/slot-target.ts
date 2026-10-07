/**
 * The meal target a recipe or shopping preview aims one slot at: the day's authoritative target
 * revision, less what the day's other fixed meals take. Pure, so it is unit-tested apart from the
 * server preview routes (lib/server/recipe-plan.ts).
 *
 * "Fixed" includes meals already eaten: a slot eaten as a recipe reserves its consumed snapshot,
 * exactly as the Today screen sizes it (`slotTarget` in lib/resolve.ts reads `eaten` and
 * `consumedSlots`). Without the day's `eaten_slots` the preview split the whole day evenly and
 * aimed the open slots at calories that had already been eaten.
 *
 * The day's logged entries spend the budget too (lib/plan/slot-share.ts loggedOutsideSlots). A
 * caller that leaves them out aims the recipe at calories already logged, so an accepted recipe
 * double-books them (2026-10-04 audit, MAJOR 3). Pass them as `logged`, slot and all, in the
 * shape lib/server/day-context.ts loggedEntries builds.
 */
import type {
  ConsumedRecipeSnapshot, DayType, LoggedFood, Macros, SlotId, SlotOverride, Store,
} from "@/lib/types";
import { planningSlotTarget, ratiosFor } from "@/lib/resolve";

export type SlotTargetProfile = {
  id: string; rev: number; input_training_weekdays?: number[] | null;
  training_macros?: Macros | null; rest_macros?: Macros | null;
};

export type SlotTargetDayRow = {
  day_type_override?: string | null;
  item_overrides?: Record<string, SlotOverride> | null;
  eaten_slots?: Record<string, unknown> | null;
} | null;

function isMacros(value: unknown): value is Macros {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (["kcal", "protein", "carbs", "fat"] as const)
    .every((key) => typeof row[key] === "number" && Number.isFinite(row[key]));
}

/** A stored snapshot is JSON from the database: only a well-formed one may size the day. */
function snapshotOf(value: unknown): ConsumedRecipeSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.baseMealId !== "string" || !Array.isArray(row.components)
    || row.components.length === 0) return undefined;
  const ok = row.components.every((item) => item && typeof item === "object"
    && isMacros((item as Record<string, unknown>).macros));
  return ok ? value as ConsumedRecipeSnapshot : undefined;
}

/** The day's eaten ticks and recipe snapshots in the phone store's shape
 *  (lib/plan-day-client.ts legacyPatch does the same mapping on the device). */
function eatenState(raw: Record<string, unknown> | null | undefined): {
  eaten: Partial<Record<SlotId, string>>;
  consumedSlots: Partial<Record<SlotId, ConsumedRecipeSnapshot>>;
} {
  const eaten: Partial<Record<SlotId, string>> = {};
  const consumedSlots: Partial<Record<SlotId, ConsumedRecipeSnapshot>> = {};
  for (const [slot, mark] of Object.entries(raw ?? {})) {
    const state = mark as { eaten_at?: unknown; consumed?: unknown } | null;
    if (typeof state?.eaten_at !== "string" || !state.eaten_at) continue;
    eaten[slot as SlotId] = state.eaten_at;
    const snapshot = snapshotOf(state.consumed);
    if (snapshot) consumedSlots[slot as SlotId] = snapshot;
  }
  return { eaten, consumedSlots };
}

export function authoritativeSlotTarget(profile: SlotTargetProfile, date: string,
  count: number, slotId: string, row: SlotTargetDayRow, logged: readonly LoggedFood[] = []): Macros | null {
  const overrides = { ...(row?.item_overrides ?? {}) };
  // This preview replaces the selected slot; other fixed meals still consume
  // their share of the day's authoritative target.
  delete overrides[slotId];
  const store = { settings: {
    mealsPerDay: count, trainingWeekdays: profile.input_training_weekdays ?? [],
    activeTargetProfile: { id: profile.id, revision: profile.rev,
      training: profile.training_macros, rest: profile.rest_macros,
      inputs: { trainingWeekdays: profile.input_training_weekdays ?? [] } },
  }, days: { [date]: { date,
    dayTypeOverride: row?.day_type_override as DayType | undefined,
    itemOverrides: overrides, extras: [...logged], ...eatenState(row?.eaten_slots) } } } as unknown as Store;
  const dayType = ratiosFor(store, date).dayType;
  return planningSlotTarget(store, date, dayType, slotId as SlotId) ?? null;
}
