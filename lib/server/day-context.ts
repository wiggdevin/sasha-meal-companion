/**
 * One day, resolved on the SERVER — T6 §2.
 *
 * The Today screen calls `resolveDay(store, date)` on the phone's own store. Nothing on the server
 * could do the same, so the coach emitted slot edits blind. This module builds the same `Store`
 * from the synced tables and hands the same pure `resolveDay` the same job, so the slot the coach
 * reads is the slot shown in the app.
 *
 * Reads only. It writes nothing, and `runTurn`'s "a turn writes nothing but the thread" holds.
 *
 * No "server-only" marker: tests load this module under vitest, and lib/server/ is the boundary.
 */

import { amountLabel, entryMass, massOf } from "@/lib/log/mass";
import { scopeDate } from "@/lib/coach/scope";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_TZ, localDateIn } from "@/lib/server/jobs";
import { activeTargets } from "@/lib/server/targets";
import type { CoachTurnRequest } from "@/lib/coach/types";
import { dayHasPartialNutrition, entryMacros, planningSlotTarget, resolveDay } from "@/lib/resolve";
import { judgePartialItems } from "@/lib/server/log-recipe-coverage";
import { itemKcal } from "@/lib/nutrients/energy";
import { remainingPool } from "@/lib/plan/slot-share";
import { getRuleReviewStatus } from "@/lib/server/constraints";
import { defaultSettings, foodsFromSyncRows } from "@/lib/store";
import { planDayFields, planDayProjectionSchema } from "@/lib/sync/plan-days-schema";
import { scheduleFieldsFromRow } from "@/lib/plan-schedule";
import { settingsProfileFromRow, type UserSettingsProfileRow } from "@/lib/sync/user-settings";
import type { Food } from "@/lib/foods";
import { settingsWithTargetRevision } from "@/lib/targets/revision";
import { chunk, fetchAllChunked, fetchAllRows, IN_CHUNK_SIZE } from "@/lib/server/paged-read";
import type { LoggedFood, LoggedItem, Macros, ResolvedDay, SlotId, Store, StoredDay }
  from "@/lib/types";

/** One line per food: "120 g Chicken breast - 198 kcal 37P 0C 4F" (T6 §2's token cap). */
export type ContextSlot = {
  slot: SlotId; label: string; title: string; time: string; state: "empty" | "eaten" | "pending";
  items: string[]; macros: string; note?: string;
  /** The same numbers, unrendered, for `compose_meal`'s target. Never put in the block. */
  totals: Macros;
};
export type ContextEntry = {
  entryId: string; at: string; slot: string; name: string;
  items: string[]; macros: string; note?: string; flags?: string[];
  /** A serving of a partly measured recipe: `macros` is a lower bound ("at least …", #21). */
  partial?: true;
};
export type DayContext = {
  date: string; dayType: string; targets: Macros | null;
  slots: ContextSlot[]; entries: ContextEntry[];
  consumed: Macros; remaining: Macros | null;
  /**
   * True when a logged entry is a partly measured recipe serving (#21): `consumed` is then a
   * lower bound and `remaining` an upper bound, and the text says so ("at least", "at most").
   */
  consumedPartial: boolean;
  /** The partial check could not run (food refs unreadable): the totals are not fully checked. */
  nutritionUnchecked?: true;
  /** Internal named-slot preview from this account's revision and overrides. */
  planningTarget?: Macros;
  /** The displayed remainder, so the model never has to do the subtraction (T6 §2). */
  stillToEat: string;
  /** Set only when the block had to drop entries to fit its cap. */
  entriesMore?: number;
};

/** `grams` null: an unknown mass (t17); `qty` and `unit` then carry the amount. */
type ItemRow = { seq: number; grams: number | string | null; food_ref_id: string;
  qty?: number | string | null; unit?: string | null;
  snapshot: Record<string, { amount: number | string | null }> | null;
  nutrition_partial?: boolean | null };
