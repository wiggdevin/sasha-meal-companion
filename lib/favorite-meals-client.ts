/**
 * Save a meal card's plate as a saved meal (`favorites_meals` + `favorites_meal_items`), and remove
 * exactly that saved meal again. The meal card's heart is the only caller.
 *
 * Heart ON also marks each of the plate's foods Favored (owner extension, 2026-10-08): one
 * `food_membership` "eats" op per normalized name through `setFoodMembership`, the op every Eats add
 * queues. A food on Avoid, or not cleared under the account's current rules (blocked, or not yet
 * verified — fail closed), is skipped and named in `skipped`. A food already on Eats is left as it
 * is. `newlyFavored` names only the foods this call moved to Eats, and the membership revision each
 * one wrote is recorded per saved meal, so `undoSaveFavoriteMeal` can put back exactly those marks
 * and never a later choice. Heart OFF (`removeFavoriteMeal`) removes the saved meal only; the foods
 * stay Favored. No `favorites_foods` star is ever written.
 *
 * - Each component gets a food ref. An account food (Eats) uses the refs its Foods row is known by
 *   (`foodRefsFor`, lib/foods/prefs-client.ts) — the refs the swap sheet maps a saved meal back to
 *   its foods with, so the saved meal is offered there. A catalog-only food uses the log commit's
 *   registry (`resolveFoodRef`, lib/log-client.ts). A bundled universe food is adopted exactly as a
 *   log of it is (`adoptUserFood`, under the registry key `user-food:<id>`). Cached refs cost no
 *   network, so a plate of foods this phone already knows saves offline.
 * - The row, its items and the create op commit in ONE IndexedDB transaction with the per-account
 *   source index (`mutateRowWithOp`), so `allRows("favorites_meals")` sees the meal at once and the
 *   server gets it on the next push. The existing `apply_sync_op` "favorites_meals" create writes
 *   the row and its items in one transaction (20261025090200, `_sync_upsert`); no migration.
 * - A ref that cannot be had right now answers `offline` (or `retry` while online) and writes
 *   nothing. A heart is not deferred like a picked log (lib/log/picked-deferred.ts): a log records
 *   something that already happened and must not be lost, while a heart is one cheap tap to repeat,
 *   and a deferred save would show a heart for a saved meal no list holds yet.
 * - Removal tombstones by id only, through `setFavorite`'s delete path, never by name.
 */
