/**
 * Save a meal card's plate as a saved meal (`favorites_meals` + `favorites_meal_items`), and remove
 * exactly that saved meal again. The meal card's heart is the only caller.
 *
 * Heart ON also marks each of the plate's foods Favored (owner extension, 2026-10-08): one
 * `food_membership` "eats" op per normalized name through `setFoodMembership`, the op every Eats add
 * queues. A food on Avoid, or not cleared under the account's current rules, is skipped. A food
 * already on Eats is left as it is. `newlyFavored` names the foods this saved meal's heart moved to
 * Eats, each with the membership revision it wrote, so `undoSaveFavoriteMeal` puts back exactly
 * those marks and never a later choice. Heart OFF (`removeFavoriteMeal`) removes the saved meal
 * only; the foods stay Favored. No `favorites_foods` star is ever written.
 *
 * Durability (Sol r1):
 * - The meal row, its create op, the source index entry and the meal's mark record (every name
 *   still to mark, `pending`) commit in ONE IndexedDB transaction (`favoritesTx`). That transaction
 *   first re-reads the source index and answers an existing live saved meal instead, so two tabs
 *   saving the same plate make one meal.
 * - Marks are resumable: a pending mark is finished, or re-judged, by the next save call for that
 *   plate and after every successful sync (`resumeFavoriteMealMarks`, started but never awaited by
 *   lib/sync/post-sync.ts, its eligible read bounded by a deadline).
 * - Each mark is ONE atomic write (Sol r3, `setFoodMembershipGuarded` in lib/foods/prefs-client.ts):
 *   in the transaction that queues the Eats op, it re-checks that the meal is live and not being
 *   removed in this tab, that the name is still pending, that the rules epoch is the verdict's, and
 *   that the device's mark for the name is not Avoid and is still the one seen at the verdict; it
 *   then moves the name from `pending` to `done` with the op's revision. If any check fails, or the
 *   transaction does not commit, nothing is written and the name stays pending (an Avoid since the
 *   verdict is skipped). `done` therefore names exactly the revisions this heart wrote, which is all
 *   Undo ever clears.
 * - Each meal's mark record is its own META key, read and written inside one transaction.
 * - Removal tombstones by id only, in one transaction with its delete op and the index change.
 *
 * Refs: an account food uses the refs its Foods row is known by (`foodRefsFor`) — the refs the swap
 * sheet maps a saved meal back to its foods with. A catalog-only food uses the log commit's registry
 * (`resolveFoodRef`); a bundled universe food is adopted as a log of it is (`adoptUserFood`, key
 * `user-food:<id>`). A ref that cannot be had right now answers `offline` (or `retry` online) and
 * writes nothing; a heart is one cheap tap to repeat, so it is never deferred like a picked log.
 * The existing `apply_sync_op` "favorites_meals" create writes the row and items in one server
 * transaction (20261025090200); no migration.
 */