type EntryRow = { id: string; eaten_at: string; slot: string; note: string | null;
  log_items: ItemRow[] };

/** food_ref_id → display name, for the refs a caller actually holds. */
export async function foodNamesFor(
  client: SupabaseClient, refIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (refIds.length === 0) return names;
  // t18 r5: an Eats list can pass the API row cap; each chunk maps one row per ref.
  if (refIds.length > IN_CHUNK_SIZE) {
    for (const ids of chunk(refIds)) for (const [id, name] of await foodNamesFor(client, ids)) names.set(id, name);
    return names;
  }
  const refs = await client.from("food_refs")
    .select("id, catalog_food_id, user_food_id, user_foods(name)").in("id", refIds);
  if (refs.error) throw refs.error;
  const catalogIds = (refs.data ?? []).map((r) => r.catalog_food_id as number | null)
    .filter((v): v is number => v != null);
  const byCatalogId = new Map<number, string>();
  if (catalogIds.length > 0) {
    const revs = await client.from("catalog_food_revisions")
      .select("catalog_food_id, description").in("catalog_food_id", catalogIds)
      .eq("is_active", true);
    if (revs.error) throw revs.error;
    for (const r of revs.data ?? []) {
      byCatalogId.set(r.catalog_food_id as number, r.description as string);
    }
  }
  for (const ref of refs.data ?? []) {
    const own = (ref as unknown as { user_foods?: { name: string } | null }).user_foods;
    const cat = ref.catalog_food_id == null
      ? undefined : byCatalogId.get(ref.catalog_food_id as number);
    names.set(ref.id as string, own?.name ?? cat ?? "(unknown food)");
  }
  return names;
}

/** The entry's known mass, and the flag that says it is not the whole mass. */
function entryMassFields(items: LoggedItem[]): { grams: number; massUnknown?: true } {
  const { grams, massUnknown } = entryMass(items);
  return massUnknown ? { grams, massUnknown: true } : { grams };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function macrosOf(snapshot: ItemRow["snapshot"]): Macros {
  const s = snapshot ?? {};
  const at = (code: string) => num(s[code]?.amount ?? 0);
  return {
    // The one energy rule (lib/nutrients/energy.ts), the same one entryMacros sums: unknown adds 0
    // to a total here, and the item's line says "? kcal" (kcalUnknown) instead of a measured 0.
    kcal: itemKcal(s) ?? 0,
    protein: at("protein"), carbs: at("carbohydrate"), fat: at("fat_total"),
  };
}

function addMacros(a: Macros, b: Macros): Macros {
  return { kcal: a.kcal + b.kcal, protein: a.protein + b.protein,
    carbs: a.carbs + b.carbs, fat: a.fat + b.fat };
}

/** The clock time displayed on the card in the account time zone. */
export function clockIn(at: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB",
      { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date(at));
  } catch { return at.slice(11, 16); }
}

/** The day's entries as `LoggedFood`s, so `resolveDay` totals them exactly as Today does. */
export type LoggedEntry = { entry: LoggedFood; slot: string };

