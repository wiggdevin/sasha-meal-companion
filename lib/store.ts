/**
 * localStorage persistence, versioned and SSR-safe. PRD §8.
 *
 * `typeof window === "undefined"` (server render, or a Node test env) never
 * throws — it just falls back to an in-memory default. Every localStorage
 * read/write is wrapped in try/catch because private browsing throws on
 * `setItem` (and sometimes `getItem`) in some browsers.
 *
 * Phase 9 §0.4 (plan decision P2): the store belongs to the bound account and lives under
 * `smc:u:<userId>:store`. The API stays synchronous and reads the bound account itself; with no
 * account bound the store is an in-memory default that is never persisted. The cache remembers
 * which account it holds, so a read for another account never answers from it.
 */

import {
  ACCOUNT_KEY_PREFIX, AccountChanged, accountKey, assertCurrent, currentAccountOrNull,
  type AccountHandle,
} from "./device/account";
import { writerFenceOk } from "./device/writer-lock";
import { noteDietFlagsChanged, noteFoodStatuses } from "./foods/rules-epoch";
import { scheduleSignature } from "./plan-schedule";
import { type Food, type FoodRole, type FoodStatus } from "./foods";
import { starterForName } from "./foods/starter";
import { inferFoodRole } from "./foods/role";
import type { LoggedFood, LoggedItem, Settings, SlotId, Store, StoredDay } from "./types";

/** The account-scoped name of the store (`smc:u:<userId>:store`). */
const STORE_NAME = "store";

function owner(): AccountHandle | null {
  return currentAccountOrNull();
}