import {
  AccountChanged, assertCurrent, currentAccountOrNull, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { nextSort } from "@/lib/favorites";
import { favoritesTx } from "@/lib/favorites-tx";
import { withinBudget } from "@/lib/fetch-with-deadline";
import { dbFood } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { adoptUserFood, bundledFoodUserId, per100gFromBundled } from "@/lib/foods/adopt-client";
import { loadEligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import { normalizeFoodName } from "@/lib/foods/normalize";
import {
  foodRefsFor, readFoodMembership, readPrefRefCache,
  membershipSeen, setFoodMembership, setFoodMembershipGuarded,
} from "@/lib/foods/prefs-client";
import { componentRuleMark, currentEligibleView, openWorldOf } from "@/lib/foods/rule-marks";
import { SYNCED_EVENT, foodRulesEpoch } from "@/lib/foods/rules-epoch";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import { uuidV5 } from "@/lib/foods/uuid5";
import { cachedFoodRef, rememberFoodRef, resolveFoodRef } from "@/lib/log-client";
import { parseFoodKey } from "@/lib/meals/food-key";
import { loadStore, setFoodStatus } from "@/lib/store";
import { META_STORE, getMeta, getRow, openAccountDb } from "@/lib/sync/idb";
import type { FoodComponent, Settings, SlotId } from "@/lib/types";

/** Where a saved meal came from: the plate on this date's slot. */
export type FavoriteMealSource = { date: string; slotId: SlotId; mealId: string | null };

export type FavoriteMealInput = { name: string; components: FoodComponent[]; source: FavoriteMealSource };

export type FavoriteMealFailure = { ok: false; reason: "offline" | "retry" | "refused"; message: string };

/**
 * Heart ON. Both lists hold normalized food names (`normalizeFoodName`). `newlyFavored`: every food
 * this saved meal's heart moved to Eats so far; `skipped`: Avoid or blocked foods, plus any still
 * pending after this call (a rules change mid-run, no verified rules, or a mark that did not land).
 */
export type SaveFavoriteMealOutcome =
  | { ok: true; id: string; newlyFavored: string[]; skipped: string[] }
  | FavoriteMealFailure;

/** Heart OFF. */
export type FavoriteMealOutcome = { ok: true; id: string } | FavoriteMealFailure;

/** Undo of a heart ON: `cleared` went back to neutral; `kept` were left as they are now. */
export type UndoFavoriteMealOutcome =
  | { ok: true; id: string; cleared: string[]; kept: string[] }
  | FavoriteMealFailure;

/**
 * What the rules say about Favoring one food right now. `unverified`: no current verified rules to
 * judge by — the mark stays pending for a later run (never marked, never dropped).
 */
export type FavorVerdict = "allowed" | "avoid" | "blocked" | "unverified";
export type FavorJudge = (food: { name: string }, nameNorm: string) => FavorVerdict;

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
   * Favored only when it is cleared under it; without one, marks wait for the post-sync run. An
   * open account's set also supplies the admitted universe pool.
   */
  eligible?: ReadonlySet<string>;
  /** Test seam: the rule verdict for one food. Default: Avoid, then `componentRuleMark`. */
  judge?: FavorJudge;
};

/** META key: source key → the saved meal made from that plate. Client-only, per account DB. */
export const FAVORITE_MEAL_SOURCES_KEY = "favorite_meal_sources";
type SourceIndex = Record<string, { savedMealId: string; savedAt: string }>;

/** META key prefix: one mark record per saved meal (`favorite_meal_marks:<meal id>`). */
export const FAVORITE_MEAL_MARKS_PREFIX = "favorite_meal_marks:";
type PendingMark = { name: string; nameNorm: string };
type DoneMark = { nameNorm: string; rev: number; localId?: string; undone?: true };
type MarkRecord = { pending: PendingMark[]; done: DoneMark[]; skipped: string[] };

const marksKey = (mealId: string) => `${FAVORITE_MEAL_MARKS_PREFIX}${mealId}`;

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

/** Read-modify-write of one META key in one readwrite transaction. */
async function updateMeta<T>(
  h: AccountHandle, key: string, fn: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  const db = await openAccountDb(h);
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);
  const next = fn((await store.get(key)) as T | undefined);
  assertCurrent(h);
  if (next === undefined) await store.delete(key);
  else await store.put(next, key);
  await tx.done;
  return next;
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
 * clear line is `allowed`; with no usable set (none, revoked, other diet flags) it is `unverified`.
 */
export function defaultFavorJudge(
  h: AccountHandle, foods: Record<string, Food>, settings: Pick<Settings, "dietPrefs">,
  eligible: ReadonlySet<string> | undefined,
): FavorJudge {
  const view = currentEligibleView(foods, settings, eligible);
  const admitted = Object.values(openWorldOf(eligible)?.foods ?? {});
  return (food, nameNorm) => {
    if (readFoodMembership(h.userId, nameNorm)?.status === "avoid") return "avoid";
    if (Object.values(foods).some((f) => f.status === "avoid" && normalizeFoodName(f.name) === nameNorm)) {
      return "avoid";
    }
    if (!view) return "unverified";
    return componentRuleMark(food, foods, view, admitted) === null ? "allowed" : "blocked";
  };
}

function alreadyFavored(h: AccountHandle, foods: Record<string, Food>, nameNorm: string): boolean {
  const mark = readFoodMembership(h.userId, nameNorm);
  if (mark) return mark.status === "eats";
  return Object.values(foods).some((f) => f.status === "eats" && normalizeFoodName(f.name) === nameNorm);
}

function markedAt(h: AccountHandle, nameNorm: string, rev: number): boolean {
  const now = readFoodMembership(h.userId, nameNorm);
  return now?.status === "eats" && now.rev === rev;
}

/** Take one name out of `pending` with no mark written (already Favored, or skipped). */
function dropPending(h: AccountHandle, mealId: string, nameNorm: string, skipped: boolean): Promise<unknown> {
  return updateMeta<MarkRecord>(h, marksKey(mealId), (current) => current && {
    ...current,
    pending: current.pending.filter((p) => p.nameNorm !== nameNorm),
    skipped: skipped && !current.skipped.includes(nameNorm) ? [...current.skipped, nameNorm] : current.skipped,
  });
}

/** One run per meal at a time in this tab; another tab's run is kept honest by the guard. */
const runs = new Map<string, Promise<unknown>>();

function runMarks(
  h: AccountHandle, mealId: string, judge: FavorJudge,
): Promise<{ newlyFavored: string[]; skipped: string[] }> {
  const key = `${h.userId}|${mealId}`;
  const run = (runs.get(key) ?? Promise.resolve()).catch(() => undefined)
    .then(() => markPending(h, mealId, judge));
  const tracked = run.finally(() => { if (runs.get(key) === tracked) runs.delete(key); });
  runs.set(key, tracked);
  return run;
}

/** Saved meals this tab is removing or has removed: read by the guard inside its transaction. */
const removing = new Set<string>();
const mealKey = (h: AccountHandle, mealId: string) => `${h.userId}|${mealId}`;

/**
 * Write one Eats mark atomically with its record (Sol r3): `setFoodMembershipGuarded` checks, in
 * the transaction that writes the op, that the meal is live and not being removed here, that the
 * name is still pending, that the rules epoch is the verdict's, and that the device's mark for the
 * name is still the one seen at the verdict and not Avoid. It then queues the op, moves the name
 * from `pending` to `done` with the op's revision — or writes nothing at all.
 */
async function writeMark(
  h: AccountHandle, mealId: string, mark: PendingMark, local: Food | undefined,
  verdictEpoch: number, seenRev: number | null,
): Promise<boolean> {
  const key = marksKey(mealId);
  const result = await setFoodMembershipGuarded(mark.name, "eats", {
    seenRev, entity: "favorites_meals", rowKeys: [mealId], metaKeys: [key],
    check: ({ rows: [row], meta: [stored] }, rev) => {
      const record = stored as MarkRecord | undefined;
      if (!liveRow(row) || removing.has(mealKey(h, mealId))) return null;
      if (!record?.pending.some((p) => p.nameNorm === mark.nameNorm)) return null;
      if (foodRulesEpoch() !== verdictEpoch) return null;
      const done: DoneMark = { nameNorm: mark.nameNorm, rev, ...(local ? { localId: local.id } : {}) };
      return { meta: [{ key, value: {
        ...record, pending: record.pending.filter((p) => p.nameNorm !== mark.nameNorm),
        done: [...record.done.filter((d) => d.nameNorm !== mark.nameNorm), done],
      } }] };
    },
  }, { account: h });
  return result.written;
}

async function markPending(
  h: AccountHandle, mealId: string, judge: FavorJudge,
): Promise<{ newlyFavored: string[]; skipped: string[] }> {
  const record = await getMeta<MarkRecord>(h, marksKey(mealId));
  if (!record) return { newlyFavored: [], skipped: [] };
  const foods = loadStore().foods;
  const unfinished: string[] = [];
  for (const mark of record.pending) {
    if (!liveRow(await getRow(h, "favorites_meals", mealId) as Record<string, unknown> | undefined)
      || removing.has(mealKey(h, mealId))) {
      await updateMeta<MarkRecord>(h, marksKey(mealId), (current) => current && { ...current, pending: [] });
      break;
    }
    const local = localFoodNamed(foods, mark.nameNorm);
    if (alreadyFavored(h, foods, mark.nameNorm)) { await dropPending(h, mealId, mark.nameNorm, false); continue; }
    const verdictEpoch = foodRulesEpoch();
    const seenRev = membershipSeen(h, mark.nameNorm);
    const verdict = judge({ name: mark.name }, mark.nameNorm);
    if (verdict === "avoid" || verdict === "blocked") { await dropPending(h, mealId, mark.nameNorm, true); continue; }
    if (verdict === "unverified") { unfinished.push(mark.nameNorm); continue; }
    let written = false;
    try {
      written = await writeMark(h, mealId, mark, local, verdictEpoch, seenRev);
    } catch (e) {
      // Nothing committed (the transaction aborted): the name stays pending.
      rethrowAccountChanged(e);
    }
    if (!written) {
      // A newer Avoid since the verdict is the user's answer: skip it rather than retry.
      if (readFoodMembership(h.userId, mark.nameNorm)?.status === "avoid") {
        await dropPending(h, mealId, mark.nameNorm, true);
      } else unfinished.push(mark.nameNorm);
      continue;
    }
    if (local) setFoodStatus(local.id, "eats");
  }
  const after = (await getMeta<MarkRecord>(h, marksKey(mealId))) ?? record;
  const live = liveRow(await getRow(h, "favorites_meals", mealId) as Record<string, unknown> | undefined);
  return {
    newlyFavored: after.done.map((d) => d.nameNorm),
    skipped: live ? [...after.skipped, ...unfinished.filter((n) => !after.skipped.includes(n))] : after.skipped,
  };
}

// ------------------------------------------------------------------------------ public

const inFlight = new Map<string, Promise<SaveFavoriteMealOutcome>>();

/**
 * Save the plate as a saved meal and remember it against `source`. Idempotent per plate: while a
 * live saved meal is recorded for `source` (checked again inside the write), a repeat answers that
 * id, writes no second meal, and finishes any marks still pending for it. `AccountChanged` is
 * rethrown, never an outcome.
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

function pendingFor(components: FoodComponent[]): PendingMark[] {
  const seen = new Set<string>();
  const out: PendingMark[] = [];
  for (const component of components) {
    const nameNorm = normalizeFoodName(component.name);
    if (!nameNorm || seen.has(nameNorm)) continue;
    seen.add(nameNorm);
    out.push({ name: component.name, nameNorm });
  }
  return out;
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
  const store = loadStore();
  const judge = () => opts.judge ?? defaultFavorJudge(h, loadStore().foods, store.settings, opts.eligible);
  let existing: string | null;
  try {
    existing = await favoriteMealFor(input.source, h);
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason: "retry", message: RETRY };
  }
  if (existing) return finish(h, existing, judge());

  const online = opts.online ?? isOnline();
  const refs = { ...defaultRefs, ...opts.refs };
  const foods = opts.foods ?? { ...openWorldOf(opts.eligible)?.foods, ...store.foods };
  const items = await itemsFor(input.components, foods, h, refs, online);
  if (!Array.isArray(items)) return items;

  const id = crypto.randomUUID();
  const sourceKey = favoriteMealSourceKey(input.source);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const opId = await uuidV5(NAMESPACE, `favorite-meal:create:${h.userId}:${id}`);
  let saved: string;
  try {
    saved = await favoritesTx(h, "favorites_meals", async (tx) => {
      // Another tab may have saved this plate since the check above: answer its meal instead.
      const index = (await tx.getMeta<SourceIndex>(FAVORITE_MEAL_SOURCES_KEY)) ?? {};
      const prior = index[sourceKey]?.savedMealId;
      if (prior && liveRow(await tx.get(prior))) return prior;
      const sort = nextSort((await tx.getAll()).map((row) => ({ sort: Number(row.sort ?? 0) })));
      await tx.put(id, { id, name, sort, rev: 1, deleted_at: null, updated_at: now,
        items: items.map((item) => ({ meal_id: id, ...item })) });
      await tx.enqueue({ op_id: opId, entity: "favorites_meals", entity_id: id, kind: "create",
        base_rev: null, payload: { id, name, sort, items }, client_ts: now });
      await tx.putMeta(FAVORITE_MEAL_SOURCES_KEY, { ...index, [sourceKey]: { savedMealId: id, savedAt: now } });
      const record: MarkRecord = { pending: pendingFor(input.components), done: [], skipped: [] };
      await tx.putMeta(marksKey(id), record);
      return id;
    }, nowMs);
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason: "retry", message: RETRY };
  }
  return finish(h, saved, judge());
}

async function finish(h: AccountHandle, id: string, judge: FavorJudge): Promise<SaveFavoriteMealOutcome> {
  let favored: { newlyFavored: string[]; skipped: string[] };
  try {
    favored = await runMarks(h, id, judge);
  } catch (e) {
    rethrowAccountChanged(e);
    // The meal stands; its marks stay pending for the next call or the post-sync run.
    const record = await getMeta<MarkRecord>(h, marksKey(id)).catch(() => undefined);
    favored = { newlyFavored: record?.done.map((d) => d.nameNorm) ?? [],
      skipped: [...(record?.skipped ?? []), ...(record?.pending.map((p) => p.nameNorm) ?? [])] };
  }
  announce();
  return { ok: true, id, ...favored };
}

/**
 * After a successful sync (lib/sync/post-sync.ts): finish every live saved meal's pending marks,
 * judged under a freshly verified eligible set. Nothing pending costs one META key read. A failed
 * rules read leaves every mark pending; it never marks without a verdict.
 */
export async function resumeFavoriteMealMarks(
  h: AccountHandle, foods: Record<string, Food>,
  loadEligible: (h: AccountHandle, foods: Record<string, Food>) => Promise<ReadonlySet<string>> =
  loadEligibleLocalFoodIds,
): Promise<void> {
  const db = await openAccountDb(h);
  const keys = (await db.getAllKeys(META_STORE)).map(String)
    .filter((key) => key.startsWith(FAVORITE_MEAL_MARKS_PREFIX));
  const waiting: string[] = [];
  for (const key of keys) {
    const record = await getMeta<MarkRecord>(h, key);
    if (!record?.pending.length) continue;
    const mealId = key.slice(FAVORITE_MEAL_MARKS_PREFIX.length);
    if (liveRow(await getRow(h, "favorites_meals", mealId) as Record<string, unknown> | undefined)) {
      waiting.push(mealId);
    }
  }
  if (waiting.length === 0) return;
  let eligible: ReadonlySet<string> | null;
  try {
    // Bounded: a read that never answers leaves every mark pending for the next pass.
    eligible = await withinBudget(loadEligible(h, foods), "prefs", null);
  } catch (e) {
    rethrowAccountChanged(e);
    return;
  }
  if (eligible === null) return;
  const judge = defaultFavorJudge(h, foods, loadStore().settings, eligible);
  for (const mealId of waiting) await runMarks(h, mealId, judge);
  announce();
}

/**
 * Remove exactly the saved meal `id`: its tombstone, its delete op and the index entries that point
 * at it, in one transaction. Marks still pending for it are dropped (marks it already wrote stay:
 * heart OFF never un-Favors). A meal that is already gone answers ok. Never matches by name.
 */
export async function removeFavoriteMeal(
  id: string, opts: { account?: AccountHandle | null } = {},
): Promise<FavoriteMealOutcome> {
  const h = opts.account === undefined ? currentAccountOrNull() : opts.account;
  if (h === null) return { ok: false, reason: "refused", message: "Sign in to change saved meals." };
  // Synchronously, before any await: a mark run in this tab stops at its final check.
  removing.add(mealKey(h, id));
  try {
    await favoritesTx(h, "favorites_meals", async (tx) => {
      const row = await tx.get(id);
      if (row && !row.deleted_at) {
        const now = new Date().toISOString();
        await tx.put(id, { ...row, deleted_at: now });
        await tx.enqueue({ op_id: crypto.randomUUID(), entity: "favorites_meals", entity_id: id,
          kind: "delete", base_rev: typeof row.rev === "number" ? row.rev : null, payload: {},
          client_ts: now });
      }
      const index = (await tx.getMeta<SourceIndex>(FAVORITE_MEAL_SOURCES_KEY)) ?? {};
      const kept = Object.fromEntries(Object.entries(index).filter(([, v]) => v.savedMealId !== id));
      if (Object.keys(kept).length !== Object.keys(index).length) {
        await tx.putMeta(FAVORITE_MEAL_SOURCES_KEY, kept);
      }
      const record = await tx.getMeta<MarkRecord>(marksKey(id));
      if (record?.pending.length) await tx.putMeta(marksKey(id), { ...record, pending: [] });
    });
  } catch (e) {
    // Not removed: a run may mark again (the meal and its heart still stand).
    removing.delete(mealKey(h, id));
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
 * names whose Eats mark is still the one that heart wrote (same status, same membership revision).
 * A name marked again since, and every name the heart did not record, stays as it is. Marks still
 * pending are dropped, so no later run marks them. Idempotent: a retry reports the same names
 * cleared and writes nothing.
 */
export async function undoSaveFavoriteMeal(
  id: string, newlyFavored: readonly string[], opts: { account?: AccountHandle | null } = {},
): Promise<UndoFavoriteMealOutcome> {
  const h = opts.account === undefined ? currentAccountOrNull() : opts.account;
  if (h === null) return { ok: false, reason: "refused", message: "Sign in to change saved meals." };
  // Any run in flight for this meal finishes (and records its revision) before Undo reads.
  await runs.get(`${h.userId}|${id}`)?.catch(() => undefined);
  const removed = await removeFavoriteMeal(id, { account: h });
  if (!removed.ok) return removed;
  const cleared: string[] = [];
  const kept: string[] = [];
  try {
    const record = await getMeta<MarkRecord>(h, marksKey(id));
    const foods = loadStore().foods;
    for (const name of new Set(newlyFavored.map((n) => normalizeFoodName(n)).filter(Boolean))) {
      const done = record?.done.find((d) => d.nameNorm === name);
      if (!done) { kept.push(name); continue; }
      if (done.undone) { cleared.push(name); continue; }
      if (!markedAt(h, name, done.rev)) { kept.push(name); continue; }
      await setFoodMembership(name, null, { note: null, account: h });
      assertCurrent(h);
      const local = done.localId ? foods[done.localId] : undefined;
      if (local?.status === "eats") setFoodStatus(local.id, "neutral");
      await updateMeta<MarkRecord>(h, marksKey(id), (current) => current && {
        ...current, done: current.done.map((d) => d.nameNorm === name ? { ...d, undone: true } : d),
      });
      cleared.push(name);
    }
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason: "retry", message: "Couldn't undo all of this. Try again." };
  }
  announce();
  return { ok: true, id, cleared, kept };
}