export async function loggedEntries(
  client: SupabaseClient, userId: string, date: string,
  /** Called when the partial check could not read the day's food refs (nothing is marked). */
  onUnchecked?: () => void,
): Promise<LoggedEntry[]> {
  const { data, error } = await client.from("log_entries")
    .select("id, eaten_at, slot, note, log_items(seq, qty, unit, grams, food_ref_id, snapshot, nutrition_partial)")
    .eq("user_id", userId).eq("local_date", date).is("deleted_at", null)
    .order("eaten_at", { ascending: true });
  if (error) throw error;
  const entries = (data ?? []) as unknown as EntryRow[];
  const refIds = [...new Set(entries.flatMap((e) => e.log_items.map((i) => i.food_ref_id)))];
  // #21: each item's recorded flag first; rows with none fall back to the recipe's current
  // revision. An unreadable recipe read marks the recipe servings it could not clear; an
  // unreadable food_refs read marks nothing and reports the day "not fully checked".
  // A failed name lookup degrades to "(unknown food)" rather than failing the day: the same outage
  // that blocks the partial check must still let the coach say the day was not fully checked.
  const [names, judged] = await Promise.all([foodNamesFor(client, refIds).catch((error: unknown) => {
    console.error("[day-context] food names unreadable; items shown as unknown foods", { error });
    return new Map<string, string>();
  }),
    judgePartialItems(client, entries.flatMap((entry) => entry.log_items),
      { onError: "mark", userId, onUnchecked })]);
  const partialEntries = new Set<string>();
  let index = 0;
  for (const entry of entries) {
    for (let i = 0; i < entry.log_items.length; i += 1, index += 1) {
      if (judged[index]) partialEntries.add(entry.id);
    }
  }
  return entries.map((entry) => {
    const items: LoggedItem[] = [...entry.log_items].sort((a, b) => a.seq - b.seq)
      .map((item) => {
        const name = names.get(item.food_ref_id) ?? "(unknown food)";
        // An unknown mass stays unknown (t17): its line reads as its count, never "0 g".
        const grams = massOf(item.grams);
        const amount = grams === null
          ? { grams: null, qty: num(item.qty), unit: item.unit ?? "each" }
          : { grams, qty: grams, unit: "g" };
        return {
          id: `${entry.id}:${item.seq}`, seq: item.seq, food_ref_id: item.food_ref_id,
          ...amount,
          snapshot: (item.snapshot ?? {}) as LoggedItem["snapshot"],
          foodId: item.food_ref_id, name,
          portionLabel: grams === null ? amountLabel(amount) : `${Math.round(grams)} g`,
          macros: macrosOf(item.snapshot),
        };
      });
    const macros = items.reduce((total, item) => addMacros(total, item.macros),
      { kcal: 0, protein: 0, carbs: 0, fat: 0 });
    const label = items.length === 1 ? items[0].name : `${items.length} items`;
    return {
      slot: entry.slot,
      entry: {
        // The row's slot rides on the entry too, so resolveDay can see a same-slot log
        // (lib/plan/eaten-estimate.ts); a value that is no slot or snack is dropped.
        ...(/^(meal-[1-6]|snack)$/.test(entry.slot) ? { slot: entry.slot as LoggedFood["slot"] } : {}),
        id: entry.id, foodId: "meal", name: label, qty: 1,
        ...entryMassFields(items),
        portionLabel: label, macros, note: entry.note ?? undefined,
        at: entry.eaten_at, items,
        ...(partialEntries.has(entry.id) ? { nutritionPartial: true } : {}),
      },
    } satisfies LoggedEntry;
  });
}

/**
 * `user_foods.id` (a `Food.id`, lib/foods.ts) -> its owned `food_refs.id` (Phase 18 W9): the real
 * identifier a logged, slotted or saved item needs (`GroundedActionItem.foodRefId`,
 * lib/coach/types.ts), which a bare account-food id is not. A pool-filled compose_meal row
 * (lib/coach/compose-pinned.ts) reads this before it can ever be actioned; a food with no row
 * here (deleted, or no ref yet minted) cannot be.
 */
export async function userFoodRefIds(admin: SupabaseClient, userId: string): Promise<Record<string, string>> {
  // t18 r5: an Eats list can pass the API's row cap, same as the pool itself; a silently
  // truncated page here would reproduce the wrong-table-id bug this function exists to fix, just
  // for whichever foods landed past page one.
  const foods = await fetchAllRows<{ id: unknown }>((from, to) => admin.from("user_foods")
    .select("id").eq("user_id", userId).is("deleted_at", null).order("id").range(from, to));
  const ids = foods.map((row) => String(row.id));
  if (ids.length === 0) return {};
  const refs = await fetchAllChunked<string, { id: unknown; user_food_id: unknown }>(ids,
    (batch, from, to) => admin.from("food_refs").select("id,user_food_id")
      .eq("kind", "user").in("user_food_id", batch).order("id").range(from, to));
  return Object.fromEntries(refs
    .filter((row): row is { id: string; user_food_id: string } =>
      typeof row.id === "string" && typeof row.user_food_id === "string")
    .map((row) => [row.user_food_id, row.id]));
}