import {
  AccountChanged, assertCurrent, currentAccountOrNull, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { nextSort } from "@/lib/favorites";
import { setFavorite } from "@/lib/favorites-client";
import { dbFood } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { adoptUserFood, bundledFoodUserId, per100gFromBundled } from "@/lib/foods/adopt-client";
import { normalizeFoodName } from "@/lib/foods/normalize";
import {
  FoodMembershipSaveError, foodRefsFor, readFoodMembership, readPrefRefCache,
  reserveFoodMembershipIntent, setFoodMembership, type FoodMembershipIntent,
} from "@/lib/foods/prefs-client";
import { componentRuleMark, currentEligibleView, openWorldOf } from "@/lib/foods/rule-marks";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import { uuidV5 } from "@/lib/foods/uuid5";
import { cachedFoodRef, rememberFoodRef, resolveFoodRef } from "@/lib/log-client";
import { parseFoodKey } from "@/lib/meals/food-key";
import { loadStore, setFoodStatus } from "@/lib/store";
import { allRows, getMeta, getRow, mutateRowWithOp, putMeta } from "@/lib/sync/idb";
import type { Settings } from "@/lib/types";
import { announceQueued } from "@/lib/sync/outbox";
import type { FoodComponent, SlotId } from "@/lib/types";

/** Where a saved meal came from: the plate on this date's slot. */
export type FavoriteMealSource = { date: string; slotId: SlotId; mealId: string | null };

export type FavoriteMealInput = { name: string; components: FoodComponent[]; source: FavoriteMealSource };

export type FavoriteMealFailure = { ok: false; reason: "offline" | "retry" | "refused"; message: string };

/** Heart ON. Both lists hold normalized food names (`normalizeFoodName`). */
export type SaveFavoriteMealOutcome =
  | { ok: true; id: string; newlyFavored: string[]; skipped: string[] }
  | FavoriteMealFailure;

/** Heart OFF. */
export type FavoriteMealOutcome = { ok: true; id: string } | FavoriteMealFailure;

/** Undo of a heart ON: `cleared` went back to neutral; `kept` were left as they are now. */
export type UndoFavoriteMealOutcome =
  | { ok: true; id: string; cleared: string[]; kept: string[] }
  | FavoriteMealFailure;

/** What the rules say about Favoring one food right now. */
export type FavorVerdict = "allowed" | "avoid" | "blocked";

/** How refs are had. The defaults go through Supabase; tests inject their own. */
export type FavoriteMealRefs = {
  /** An account food's own user ref (the Foods row). Null: not resolvable right now. */
  account: (food: Food, h: AccountHandle, online: boolean) => Promise<string | null>;
  /** A catalog-only food's ref, through the log commit's registry. */
  catalog: (catalogFoodId: number, h: AccountHandle, online: boolean) => Promise<string | null>;
  /** A bundled universe food adopted as this account's row, as a log of it is. */
  bundled: (bundledId: string, h: AccountHandle, online: boolean) => Promise<string | null>;
};

export type SaveFavoriteMealOptions = {
  /** The account to save as. Default: the bound one. */
  account?: AccountHandle | null;
  /** The foods the plate was built from (the open-world pool included). Default: the store's. */
  foods?: Record<string, Food>;
  /** Default: `navigator.onLine`. Offline, only cached refs are used. */
  online?: boolean;
  refs?: Partial<FavoriteMealRefs>;
  /**
   * The verified eligible set Today resolved the day with (`loadEligibleLocalFoodIds`). A food is
   * Favored only when it is cleared under it; without one, no food that is not already on Eats is
   * Favored (fail closed). An open account's set also supplies the admitted universe pool.
   */
  eligible?: ReadonlySet<string>;
  /** Test seam: the rule verdict for one component. Default: Avoid, then `componentRuleMark`. */
  judge?: (component: FoodComponent, nameNorm: string) => FavorVerdict;
};

/** META key: source key → the saved meal made from that plate. Client-only, per account DB. */
export const FAVORITE_MEAL_SOURCES_KEY = "favorite_meal_sources";
type SourceIndex = Record<string, { savedMealId: string; savedAt: string }>;

/** META key: saved meal id → the Favored marks its heart ON wrote, for its Undo. */
export const FAVORITE_MEAL_MARKS_KEY = "favorite_meal_marks";
type MarkRecord = { name: string; rev: number; localId?: string; undone?: true };
type MarkIndex = Record<string, MarkRecord[]>;

const NAMESPACE = "5d7c2f1e-8a4b-4c3d-9e6f-1b2a3c4d5e6f";
const SAVED_PREFIX = "saved:";
const NAME_MAX = 120;
const ITEMS_MAX = 30;

const OFFLINE = "You're offline. Save this meal when you're back online.";
const RETRY = "Couldn't save this meal. Try again.";

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** One key per plate: the date, the slot and the meal shown there. */
export function favoriteMealSourceKey(source: FavoriteMealSource): string {
  return `${source.date}|${source.slotId}|${source.mealId ?? "-"}`;
}

function liveRow(row: Record<string, unknown> | undefined): boolean {
  return Boolean(row && !row.deleted_at);
}

function announce(): void {
  globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
}

// ------------------------------------------------------------------------------ refs

const defaultRefs: FavoriteMealRefs = {
  account: async (food, h, online) => {
    // `foodRefsFor` answers from its cache first and asks the network only when it must.
    if (!online) return readPrefRefCache(h.userId)[food.id]?.userRefId ?? null;
    return (await foodRefsFor(food, h))?.userRefId ?? null;
  },
  catalog: async (id, h, online) => online
    ? resolveFoodRef(id, undefined, h) : cachedFoodRef(`catalog:${id}`, h),
  bundled: async (bundledId, h, online) => {
    const source = dbFood(bundledId);
    if (!source) return null;
    const id = await bundledFoodUserId(source.id, h.userId);
    const key = `user-food:${id}`;
    const cached = cachedFoodRef(key, h);
    if (cached || !online) return cached;
    const ref = await adoptUserFood({ id, name: source.name, per100g: per100gFromBundled(source) },
      { account: h });
    if (ref) rememberFoodRef(key, ref, h);
    return ref;
  },
};

type Target =
  | { kind: "account"; food: Food }
  | { kind: "bundled"; food: Food; bundledId: string }
  | { kind: "catalog"; food: Food | null; catalogFoodId: number };

function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The food a component stands for: its key first, else ONE food of exactly its name. */
function targetOf(component: FoodComponent, foods: Record<string, Food>): Target | null {
  const parsed = component.foodKeyInvalid ? null : parseFoodKey(component.foodKey);
  if (parsed?.kind === "catalog") {
    const key = `catalog:${parsed.catalogFoodId}`;
    const food = foods[key]
      ?? Object.values(foods).find((f) => f.catalogFoodId === parsed.catalogFoodId) ?? null;
    return food && food.id !== key ? { kind: "account", food }
      : { kind: "catalog", food, catalogFoodId: parsed.catalogFoodId };
  }
  if (parsed?.kind === "food") {
    if (foods[parsed.id]) return { kind: "account", food: foods[parsed.id] };
    const universe = foods[`universe:${parsed.id}`];
    if (universe) return { kind: "bundled", food: universe, bundledId: parsed.id };
    return null;
  }
  if (component.foodKey !== undefined || component.foodKeyInvalid) return null;
  const want = nameKey(component.name);
  const named = Object.values(foods).filter((f) => nameKey(f.name) === want);
  if (named.length !== 1) return null;
  const [food] = named;
  const universe = /^universe:(.+)$/.exec(food.id);
  if (universe) return { kind: "bundled", food, bundledId: universe[1] };
  const catalog = /^catalog:(\d+)$/.exec(food.id);
  if (catalog) return { kind: "catalog", food, catalogFoodId: Number(catalog[1]) };
  return { kind: "account", food };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The grams a component stands for. Null when its mass cannot be known. */
function gramsOf(component: FoodComponent, food: Food | null): number | null {
  if (!Number.isFinite(component.qty) || component.qty <= 0) return null;
  if (component.unit === "g") return round1(component.qty);
  if (!food || food.unit !== component.unit) return null;
  const unitGrams = accountUnitGrams(food);
  if (unitGrams === null || !(unitGrams > 0)) return null;
  const grams = round1(component.qty * unitGrams);
  return grams > 0 ? grams : null;
}

type Item = { seq: number; food_ref_id: string; grams: number };

async function itemsFor(
  components: FoodComponent[], foods: Record<string, Food>, h: AccountHandle,
  refs: FavoriteMealRefs, online: boolean,
): Promise<Item[] | FavoriteMealFailure> {
  const targets = components.map((c) => targetOf(c, foods));
  const grams = components.map((c, i) => {
    const t = targets[i];
    return t ? gramsOf(c, t.food) : null;
  });
  if (targets.some((t) => t === null) || grams.some((g) => g === null)) {
    return { ok: false, reason: "refused",
      message: "This meal has a food that can't be saved yet. Edit it, then try again." };
  }
  const resolved = await Promise.all((targets as Target[]).map(async (t) => {
    try {
      if (t.kind === "account") return await refs.account(t.food, h, online);
      if (t.kind === "bundled") return await refs.bundled(t.bundledId, h, online);
      return await refs.catalog(t.catalogFoodId, h, online);
    } catch (e) {
      rethrowAccountChanged(e);
      return null;
    }
  }));
  if (resolved.some((r) => !r)) {
    return online ? { ok: false, reason: "retry", message: RETRY }
      : { ok: false, reason: "offline", message: OFFLINE };
  }
  return resolved.map((ref, i) => ({ seq: i + 1, food_ref_id: ref as string, grams: grams[i] as number }));
}

// ------------------------------------------------------------------------------ Favored marks

function localFoodNamed(foods: Record<string, Food>, nameNorm: string): Food | undefined {
  return Object.values(foods).find((food) => normalizeFoodName(food.name) === nameNorm);
}

/**
 * The rule verdict Today would show for the line: Avoid first (a local food of that name on Avoid,
 * or this device's latest membership mark), then `componentRuleMark` under the verified set. Only a
 * clear line is `allowed`; a blocked or not-yet-verified one is not Favored.
 */
function defaultJudge(
  h: AccountHandle, foods: Record<string, Food>, settings: Pick<Settings, "dietPrefs">,
  eligible: ReadonlySet<string> | undefined,
): (component: FoodComponent, nameNorm: string) => FavorVerdict {
  const view = currentEligibleView(foods, settings, eligible);
  const admitted = Object.values(openWorldOf(eligible)?.foods ?? {});
  return (component, nameNorm) => {
    if (readFoodMembership(h.userId, nameNorm)?.status === "avoid") return "avoid";
    if (Object.values(foods).some((f) => f.status === "avoid" && normalizeFoodName(f.name) === nameNorm)) {
      return "avoid";
    }
    return componentRuleMark(component, foods, view, admitted) === null ? "allowed" : "blocked";
  };
}

function alreadyFavored(h: AccountHandle, foods: Record<string, Food>, nameNorm: string): boolean {
  const mark = readFoodMembership(h.userId, nameNorm);
  if (mark) return mark.status === "eats";
  return Object.values(foods).some((f) => f.status === "eats" && normalizeFoodName(f.name) === nameNorm);
}

/** One durable Eats mark for this name, as the intent's revision. True only when it is the newest. */
async function markFavored(
  h: AccountHandle, name: string, local: Food | undefined, intent: FoodMembershipIntent,
): Promise<boolean> {
  try {
    await setFoodMembership(name, "eats", { note: null, account: h, intent, ...(local ? { food: local } : {}) });
  } catch (e) {
    rethrowAccountChanged(e);
    // The Foods row's refs could not be minted right now. The saved meal already resolved its
    // ref, so the name-wide op still reaches it; queue that rather than lose the mark.
    if (!(e instanceof FoodMembershipSaveError) || !local) return false;
    try {
      await setFoodMembership(name, "eats", { note: null, account: h, intent });
    } catch (again) {
      rethrowAccountChanged(again);
      return false;
    }
  }
  assertCurrent(h);
  const now = readFoodMembership(h.userId, intent.nameNorm);
  return now?.status === "eats" && now.rev === intent.rev;
}

async function favorFoods(
  h: AccountHandle, mealId: string, components: FoodComponent[],
  judge: (component: FoodComponent, nameNorm: string) => FavorVerdict,
): Promise<{ newlyFavored: string[]; skipped: string[] }> {
  const foods = loadStore().foods;
  const newlyFavored: string[] = [];
  const skipped: string[] = [];
  const records: MarkRecord[] = [];
  const seen = new Set<string>();
  for (const component of components) {
    const nameNorm = normalizeFoodName(component.name);
    if (!nameNorm || seen.has(nameNorm)) continue;
    seen.add(nameNorm);
    if (alreadyFavored(h, foods, nameNorm)) continue;
    if (judge(component, nameNorm) !== "allowed") { skipped.push(nameNorm); continue; }
    const intent = reserveFoodMembershipIntent(nameNorm, h);
    const local = localFoodNamed(foods, nameNorm);
    if (!await markFavored(h, component.name, local, intent)) { skipped.push(nameNorm); continue; }
    if (local) setFoodStatus(local.id, "eats");
    newlyFavored.push(nameNorm);
    records.push({ name: nameNorm, rev: intent.rev, ...(local ? { localId: local.id } : {}) });
  }
  if (records.length > 0) {
    try {
      const index = (await getMeta<MarkIndex>(h, FAVORITE_MEAL_MARKS_KEY)) ?? {};
      await putMeta(h, FAVORITE_MEAL_MARKS_KEY, { ...index, [mealId]: records });
    } catch (e) {
      // Without the record, Undo leaves these marks alone (it never guesses a revision).
      rethrowAccountChanged(e);
    }
  }
  return { newlyFavored, skipped };
}

// ------------------------------------------------------------------------------ public

const inFlight = new Map<string, Promise<SaveFavoriteMealOutcome>>();

/**
 * Save the plate as a saved meal and remember it against `source`. Idempotent per plate: while a
 * live saved meal is recorded for `source`, a repeat (a double tap, or a retry after a save that
 * landed) answers that id and writes nothing. `AccountChanged` is rethrown, never an outcome.
 */
export function saveFavoriteMeal(
  input: FavoriteMealInput, opts: SaveFavoriteMealOptions = {},
): Promise<SaveFavoriteMealOutcome> {
  const h = opts.account === undefined ? currentAccountOrNull() : opts.account;
  if (h === null) {
    return Promise.resolve({ ok: false, reason: "refused", message: "Sign in to save meals." });
  }
  const key = `${h.userId}|${favoriteMealSourceKey(input.source)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = saveAs(h, input, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function saveAs(
  h: AccountHandle, input: FavoriteMealInput, opts: SaveFavoriteMealOptions,
): Promise<SaveFavoriteMealOutcome> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
  if (!name) return { ok: false, reason: "refused", message: "A saved meal needs a name." };
  if (input.components.length === 0 || input.components.length > ITEMS_MAX) {
    return { ok: false, reason: "refused", message: "This meal can't be saved as it is." };
  }
  assertCurrent(h);
  let existing: string | null;
  try {
    existing = await favoriteMealFor(input.source, h);
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason: "retry", message: RETRY };
  }
  if (existing) return { ok: true, id: existing, newlyFavored: [], skipped: [] };

  const online = opts.online ?? isOnline();
  const refs = { ...defaultRefs, ...opts.refs };
  const store = loadStore();
  const foods = opts.foods ?? { ...openWorldOf(opts.eligible)?.foods, ...store.foods };
  const items = await itemsFor(input.components, foods, h, refs, online);
  if (!Array.isArray(items)) return items;

  const id = crypto.randomUUID();
  const sourceKey = favoriteMealSourceKey(input.source);
  try {
    const sort = nextSort((await allRows(h, "favorites_meals"))
      .map((row) => ({ sort: Number(row.sort ?? 0) })));
    const now = new Date().toISOString();
    const opId = await uuidV5(NAMESPACE, `favorite-meal:create:${h.userId}:${id}`);
    await mutateRowWithOp(h, "favorites_meals", id, (_current, reads) => {
      const index = (reads.meta.get(FAVORITE_MEAL_SOURCES_KEY) as SourceIndex | undefined) ?? {};
      return {
        row: { id, name, sort, rev: 1, deleted_at: null, updated_at: now,
          items: items.map((item) => ({ meal_id: id, ...item })) },
        op: { op_id: opId, entity: "favorites_meals", entity_id: id, kind: "create",
          base_rev: null, payload: { id, name, sort, items }, client_ts: now },
        result: undefined,
        meta: [{ key: FAVORITE_MEAL_SOURCES_KEY,
          value: { ...index, [sourceKey]: { savedMealId: id, savedAt: now } } }],
      };
    });
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason: "retry", message: RETRY };
  }
  announceQueued();
  const favored = await favorFoods(h, id, input.components,
    opts.judge ?? defaultJudge(h, store.foods, store.settings, opts.eligible));
  announce();
  return { ok: true, id, ...favored };
}

/**
 * Remove exactly the saved meal `id`: a tombstone by id (`setFavorite`'s delete path), and every
 * source entry that points at it. A meal that is already gone answers ok. Never matches by name.
 */
export async function removeFavoriteMeal(
  id: string, opts: { account?: AccountHandle | null } = {},
): Promise<FavoriteMealOutcome> {
  const h = opts.account === undefined ? currentAccountOrNull() : opts.account;
  if (h === null) return { ok: false, reason: "refused", message: "Sign in to change saved meals." };
  try {
    await setFavorite("meal", id, false, undefined, h);
    const index = (await getMeta<SourceIndex>(h, FAVORITE_MEAL_SOURCES_KEY)) ?? {};
    const kept = Object.fromEntries(Object.entries(index).filter(([, v]) => v.savedMealId !== id));
    if (Object.keys(kept).length !== Object.keys(index).length) {
      await putMeta(h, FAVORITE_MEAL_SOURCES_KEY, kept);
    }
  } catch (e) {
    if (e instanceof AccountChanged) throw e;
    return { ok: false, reason: "retry", message: "Couldn't remove this saved meal. Try again." };
  }
  announce();
  return { ok: true, id };
}

/**
 * The live saved meal for this plate, or null: the meal saved from `source`, or the slot's meal
 * itself when it IS a saved meal (`saved:<id>`). A meal tombstoned or deleted on any device reads
 * null once its row is.
 */
export async function favoriteMealFor(
  source: FavoriteMealSource, h: AccountHandle | null = currentAccountOrNull(),
): Promise<string | null> {
  if (h === null) return null;
  const candidates: string[] = [];
  if (source.mealId?.startsWith(SAVED_PREFIX)) candidates.push(source.mealId.slice(SAVED_PREFIX.length));
  const index = (await getMeta<SourceIndex>(h, FAVORITE_MEAL_SOURCES_KEY)) ?? {};
  const recorded = index[favoriteMealSourceKey(source)]?.savedMealId;
  if (recorded) candidates.push(recorded);
  for (const id of candidates) {
    if (liveRow(await getRow(h, "favorites_meals", id) as Record<string, unknown> | undefined)) return id;
  }
  return null;
}

/**
 * Undo a heart ON: remove the saved meal `id`, then set back to neutral ONLY the `newlyFavored`
 * names whose Eats mark is still the one that save wrote (same status, same membership revision).
 * A name marked again since — here or, once pulled, on another device — and every name the save did
 * not record, stays as it is. Idempotent: a retry reports the same names cleared and writes nothing.
 */
export async function undoSaveFavoriteMeal(
  id: string, newlyFavored: readonly string[], opts: { account?: AccountHandle | null } = {},
): Promise<UndoFavoriteMealOutcome> {
  const h = opts.account === undefined ? currentAccountOrNull() : opts.account;
  if (h === null) return { ok: false, reason: "refused", message: "Sign in to change saved meals." };
  const removed = await removeFavoriteMeal(id, { account: h });
  if (!removed.ok) return removed;
  const cleared: string[] = [];
  const kept: string[] = [];
  try {
    const index = (await getMeta<MarkIndex>(h, FAVORITE_MEAL_MARKS_KEY)) ?? {};
    const records = (index[id] ?? []).map((record) => ({ ...record }));
    const foods = loadStore().foods;
    for (const name of new Set(newlyFavored.map((n) => normalizeFoodName(n)).filter(Boolean))) {
      const record = records.find((r) => r.name === name);
      if (!record) { kept.push(name); continue; }
      if (record.undone) { cleared.push(name); continue; }
      const now = readFoodMembership(h.userId, name);
      if (now?.status !== "eats" || now.rev !== record.rev) { kept.push(name); continue; }
      await setFoodMembership(name, null, { note: null, account: h });
      assertCurrent(h);
      const local = record.localId ? foods[record.localId] : undefined;
      if (local?.status === "eats") setFoodStatus(local.id, "neutral");
      record.undone = true;
      cleared.push(name);
    }
    if (records.length > 0) await putMeta(h, FAVORITE_MEAL_MARKS_KEY, { ...index, [id]: records });
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason: "retry", message: "Couldn't undo all of this. Try again." };
  }
  announce();
  return { ok: true, id, cleared, kept };
}