export function defaultSettings(): Settings {
  return {
    trainingKcal: null,
    restKcal: null,
    proteinG: null,
    proteinLocked: true,
    slotTimes: {},
    shiftMinutes: 0,
    mealsPerDay: null,
    ruleReviewReady: false,
    changedAt: null,
    heightCm: null,
    birthYear: null,
    sex: null,
    bodyFatPct: null,
    weightKg: null,
    activityLevel: null,
    goal: null,
    trainingWeekdays: null,
    dietPrefs: null,
    onboardedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export function defaultStore(): Store {
  return {
    version: 1,
    firstOpenedAt: new Date().toISOString(),
    settings: defaultSettings(),
    days: {},
    foods: {},
  };
}

/**
 * Fill in anything missing from a persisted blob with defaults, so an older
 * saved shape (or a hand-edited one) never crashes the app. Existing values
 * always win over defaults.
 */
let migrated = false;

/**
 * Legacy logged meals stored their foods as nested `LoggedFood`s. Contracts §5 gives every item the
 * Phase 2 fields; this fills them in place the first time a phone loads after the upgrade. The
 * discriminator is `food_ref_id`: an item that has one has already been migrated (or was written by
 * Phase 2 in the first place). Synthesised refs are namespaced `local:` so they can never collide
 * with a `food_refs` UUID.
 */
export function migrateExtraItems(extras: LoggedFood[]): { extras: LoggedFood[]; changed: boolean } {
  let changed = false;
  const next = extras.map((entry) => {
    const items = entry.items;
    if (!items || items.length === 0) return entry;
    if (items.every((i) => typeof i.food_ref_id === "string" && i.food_ref_id.length > 0)) return entry;
    changed = true;
    return {
      ...entry,
      items: items.map((item, i): LoggedItem => {
        const legacy = item as unknown as { foodId?: string };
        return {
          id: item.id,
          seq: item.seq ?? i + 1,
          food_ref_id: item.food_ref_id ?? `local:${legacy.foodId ?? item.id}`,
          grams: item.grams,
          qty: item.qty,
          unit: item.unit ?? "portion",
          snapshot: item.snapshot ?? {},
          foodId: legacy.foodId ?? item.id,
          name: item.name,
          portionLabel: item.portionLabel,
          macros: item.macros,
        };
      }),
    };
  });
  return { extras: next, changed };
}

function normalizeStore(raw: unknown): Store {
  const fallback = defaultStore();
  if (typeof raw !== "object" || raw === null) return fallback;

  // Rebuilt field by field, so a key the app has retired is simply not carried forward — an old
  // blob that still holds `scaleWarningDismissed` (the deleted first-week scale warning, R2) reads
  // fine and comes back without it.
  const partial = raw as Partial<Store>;
  const settings: Settings = { ...fallback.settings, ...(partial.settings ?? {}) };
  // A blob saved before sync existed has no stamp; date it to first open so
  // newer-wins has a real value to compare and never falls back to a constant.
  settings.updatedAt ??= partial.firstOpenedAt ?? fallback.firstOpenedAt;
  const days: Record<string, StoredDay> = { ...(partial.days ?? {}) };
  // Foods are a projection of the signed-in account's normalized sync mirrors,
  // never restored from the unscoped local blob (design §7.1). The in-memory
  // projection survives a re-read; a fresh page starts empty until the next pull.
  const foods: Record<string, Food> = cached?.foods ?? fallback.foods;

  for (const [date, day] of Object.entries(days)) {
    if (!day.extras?.length) continue;
    const result = migrateExtraItems(day.extras);
    if (result.changed) {
      days[date] = { ...day, extras: result.extras };
      migrated = true;
    }
  }

  return {
    version: 1,
    firstOpenedAt: partial.firstOpenedAt ?? fallback.firstOpenedAt,
    settings,
    days,
    foods,
  };
}

let cached: Store | null = null;
/** The account `cached` belongs to (null: the unbound in-memory default). */
let cachedFor: string | null = null;

// Set when the most recent saveStore() failed to persist (quota exceeded,
// private browsing, storage disabled). While true, `cached` holds a write
// that never reached disk, so loadStore() must not overwrite it with the
// stale blob still sitting in localStorage — that would silently discard
// the pending change. Cleared the moment a write succeeds again.
let persistFailed = false;

/** Read the persisted store, or a fresh default if there is none / it's unreadable. */
export function loadStore(): Store {
  const h = owner();
  const id = h?.userId ?? null;
  if (cachedFor !== id) {
    cached = null;
    persistFailed = false;
  }
  cachedFor = id;
  if (typeof window === "undefined" || h === null) {
    cached = cached ?? defaultStore();
    return cached;
  }

  if (persistFailed && cached) {
    return cached;
  }

  try {
    const raw = window.localStorage.getItem(accountKey(h, STORE_NAME));
    migrated = false;
    cached = raw ? normalizeStore(JSON.parse(raw)) : defaultStore();
    // A coach-side change (e.g. sugars removed) is written back at once so
    // the next sync carries it and it cannot silently revert.
    if (migrated) saveStore(cached);
  } catch {
    cached = defaultStore();
  }
  return cached;
}

let onSave: (() => void) | null = null;

/** Called after every non-silent save. lib/sync.ts uses it to queue a push. */
export function setOnSave(listener: (() => void) | null): void {
  onSave = listener;
}

let onScheduleEdit: ((h: AccountHandle, settings: Settings) => void) | null = null;

/**
 * Called after a non-silent save that changed the meal times or the whole-day shift, from any
 * writer. lib/sync/account-sync.ts queues the two `user_settings` columns from it
 * (lib/sync/schedule-settings.ts), so the server's planner and coach read the clocks Today shows
 * (Phase 17 O4a). A silent save (a pull) never calls it.
 */
export function setOnScheduleEdit(listener: ((h: AccountHandle, settings: Settings) => void) | null): void {
  onScheduleEdit = listener;
}

/**
 * Persist the store. Never throws — a failed write just doesn't persist.
 * A settings object that changed identity gets a fresh `updatedAt`.
 * `silent` skips the save listener (used when sync itself writes).
 */
function dietFlagsSignature(settings: Settings | undefined): string {
  const flags = settings?.dietPrefs?.flags;
  return JSON.stringify(Array.isArray(flags) ? [...flags].filter((f) => typeof f === "string").sort() : []);
}

export function saveStore(store: Store, opts: { silent?: boolean } = {}): void {
  // PR #248 reload review r1 #1: once the page has frozen its account, a save is refused loudly
  // rather than accepted into memory that nobody will persist.
  if (frozen) throw new AccountChanged();
  // Reload review r3 #1: only the writer tab may replace the account's blob.
  if (!writerFenceOk()) throw new AccountChanged();
  const h = owner();
  const id = h?.userId ?? null;
  if (cachedFor !== id) { cached = null; persistFailed = false; }
  const settingsChanged = cached === null || store.settings !== cached.settings;
  // Diet flags are food rules: a change, from any writer, moves the rules epoch (round 3 BLOCK).
  if (cached !== null && settingsChanged
    && dietFlagsSignature(cached.settings) !== dietFlagsSignature(store.settings)) {
    noteDietFlagsChanged(id);
  }
  // An Avoid/Eats mark revokes stored verdicts (an offline barcode match) from any writer.
  if (cached !== null) noteFoodStatuses(cached.foods, store.foods);
  const scheduleEdited = cached !== null && settingsChanged && !opts.silent
    && scheduleSignature(cached.settings) !== scheduleSignature(store.settings);
  const next: Store =
    settingsChanged && !opts.silent
      ? { ...store, settings: { ...store.settings, updatedAt: new Date().toISOString() } }
      : store;
  cached = next;
  cachedFor = id;
  // No account bound: in memory only, never persisted (it would belong to nobody).
  if (typeof window === "undefined" || h === null) return;

  try {
    window.localStorage.setItem(accountKey(h, STORE_NAME), JSON.stringify(next));
    persistFailed = false;
  } catch {
    // Private browsing / quota exceeded / storage disabled. The write didn't
    // reach disk, so keep serving `cached` (already set above) until a save
    // succeeds again — see `persistFailed` in loadStore().
    persistFailed = true;
  }
  if (scheduleEdited) onScheduleEdit?.(h, next.settings);
  if (!opts.silent) onSave?.();
}

/** A save that runs after an `await`: it lands only while the account that started the work is
 *  still bound (Phase 9 §0.2), and throws `AccountChanged` otherwise. */
export function saveStoreFor(h: AccountHandle, store: Store, opts: { silent?: boolean } = {}): void {
  assertCurrent(h);
  saveStore(store, opts);
}

function currentStore(): Store {
  return cached !== null && cachedFor === (owner()?.userId ?? null) ? cached : loadStore();
}

export function getDay(date: string): StoredDay | undefined {
  return currentStore().days[date];
}

/** Merge `patch` into the StoredDay for `date` (creating it if needed) and persist. */
export function updateDay(date: string, patch: Partial<StoredDay>): Store {
  const store = currentStore();
  const existing = store.days[date] ?? { date };
  const updated: StoredDay = { ...existing, ...patch, date, updatedAt: new Date().toISOString() };
  const next: Store = { ...store, days: { ...store.days, [date]: updated } };
  saveStore(next);
  return next;
}

export function addExtra(date: string, entry: LoggedFood): Store {
  const existing = getDay(date)?.extras ?? [];
  return updateDay(date, { extras: [...existing, entry] });
}

/**
 * Add the entry, or replace the one already carrying that id. The optimistic commit path
 * (lib/log-client.ts) writes the card before the post and the sheet adds it again after the
 * reply, so "add" has to mean "there is exactly one of these" — a second copy of the same entry
 * would double the day's calories.
 */
export function upsertExtra(date: string, entry: LoggedFood): Store {
  const existing = getDay(date)?.extras ?? [];
  if (!existing.some((e) => e.id === entry.id)) return addExtra(date, entry);
  return updateDay(date, { extras: existing.map((e) => (e.id === entry.id ? { ...e, ...entry } : e)) });
}

export function updateExtra(date: string, entryId: string, patch: Partial<LoggedFood>): Store {
  const existing = getDay(date)?.extras ?? [];
  return updateDay(date, { extras: existing.map((e) => (e.id === entryId ? { ...e, ...patch } : e)) });
}

export function setSlotNote(date: string, slot: SlotId, note: string): Store {
  const notes = { ...(getDay(date)?.notes ?? {}) };
  if (note.trim()) notes[slot] = note.trim();
  else delete notes[slot];
  return updateDay(date, { notes });
}

export function removeExtra(date: string, entryId: string): Store {
  const existing = getDay(date)?.extras ?? [];
  return updateDay(date, { extras: existing.filter((e) => e.id !== entryId) });
}

export function getFoods(): Record<string, Food> {
  return currentStore().foods;
}

type SyncedFoodRow = {
  id?: unknown;
  name?: unknown;
  per_100g?: unknown;
  catalog_food_id?: unknown;
  deleted_at?: unknown;
  note?: unknown;
  updated_at?: unknown;
};

type SyncedFoodRefRow = { id?: unknown; user_food_id?: unknown };

type SyncedFoodPrefRow = {
  food_ref_id?: unknown;
  status?: unknown;
  role?: unknown;
  no_cook?: unknown;
  note?: unknown;
  updated_at?: unknown;
};

function finiteNutrient(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) && value >= 0 ? value / 100 : 0;
}

/**
 * A stored catalog link: an integer, or a string of digits ("0" included). null, a missing
 * column, "" and whitespace (which `Number` reads as 0) and any other value are no link.
 */
function catalogLink(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string" || !/^\s*-?\d+\s*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Build the phone food map solely from one account's normalized sync mirrors. */
export function foodsFromSyncRows(
  foodRows: readonly SyncedFoodRow[],
  prefRows: readonly SyncedFoodPrefRow[],
  refRows: readonly SyncedFoodRefRow[] = [],
): Record<string, Food> {
  const prefs = new Map(prefRows.flatMap((row) =>
    typeof row.food_ref_id === "string" ? [[row.food_ref_id, row] as const] : []));
  const refByFood = new Map<string, string>(refRows.flatMap((row) =>
    typeof row.id === "string" && typeof row.user_food_id === "string"
      ? [[row.user_food_id, row.id]] : []));
  const foods: Record<string, Food> = {};
  for (const row of foodRows) {
    if (row.deleted_at != null || typeof row.id !== "string" || typeof row.name !== "string") continue;
    const pref = prefs.get(refByFood.get(row.id) ?? "");
    const starter = starterForName(row.name);
    const status = pref?.status === "eats" || pref?.status === "avoid" ? pref.status : "neutral";
    const nutrients = typeof row.per_100g === "object" && row.per_100g !== null
      ? row.per_100g as Record<string, unknown>
      : {};
    // A stored role wins; with none, the curated starter's, then the name and calorie rule
    // (lib/foods/role.ts) — never a blanket "carb", which put "Soup, beef" under Carbs.
    const role: FoodRole = pref?.role === "protein" || pref?.role === "carb" || pref?.role === "fat"
      ? pref.role as FoodRole : starter?.role ?? inferFoodRole(row.name, {
        protein: finiteNutrient(nutrients, "protein"), carbs: finiteNutrient(nutrients, "carbohydrate"),
        fat: finiteNutrient(nutrients, "fat_total") });
    foods[row.id] = {
      id: row.id,
      name: row.name,
      role,
      unit: starter?.unit ?? "g",
      perUnit: {
        protein: finiteNutrient(nutrients, "protein") * (starter?.grams ?? 1),
        carbs: finiteNutrient(nutrients, "carbohydrate") * (starter?.grams ?? 1),
        fat: finiteNutrient(nutrients, "fat_total") * (starter?.grams ?? 1),
      },
      // Water and diet soda store real zeros; a row with no macro at all says nothing.
      ...(["protein", "carbohydrate", "fat_total", "energy_kcal"].some((key) =>
        nutrients[key] !== null && nutrients[key] !== "" && Number.isFinite(Number(nutrients[key])))
        ? {} : { nutritionUnknown: true }),
      status,
      noCook: pref?.no_cook === true,
      ...(typeof pref?.note === "string" && pref.note ? { note: pref.note }
        : typeof row.note === "string" && row.note ? { note: row.note } : {}),
      updatedAt: typeof pref?.updated_at === "string"
        ? pref.updated_at
        : typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
      // Only null or a missing column is "no link": `Number(null)` is 0, and that phantom
      // `catalogFoodId: 0` hid every pulled food from the eligible projection's food-id path
      // (lib/foods/eligible-client.ts) until its ref cache filled in (onb3: Today right after
      // onboarding planned from 0-2 of 11 verified foods). Every stored integer, 0 included, is a
      // link (the schema allows 0), so a catalog-linked food still needs its ref proof.
      ...(catalogLink(row.catalog_food_id) !== undefined
        ? { catalogFoodId: catalogLink(row.catalog_food_id) } : {}),
    };
  }
  return foods;
}

export function replaceFoodsFromSync(
  h: AccountHandle,
  foodRows: readonly SyncedFoodRow[],
  prefRows: readonly SyncedFoodPrefRow[],
  refRows: readonly SyncedFoodRefRow[] = [],
): void {
  assertCurrent(h);
  const store = currentStore();
  saveStoreFor(h, { ...store, foods: foodsFromSyncRows(foodRows, prefRows, refRows) }, { silent: true });
}

/** Add or replace a food and persist. */
export function upsertFood(food: Food): Store {
  const store = currentStore();
  const next: Store = {
    ...store,
    foods: { ...store.foods, [food.id]: { ...food, updatedAt: new Date().toISOString() } },
  };
  saveStore(next);
  return next;
}

/** Move a food between Eats, Avoid and neutral, optionally with a note. Never deletes. */
export function setFoodStatus(id: string, status: FoodStatus, note?: string): Store {
  const store = currentStore();
  const existing = store.foods[id];
  if (!existing) return store;
  return upsertFood({ ...existing, status, note: note ?? existing.note });
}

export function setFoodNote(id: string, note: string): Store {
  const store = currentStore();
  const existing = store.foods[id];
  if (!existing) return store;
  return upsertFood({ ...existing, note: note.trim() || undefined });
}

/** Set once by the departure's freeze: this page accepts no store write again. */
let frozen = false;

export function freezeStore(): void { frozen = true; }

/**
 * The write of `userId` that exists only in memory (localStorage refused it), or null. A departure
 * takes it before it unbinds and makes it durable before the page reloads (lib/device/departure.ts).
 */
export function unsavedStoreFor(userId: string): Store | null {
  return persistFailed && cached !== null && cachedFor === userId ? cached : null;
}

/**
 * Write a departing account's store to its own key. No handle: the account is already unbound
 * (frozen) when this runs, and only the departure calls it. True when it reached disk.
 */
export function writeDepartingStore(userId: string, store: Store): boolean {
  try {
    window.localStorage.setItem(`${ACCOUNT_KEY_PREFIX}${userId}:${STORE_NAME}`, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/** Phase 9 §0.3: drop the in-memory cache so the next read is the bound account's own. */
export function resetStoreCache(): void {
  frozen = false;
  cached = null;
  cachedFor = null;
  persistFailed = false;
}

/** Test-only alias of `resetStoreCache`. */
export const __resetStoreCache = resetStoreCache;