/**
 * One account's normalized food projection; no global or legacy rows participate.
 * W038: live foods only (a soft-deleted food never reaches the coach), paged past the API's row
 * cap and with every `.in()` list chunked; any failed page rejects, never a shorter food list.
 */
export async function foodsFor(admin: SupabaseClient, userId: string): Promise<Record<string, Food>> {
  const foods = await fetchAllRows<Record<string, unknown>>((from, to) => admin.from("user_foods")
    .select("id,name,per_100g,created_at,deleted_at").eq("user_id", userId).is("deleted_at", null)
    .order("id").range(from, to));
  const ids = foods.map((row) => String(row.id));
  if (ids.length === 0) return {};
  const refs = await fetchAllChunked<string, { id: unknown; user_food_id: unknown }>(ids,
    (batch, from, to) => admin.from("food_refs").select("id,user_food_id")
      .eq("kind", "user").in("user_food_id", batch).order("id").range(from, to));
  const refIds = refs.map((row) => String(row.id));
  const prefs = await fetchAllChunked<string, Record<string, unknown>>(refIds,
    (batch, from, to) => admin.from("user_food_prefs")
      .select("food_ref_id,status,role,no_cook,note,updated_at")
      .eq("user_id", userId).in("food_ref_id", batch).order("food_ref_id").range(from, to));
  return foodsFromSyncRows(foods.map((row) => ({ ...row, updated_at: row.created_at })), prefs, refs);
}

/**
 * The store for one date is assembled only from user-scoped normalized rows.
 */
export async function serverStoreFor(
  admin: SupabaseClient, userId: string, date: string,
): Promise<Store> {
  const [userSettings, targets, plan, foods, ruleReview] = await Promise.all([
    admin.from("user_settings").select("*").eq("user_id", userId).maybeSingle(),
    activeTargets(admin, userId, date),
    admin.from("plan_days")
      .select("day_type_override, floor_day, swaps, slot_notes, item_overrides, eaten_slots")
      .eq("user_id", userId).eq("local_date", date).maybeSingle(),
    foodsFor(admin, userId),
    getRuleReviewStatus(admin, userId),
  ]);
  const parsed = planDayProjectionSchema.safeParse(plan.data ?? {});
  const day: StoredDay = parsed.success
    ? { date, ...planDayFields(parsed.data) } : { date };
  const normalized = (userSettings.data ?? {}) as UserSettingsProfileRow & {
    training_kcal?: number | null;
    rest_kcal?: number | null;
    protein_g?: number | null;
  };
  const baseSettings = {
    ...defaultSettings(),
    ...settingsProfileFromRow(normalized),
    // The saved slot times and whole-day shift: the slot clocks the coach's meal builds read.
    ...scheduleFieldsFromRow(userSettings.data),
    trainingKcal: normalized.training_kcal ?? null,
    restKcal: normalized.rest_kcal ?? null,
    proteinG: normalized.protein_g ?? null,
    ruleReviewReady: !ruleReview.required,
  };
  const settings = targets?.revision
    ? settingsWithTargetRevision(baseSettings, targets.revision)
    : baseSettings;
  return {
    version: 1,
    firstOpenedAt: new Date(`${date}T00:00:00.000Z`).toISOString(),
    settings,
    days: { [date]: day },
    foods,
  };
}

function round(macros: Macros): Macros {
  return { kcal: Math.round(macros.kcal), protein: Math.round(macros.protein),
    carbs: Math.round(macros.carbs), fat: Math.round(macros.fat) };
}

/** What is left of the day, every macro from the same pool as the slot shares (kcal covers them). */
function remainder(targets: Macros, consumed: Macros): Macros {
  return round(remainingPool(targets, consumed));
}

/** The one shape both the injected context block and the `get_plan` tool report. */
const n0 = (value: number) => String(Math.round(value));
const n1 = (value: number) => String(Math.round(value * 10) / 10);

/** "198 kcal 37P 0C 4F" — the four numbers, once, with no nutrient sub-objects. */
function macroLine(macros: Macros, kcalUnknown = false): string {
  const kcal = kcalUnknown ? "?" : n0(macros.kcal);
  return `${kcal} kcal ${n1(macros.protein)}P ${n1(macros.carbs)}C ${n1(macros.fat)}F`;
}

/** "120 g Chicken breast - 198 kcal 37P 0C 4F". One line, one food. */
function foodLine(name: string, macros: Macros, kcalUnknown = false): string {
  return `${name} - ${macroLine(macros, kcalUnknown)}`;
}

/** A measured item whose snapshot carries no usable energy: its kcal is unknown, not 0. */
function kcalUnknown(item: LoggedItem): boolean {
  return Object.keys(item.snapshot ?? {}).length > 0 && itemKcal(item.snapshot) === null;
}

/** A server item with an empty snapshot was never measured: nothing about it is known. */
function unmeasured(item: LoggedItem): boolean {
  return Object.keys(item.snapshot ?? {}).length === 0;
}

/** "2 pouch Pouch - nutrition unknown" for an unmeasured item; never "0 kcal 0P 0C 0F". */
function itemLine(item: LoggedItem): string {
  const name = `${item.grams === null ? amountLabel(item) : `${n0(item.grams)} g`} ${item.name}`;
  return unmeasured(item) ? `${name} - ${NUTRITION_UNKNOWN}` : foodLine(name, item.macros, kcalUnknown(item));
}

/**
 * The entry's line, by the one energy rule (lib/nutrients/energy.ts) item by item — never a 0 that
 * stands for unknown (t17 round 3, GPT-6 BLOCK 2):
 *   every item unmeasured          → "nutrition unknown"
 *   no item with usable energy     → "? kcal 10P 0C 0F"
 *   some items without energy      → "180 kcal 10P 0C 0F + 1 unknown"
 */
function entryLine(extra: LoggedFood): string {
  const items = extra.items ?? [];
  if (items.length > 0 && items.every(unmeasured)) return NUTRITION_UNKNOWN;
  if (items.length === 0) return macroLine(entryMacros(extra));
  const energies = items.map((item) => itemKcal(item.snapshot));
  const unknown = energies.filter((kcal) => kcal === null).length;
  const known = energies.reduce<number>((sum, kcal) => sum + (kcal ?? 0), 0);
  const line = macroLine({ ...entryMacros(extra), kcal: known }, unknown === items.length);
  return unknown === 0 || unknown === items.length ? line
    : `${line} + ${unknown} unknown`;
}

const NUTRITION_UNKNOWN = "nutrition unknown";

/**
 * A partly measured recipe serving (#21) is a lower bound, read by the same per-item energy rule as
 * every other entry line (t17): "at least …", and never "at least 0 kcal" for an unknown.
 */
function partialLine(extra: LoggedFood): string {
  const line = entryLine(extra);
  return line === NUTRITION_UNKNOWN ? line
    : `at least ${line} (a recipe whose nutrition is partly measured or could not be checked)`;
}

export function toDayContext(
  day: ResolvedDay, tz: string, logged: LoggedEntry[],
): DayContext {
  const slots: ContextSlot[] = day.slots.map((slot) => ({
    slot: slot.slot, label: slot.label, title: slot.meal?.name ?? "No meal planned", time: slot.time,
    state: slot.meal === null ? "empty" : slot.eaten ? "eaten" : "pending",
    // A component carries qty and unit, not grams: report exactly what the card shows.
    items: slot.components.map((component) =>
      foodLine(`${component.qty} ${component.unit} ${component.name}`, component.macros)),
    macros: macroLine(slot.macros),
    totals: round(slot.macros),
    ...(slot.note ? { note: slot.note } : {}),
  }));
  const slotOf = new Map(logged.map(({ entry, slot }) => [entry.id, slot]));
  const entries: ContextEntry[] = day.extras.map((extra) => ({
    entryId: extra.id, at: clockIn(extra.at, tz),
    slot: slotOf.get(extra.id) ?? "extra",
    name: extra.name,
    items: (extra.items ?? []).map((item) => itemLine(item)),
    macros: entryLine(extra),
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.flags?.length ? { flags: extra.flags } : {}),
    ...(extra.nutritionPartial ? { partial: true as const, macros: partialLine(extra) } : {}),
  }));
  const remaining = day.targets ? remainder(day.targets, day.consumed) : null;
  const consumedPartial = dayHasPartialNutrition(day);
  return {
    date: day.date, dayType: day.dayType, targets: day.targets ? round(day.targets) : null, slots, entries,
    consumed: round(day.consumed), remaining, consumedPartial,
    stillToEat: remaining
      ? `${consumedPartial ? "at most " : ""}${n0(remaining.kcal)} kcal left, `
        + `${consumedPartial ? "at most " : ""}${n0(remaining.protein)} g protein, `
        + `${consumedPartial ? "at most " : ""}${n0(remaining.carbs)} g carbs, `
        + `${consumedPartial ? "at most " : ""}${n0(remaining.fat)} g fat`
        + (consumedPartial ? " (some of what was eaten is only partly measured)" : "")
      : "Targets are not set. Ask the user to finish the profile.",
  };
}

export async function buildDayContext(
  admin: SupabaseClient, userId: string, date: string, tz: string, planningSlot?: string,
): Promise<DayContext> {
  let unchecked = false;
  const [store, logged] = await Promise.all([
    serverStoreFor(admin, userId, date),
    loggedEntries(admin, userId, date, () => { unchecked = true; }),
  ]);
  const withEntries: Store = {
    ...store,
    days: { ...store.days, [date]: { ...(store.days[date] ?? { date }),
      extras: logged.map(({ entry }) => entry) } },
  };
  const day = resolveDay(withEntries, date);
  const judged = toDayContext(day, tz, logged);
  const context: DayContext = unchecked ? { ...judged, nutritionUnchecked: true } : judged;
  // Any named meal not yet eaten: an empty one is planned into its share, and a planned one is
  // re-planned into the share it would have as an open slot (lib/plan/slot-share.ts).
  const named = planningSlot ? day.slots.find((slot) => slot.slot === planningSlot && !slot.eaten)
    : undefined;
  const planningTarget = named
    ? planningSlotTarget(withEntries, date, day.dayType, named.slot) : undefined;
  return planningTarget ? { ...context, planningTarget } : context;
}

/**
 * The account clock, from the POST body. `DEFAULT_TZ` and the server's own clock are fallback only
 * when the body carries neither — an old client that has not reloaded yet (T6 §2).
 */
export function accountClock(req: CoachTurnRequest, nowMs: number):
  { now: string; tz: string; date: string } {
  const tz = req.tz ?? DEFAULT_TZ;
  const at = req.now ? new Date(req.now) : new Date(nowMs);
  const instant = Number.isNaN(at.getTime()) ? new Date(nowMs) : at;
  // A scoped ask (lib/coach/scope.ts) names the date the user is looking at; the turn reasons
  // about that day while `now` stays the real clock.
  const viewed = scopeDate(req.scope);
  try {
    return { now: instant.toISOString(), tz, date: viewed ?? localDateIn(tz, instant) };
  } catch {
    return { now: instant.toISOString(), tz: DEFAULT_TZ,
      date: viewed ?? localDateIn(DEFAULT_TZ, instant) };
  }
}
