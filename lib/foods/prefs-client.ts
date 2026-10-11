/**
 * Their Eats/Avoid marks → one normalized-name membership op — T1 §1 / U3.
 *
 * `lib/store.ts` writes the legacy `foods` map and stays synchronous and pure; this file is the
 * asynchronous half that gives the same change a row the SERVER can read, which is what the coach,
 * search, the scanner and the log commit all judge against. Until T1 nothing emitted the op at
 * all, so a food marked Avoid on the phone was invisible to every one of them.
 *
 * Three facts shape the resolution order below:
 *
 * 1. The 2026-09-11 legacy backfill minted their `user_foods` rows with fresh uuids and no slug
 *    column, so the only join back from a `lib/foods.ts` id is `user_foods.name` — the same join
 *    `scripts/apply-food-mapping.ts` makes. A food with no row yet gets one under a v5 id derived
 *    from (their user id, the legacy slug), so a second device mints the same row instead of a twin.
 * 2. `food_refs` is catalog XOR user, and the policy's callers read `prefStatus` through the
 *    CATALOG ref of a search hit. Both refs must exist before the name-wide server transaction can
 *    update them together.
 * 3. The op is keyed by normalized name, never by one ref. Nothing here pushes; SyncBootstrap
 *    hears OUTBOX_QUEUED_EVENT and runs the pass.
 *
 * A direct mark throws a typed error when its refs cannot be completed, so the Foods tab can say
 * the save failed. The backfill catches that error, leaves the food uncached, and retries later.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { withPerUnit, type Food, type FoodStatus } from "@/lib/foods";
import { normalizeFoodName } from "@/lib/foods/normalize";
import { uuidV5 } from "@/lib/foods/uuid5";
import {
  accountFetch, accountHandle, assertCurrent, currentAccountOrNull, isCurrent,
  rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import { loadStore, saveStoreFor } from "@/lib/store";
import { browserClient } from "@/lib/supabase/client";
import {
  META_STORE, OUTBOX_SEQ_KEY, OUTBOX_STORE, forgetMealSnapshot, getRow, openAccountDb, outboxRow, putRow,
} from "@/lib/sync/idb";
import { announceQueued, enqueue } from "@/lib/sync/outbox";
import type { Entity, OpResult, SyncOp } from "@/lib/sync/types";
import { perUnitTo100g } from "@/lib/units";
import { accountUnitGrams } from "@/lib/foods/unit-grams";

/** The status a ref carries now, or null when the user has never marked it (T6 Undo). */
export async function currentPrefStatus(
  refId: string, h: AccountHandle = accountHandle(),
): Promise<{ status: Exclude<FoodStatus, "neutral">; note: string | null;
  role?: Food["role"]; noCook?: boolean } | null> {
  try {
    const mirror = (await getRow(h, "user_food_prefs", refId)) as
      { status?: unknown; note?: unknown; role?: unknown; no_cook?: unknown;
        deleted_at?: unknown } | undefined;
    if (!mirror || mirror.deleted_at) return null;
    if (mirror.status !== "eats" && mirror.status !== "avoid") return null;
    const role = mirror.role === "protein" || mirror.role === "carb" || mirror.role === "fat"
      ? mirror.role : undefined;
    return { status: mirror.status, note: typeof mirror.note === "string" ? mirror.note : null,
      ...(role ? { role } : {}),
      ...(typeof mirror.no_cook === "boolean" ? { noCook: mirror.no_cook } : {}) };
  } catch (e) { rethrowAccountChanged(e); return null; }
}

/** The ref ids a food resolved to, so a repeat mark costs no network at all. */
export const FOOD_PREF_REFS_KEY = "meal-companion:food-pref-refs";

/** One run's share of the backlog. 53 foods take three runs; the rest wait rather than stampede. */
export const BACKFILL_PER_RUN = 20;

/** The same fixed namespace lib/foods/adopt-client.ts derives bundled ids in. */
const LEGACY_FOOD_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Their own rows: `recipe` is the recipes entity's own twin and is never a food the user marks. */
const OWN_FOOD_KINDS = ["custom", "label_scan"] as const;

export type FoodPrefRefs = {
  userRefId: string;
  catalogRefId?: string;
  syncedAt: string;
  status: FoodStatus | null;
  note: string | null;
  nameNorm?: string;
};

export type FoodPrefRefCache = Record<string, FoodPrefRefs>;

/** The stored blob: one map per account, so a second sign-in on the same browser starts empty. */
type StoredCache = Record<string, FoodPrefRefCache>;

export type FoodMembershipCacheEntry = {
  status: Exclude<FoodStatus, "neutral"> | null;
  note: string | null;
  rev: number;
};

export const FOOD_MEMBERSHIP_SAVE_MESSAGE = "Could not save — try again";
export const FOOD_MEMBERSHIP_TRUNCATED_MESSAGE =
  "Marked; some duplicate catalog rows were skipped";

export class FoodMembershipSaveError extends Error {
  readonly code = "food_ref_mint_incomplete";

  constructor(message = FOOD_MEMBERSHIP_SAVE_MESSAGE) {
    super(message);
    this.name = "FoodMembershipSaveError";
  }
}

const MEMBERSHIP_CACHE_PREFIX = "membership:";
const membershipRevisions = new Map<string, number>();
const membershipIntents = new Map<string, number>();
const activeMembershipCalls = new Map<string, number>();

export type FoodMembershipIntent = Readonly<{
  account: AccountHandle; nameNorm: string; key: string; sequence: number; rev: number; at: number;
}>;

/** Reserve at the user's action boundary, before any previous-status or ref read can stall. */
export function reserveFoodMembershipIntent(
  name: string, account: AccountHandle = accountHandle(), now: number = Date.now(),
): FoodMembershipIntent {
  assertCurrent(account);
  const nameNorm = normalizeFoodName(name);
  if (!nameNorm) throw new TypeError("Food membership needs a name");
  const clockKey = `${account.userId}:${nameNorm}`;
  const key = `${account.epoch}:${clockKey}`;
  const at = Math.max(0, Math.floor(now));
  const previous = readFoodMembership(account.userId, nameNorm);
  const rev = Math.max(at, (previous?.rev ?? -1) + 1, (membershipRevisions.get(clockKey) ?? -1) + 1);
  membershipRevisions.set(clockKey, rev);
  const sequence = (membershipIntents.get(key) ?? 0) + 1;
  membershipIntents.set(key, sequence);
  return { account, nameNorm, key, sequence, rev, at };
}

export function isLatestFoodMembershipIntent(intent: FoodMembershipIntent): boolean {
  return isCurrent(intent.account) && membershipIntents.get(intent.key) === intent.sequence;
}

/** Test-only: browser navigation keeps this clock; a fresh test/device does not. */
export function __resetFoodMembershipState(): void {
  membershipRevisions.clear();
  membershipIntents.clear();
  activeMembershipCalls.clear();
}

/**
 * Debounces the Eats facet warm ping (app/api/foods/facets/warm/route.ts) per account: a burst of
 * marks inside the same ~2s window sends exactly one request, timed from the LAST mark in it,
 * rather than one per tap. Fire-and-forget on purpose — nothing here may block or fail the mark
 * it follows, so a failure (offline, rate-limited, a stale account) is swallowed and left for the
 * daily `/api/jobs/facet-warm` cron to pick up instead.
 */
const EATS_WARM_DEBOUNCE_MS = 2_000;
/** Test seam: real timers at the real 2s delay would make every covering test slow. */
let eatsWarmDebounceMs = EATS_WARM_DEBOUNCE_MS;
const eatsWarmTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Test-only: a short delay so a real `setTimeout` still proves the debounce without a slow test. */
export function __setEatsFacetWarmDebounceMsForTests(ms: number = EATS_WARM_DEBOUNCE_MS): void {
  eatsWarmDebounceMs = ms;
}

function scheduleEatsFacetWarm(h: AccountHandle, fetchImpl?: typeof fetch): void {
  const existing = eatsWarmTimers.get(h.userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    eatsWarmTimers.delete(h.userId);
    if (!isCurrent(h)) return;
    void accountFetch(h, "/api/foods/facets/warm", { method: "POST" },
      { budget: "prefs", fetchImpl }).catch(() => {
        // Best-effort only; see the doc comment above.
      });
  }, eatsWarmDebounceMs);
  // Node only: a browser timer id has no unref, and a pending repaint is reason enough to keep
  // the tab alive anyway — only a test process should never be held open by this.
  (timer as unknown as { unref?: () => void }).unref?.();
  eatsWarmTimers.set(h.userId, timer);
}

/** Test-only: a ping left pending past its test would fire later, against whatever the next test
 *  stubs (or does not stub) for `fetch`. */
export function __resetEatsFacetWarmTimers(): void {
  for (const timer of eatsWarmTimers.values()) clearTimeout(timer);
  eatsWarmTimers.clear();
  eatsWarmDebounceMs = EATS_WARM_DEBOUNCE_MS;
}

export type SyncFoodPrefOptions = {
  /** Test seam and the offline path: the client the two RPCs and the one read go through. */
  supabase?: SupabaseClient;
  /** Passed to `browserClient` when no client is supplied. */
  fetchImpl?: typeof fetch;
  /** The account a delayed caller started as. Default: the bound one. */
  account?: AccountHandle;
};

function readStoredCache(): StoredCache {
  try {
    const raw = localStorage.getItem(FOOD_PREF_REFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredCache) : {};
  } catch {
    return {};
  }
}

/** One account's ref ids. A ref id is scoped to the account that minted it, so the cache is too. */
export function readPrefRefCache(userId: string): FoodPrefRefCache {
  const entry = readStoredCache()[userId];
  if (typeof entry !== "object" || entry === null) return {};
  return Object.fromEntries(Object.entries(entry)
    .filter(([key]) => !key.startsWith(MEMBERSHIP_CACHE_PREFIX))) as FoodPrefRefCache;
}

/** The latest logical mark queued for one normalized name on this device. */
export function readFoodMembership(
  userId: string, name: string,
): FoodMembershipCacheEntry | undefined {
  const value = readStoredCache()[userId]?.[`${MEMBERSHIP_CACHE_PREFIX}${normalizeFoodName(name)}`] as
    unknown;
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Partial<FoodMembershipCacheEntry>;
  if (row.status !== null && row.status !== "eats" && row.status !== "avoid") return undefined;
  if (typeof row.rev !== "number" || !Number.isSafeInteger(row.rev) || row.rev < 0) return undefined;
  return {
    status: row.status,
    note: typeof row.note === "string" ? row.note : null,
    rev: row.rev,
  };
}

function rememberMembership(
  userId: string, nameNorm: string, membership: FoodMembershipCacheEntry,
): void {
  try {
    const stored = readStoredCache();
    const account = { ...(stored[userId] ?? {}) } as Record<string, unknown>;
    const current = account[`${MEMBERSHIP_CACHE_PREFIX}${nameNorm}`] as
      Partial<FoodMembershipCacheEntry> | undefined;
    if (typeof current?.rev === "number" && current.rev > membership.rev) return;
    account[`${MEMBERSHIP_CACHE_PREFIX}${nameNorm}`] = membership;
    for (const [key, value] of Object.entries(account)) {
      if (key.startsWith(MEMBERSHIP_CACHE_PREFIX)
        || typeof value !== "object" || value === null) continue;
      const refs = value as FoodPrefRefs;
      if (refs.nameNorm === nameNorm) account[key] = {
        ...refs, status: membership.status, note: membership.note, syncedAt: new Date().toISOString(),
      };
    }
    localStorage.setItem(FOOD_PREF_REFS_KEY, JSON.stringify({ ...stored, [userId]: account }));
  } catch {
    // The outbox is authoritative for delivery; a disabled cache only loses the local no-op fast path.
  }
}

export type SetFoodMembershipOptions = SyncFoodPrefOptions & {
  note?: string | null;
  now?: () => number;
  /** Local Foods-sheet rows need their user/catalog refs minted before the name-wide op runs. */
  food?: Food;
  /** Foods-sheet only: ask the RPC for its bounded-update acknowledgement; the outbox stays durable. */
  acknowledge?: boolean;
  /** A Coach action may reserve this before reading the prior status for Undo. */
  intent?: FoodMembershipIntent;
};

export type FoodMembershipAcknowledgement = { updated: number; truncated: boolean };

/**
 * Queue one logical, normalized-name membership operation. The sync route dispatches the outbox
 * entity to `set_food_membership`, whose one transaction updates the bounded matching-ref set. The
 * Foods sheet may also request an immediate, idempotent acknowledgement so it can show truncation;
 * the queued operation remains the durable fallback. A repeat of the same local intent is a no-op;
 * a changed intent advances the bigint revision even when two taps share one clock millisecond.
 */
export async function setFoodMembership(
  name: string,
  status: Exclude<FoodStatus, "neutral"> | null,
  opts: SetFoodMembershipOptions = {},
): Promise<FoodMembershipAcknowledgement | null> {
  const nameNorm = normalizeFoodName(name);
  if (!nameNorm) throw new TypeError("Food membership needs a name");
  // Phase 9 §0.1: the account is the handle this mark started with, never a claims read after an
  // await (audit plan r3 finding 3).
  const h = opts.account ?? accountHandle();
  assertCurrent(h);
  const reserved = opts.intent ?? reserveFoodMembershipIntent(nameNorm, h, (opts.now ?? Date.now)());
  if (reserved.account.userId !== h.userId || reserved.account.epoch !== h.epoch
    || reserved.nameNorm !== nameNorm) throw new TypeError("Food membership intent does not match");
  if (!isLatestFoodMembershipIntent(reserved)) return null;
  const olderActive = (activeMembershipCalls.get(reserved.key) ?? 0) > 0;
  activeMembershipCalls.set(reserved.key, (activeMembershipCalls.get(reserved.key) ?? 0) + 1);
  try {
    return await commitFoodMembership(nameNorm, status, opts, h, reserved.at, reserved.rev,
      reserved.key, reserved.sequence, olderActive);
  } finally {
    const remaining = (activeMembershipCalls.get(reserved.key) ?? 1) - 1;
    if (remaining > 0) activeMembershipCalls.set(reserved.key, remaining);
    else activeMembershipCalls.delete(reserved.key);
  }
}

async function commitFoodMembership(
  nameNorm: string, status: Exclude<FoodStatus, "neutral"> | null,
  opts: SetFoodMembershipOptions, h: AccountHandle, at: number, rev: number,
  intentKey: string, intent: number, olderActive: boolean,
): Promise<FoodMembershipAcknowledgement | null> {
  const userId = h.userId;
  const supabase = opts.supabase ?? browserClient({ fetch: opts.fetchImpl });
  const note = opts.note ?? null;
  const latest = () => membershipIntents.get(intentKey) === intent;
  const cached = opts.food ? readPrefRefCache(userId)[opts.food.id] : undefined;
  let refs: ResolvedRefs | null = null;
  if (opts.food) {
    if (cached?.userRefId) {
      refs = { userRefId: cached.userRefId, catalogRefId: cached.catalogRefId, complete: true };
    } else {
      try {
        refs = await resolveRefs(h, supabase, opts.food);
      } catch (e) {
        rethrowAccountChanged(e);
        assertCurrent(h);
        if (!latest()) return null;
        throw new FoodMembershipSaveError();
      }
    }
  }
  assertCurrent(h);
  if (!latest()) return null;
  if (opts.food && (!refs || !refs.complete)) throw new FoodMembershipSaveError();
  const previous = readFoodMembership(userId, nameNorm);
  // A later identical tap may need to undo an earlier op that is still being queued.
  const unchanged = !olderActive && previous?.status === status && previous.note === note;
  if (unchanged) {
    if (opts.food && refs) rememberRefs(userId, opts.food.id, {
      userRefId: refs.userRefId,
      ...(refs.catalogRefId ? { catalogRefId: refs.catalogRefId } : {}),
      syncedAt: new Date().toISOString(), status, note, nameNorm,
    });
    return null;
  }
  const id = await uuidV5(LEGACY_FOOD_NAMESPACE, `food-membership:${userId}:${nameNorm}`);
  assertCurrent(h);
  if (!latest()) return null;
  await enqueue(h, {
    op_id: crypto.randomUUID(),
    entity: "food_membership",
    entity_id: id,
    kind: "update",
    base_rev: null,
    payload: { id, name_norm: nameNorm, status, note, rev },
    client_ts: new Date(at).toISOString(),
  });
  if (!latest()) return null;
  rememberMembership(userId, nameNorm, { status, note, rev });
  // A new Eats mark is the only thing a packaged/prepared food's facets have ever been missing
  // for — warm it off the hot path, debounced, so marking several foods in a burst still costs
  // one request (lib/server/eats-facet-warm.ts, app/api/foods/facets/warm/route.ts). Nothing here
  // may block or fail this mark: scheduleEatsFacetWarm never throws and never awaits the ping.
  if (status === "eats") scheduleEatsFacetWarm(h, opts.fetchImpl);
  if (opts.food && refs) rememberRefs(userId, opts.food.id, {
    userRefId: refs.userRefId,
    ...(refs.catalogRefId ? { catalogRefId: refs.catalogRefId } : {}),
    syncedAt: new Date(at).toISOString(), status, note, nameNorm,
  });
  if (!opts.acknowledge) return null;

  let response: { data: unknown; error: unknown };
  try {
    response = await withAccount(h, (owner) => supabase.rpc("set_food_membership", {
      p_user: owner, p_name_norm: nameNorm, p_status: status, p_note: note, p_rev: rev,
    }));
  } catch (cause) {
    rethrowAccountChanged(cause);
    return null; // the durable membership op is already queued
  }
  if (!latest()) return null;
  const { data, error } = response;
  if (error) return null;
  const result = data as Record<string, unknown> | null;
  if (result?.rev !== rev || result.status !== status
    || typeof result.updated !== "number" || !Number.isSafeInteger(result.updated)
    || result.updated < 0 || typeof result.truncated !== "boolean") return null;
  return { updated: result.updated, truncated: result.truncated };
}

/**
 * The local membership a guarded write must still find (`setFoodMembershipGuarded`): the cached
 * mark's revision for this name, or null when this device holds none. Read it when the verdict is
 * made.
 */
export function membershipSeen(h: AccountHandle, name: string): number | null {
  return readFoodMembership(h.userId, normalizeFoodName(name))?.rev ?? null;
}

/** What a guarded membership write reads in its transaction, and what it adds when it passes. */
export type MembershipGuard = {
  /** `membershipSeen` at verdict time. A different revision now means a newer choice: refuse. */
  seenRev: number | null;
  /** The entity store the guard reads rows from, and the keys. */
  entity: Entity;
  rowKeys: readonly string[];
  /** META keys the guard reads. */
  metaKeys: readonly string[];
  /**
   * SYNCHRONOUS, over the rows read inside the transaction. Null refuses (nothing is written);
   * otherwise the META values to write beside the membership op, given the op's revision.
   */
  check: (read: { rows: (Record<string, unknown> | undefined)[]; meta: unknown[] }, rev: number) =>
    { meta: readonly { key: string; value: unknown }[] } | null;
};

export type GuardedMembershipResult = { written: true; rev: number } | { written: false };

/**
 * `setFoodMembership` for a write that must not land once its reason is gone (the meal card heart,
 * lib/favorite-meals-client.ts). The op id, the membership id and the next revision are made
 * BEFORE the transaction opens; inside ONE readwrite transaction over the guard's entity, the
 * outbox and META, the guard's rows are read and then, with no other await, the write is checked:
 * this device's mark for the name is not Avoid and is still the one seen at verdict time, no other
 * mark of that name is reserved or in flight here, and the caller's `check` passes. Only then are
 * the membership op and the caller's META values written, together. Otherwise nothing is.
 *
 * Name-only (no ref minting) and no acknowledgement: the queued op is the durable record, as for
 * any membership mark. The device's mark cache (localStorage) and the in-memory revision clock are
 * updated as the write commits, so a later tap orders after it. Every other caller keeps
 * `setFoodMembership` unchanged.
 */
export async function setFoodMembershipGuarded(
  name: string, status: "eats", guard: MembershipGuard,
  opts: { account: AccountHandle; now?: () => number },
): Promise<GuardedMembershipResult> {
  const h = opts.account;
  assertCurrent(h);
  const nameNorm = normalizeFoodName(name);
  if (!nameNorm) throw new TypeError("Food membership needs a name");
  const userId = h.userId;
  const clockKey = `${userId}:${nameNorm}`;
  const intentKey = `${h.epoch}:${clockKey}`;
  const at = Math.max(0, Math.floor((opts.now ?? Date.now)()));
  // Everything that awaits or derives happens here, before the transaction.
  const id = await uuidV5(LEGACY_FOOD_NAMESPACE, `food-membership:${userId}:${nameNorm}`);
  const opId = crypto.randomUUID();
  const db = await openAccountDb(h);
  const tx = db.transaction([guard.entity, OUTBOX_STORE, META_STORE], "readwrite");
  const done = tx.done;
  let restoreClock: (() => void) | null = null;
  try {
    const rows = await Promise.all(guard.rowKeys.map((key) =>
      tx.objectStore(guard.entity).get(key) as Promise<Record<string, unknown> | undefined>));
    const meta = await Promise.all(guard.metaKeys.map((key) => tx.objectStore(META_STORE).get(key)));
    const seq = (((await tx.objectStore(META_STORE).get(OUTBOX_SEQ_KEY)) as number | undefined) ?? 0) + 1;
    // ---- synchronous from here to the writes ----
    assertCurrent(h);
    const current = readFoodMembership(userId, nameNorm);
    const currentRev = current?.rev ?? null;
    const clock = membershipRevisions.get(clockKey);
    const busy = (activeMembershipCalls.get(intentKey) ?? 0) > 0
      || (clock ?? -1) > (currentRev ?? -1);
    if (current?.status === "avoid" || currentRev !== guard.seenRev || busy) {
      await abortQuietly(tx, done);
      return { written: false };
    }
    // Known limit, deferred (Sol r4 #2, logged as a follow-up): the revision clock is per tab, so
    // two tabs writing the same name in the same millisecond can mint equal revisions. That is a
    // property of the shared membership clock (`reserveFoodMembershipIntent`) and affects every
    // `setFoodMembership` caller, not only this one.
    const rev = Math.max(at, (currentRev ?? -1) + 1, (clock ?? -1) + 1);
    const extra = guard.check({ rows, meta }, rev);
    if (!extra) {
      await abortQuietly(tx, done);
      return { written: false };
    }
    restoreClock = () => {
      if (membershipRevisions.get(clockKey) !== rev) return;
      if (clock === undefined) membershipRevisions.delete(clockKey);
      else membershipRevisions.set(clockKey, clock);
    };
    membershipRevisions.set(clockKey, rev);
    membershipIntents.set(intentKey, (membershipIntents.get(intentKey) ?? 0) + 1);
    const op: SyncOp = {
      op_id: opId, entity: "food_membership", entity_id: id, kind: "update", base_rev: null,
      payload: { id, name_norm: nameNorm, status, note: null, rev }, client_ts: new Date(at).toISOString(),
    };
    const queued = outboxRow(h, op, seq, at);
    const writes: Promise<unknown>[] = [
      tx.objectStore(META_STORE).put(seq, OUTBOX_SEQ_KEY),
      tx.objectStore(OUTBOX_STORE).put(queued),
      ...extra.meta.map((m) => tx.objectStore(META_STORE).put(m.value, m.key)),
    ];
    // An aborted transaction rejects every request; the abort is reported once, through `done`.
    for (const w of writes) w.catch(() => undefined);
    await Promise.all(writes);
    await done;
    rememberMembership(userId, nameNorm, { status, note: null, rev });
    announceQueued();
    // A food_membership write is a meal snapshot input (lib/sync/idb.ts SNAPSHOT_INPUTS).
    void forgetMealSnapshot(h).catch(() => undefined);
    scheduleEatsFacetWarm(h);
    return { written: true, rev };
  } catch (error) {
    await abortQuietly(tx, done);
    // Nothing committed: the revision this write took is released for the next one.
    restoreClock?.();
    throw error;
  }
}

async function abortQuietly(tx: { abort(): void }, done: Promise<void>): Promise<void> {
  try { tx.abort(); } catch { /* already finished */ }
  await done.catch(() => undefined);
}

/**
 * Repair this device's mark cache from a durable record of a mark it queued (the meal card heart's
 * `done` list, lib/favorite-meals-client.ts): the IndexedDB commit that queued the op lands before
 * the localStorage cache write, so a crash between them leaves the cache behind. Writes only when
 * the cache has no entry for the name or an OLDER revision; a newer choice is never overwritten.
 * Returns true when the cache now holds exactly this mark.
 */
export function repairFoodMembershipCache(
  h: AccountHandle, name: string, mark: { status: "eats"; rev: number },
): boolean {
  assertCurrent(h);
  const nameNorm = normalizeFoodName(name);
  const current = readFoodMembership(h.userId, nameNorm);
  if (current && current.rev > mark.rev) return false;
  if (!current || current.rev < mark.rev) {
    rememberMembership(h.userId, nameNorm, { status: mark.status, note: null, rev: mark.rev });
  }
  const now = readFoodMembership(h.userId, nameNorm);
  return now?.rev === mark.rev && now.status === mark.status;
}

/** A stale device lost to a newer server revision. Revert only if no newer local tap superseded it. */
export function reconcileFoodMembership(
  h: AccountHandle,
  userId: string,
  name: string,
  status: Exclude<FoodStatus, "neutral"> | null,
  serverRev: number,
  rejectedRev: number,
): boolean {
  const nameNorm = normalizeFoodName(name);
  const previous = readFoodMembership(userId, nameNorm);
  if (previous && previous.rev > rejectedRev) return false;
  rememberMembership(userId, nameNorm, {
    status, note: previous?.note ?? null, rev: serverRev,
  });

  const store = loadStore();
  const nextStatus: FoodStatus = status ?? "neutral";
  let changed = false;
  const foods: Record<string, Food> = Object.fromEntries(
    Object.entries(store.foods).map(([id, food]): [string, Food] => {
      if (normalizeFoodName(food.name) !== nameNorm || food.status === nextStatus) {
        return [id, food];
      }
      changed = true;
      return [id, { ...food, status: nextStatus, updatedAt: new Date().toISOString() }];
    }));
  if (changed) saveStoreFor(h, { ...store, foods }, { silent: true });
  return true;
}

/** Read-modify-write of one entry. Never throws: a full or disabled store only costs a retry. */
function rememberRefs(userId: string, foodId: string, refs: FoodPrefRefs): void {
  try {
    const stored = readStoredCache();
    const account = stored[userId] ?? {};
    localStorage.setItem(FOOD_PREF_REFS_KEY, JSON.stringify({
      ...stored, [userId]: { ...account, [foodId]: refs },
    }));
  } catch {
    // No localStorage (private browsing, or a headless run). The op is queued either way; the
    // only cost is that the next run repeats the two RPCs.
  }
}

type UserFoodRow = { id: string; catalog_food_id: number | null; rev: number };

/**
 * `perUnitTo100g` needs a gram weight for their household unit, and `gramsPerUnit` cannot always
 * find one (a pouch or a can with no database row). The spec's rule: `{}` and carry on — a pref
 * with no nutrients still reaches the policy, which is the whole point of the row. Throwing here
 * would lose the Avoid mark over a number nothing on this path reads.
 */
export function per100gFor(food: Food): Record<string, number> {
  // The same weight the logger and the Foods page use (lib/foods/unit-grams.ts): starter first.
  const grams = accountUnitGrams(food);
  return grams === null ? {} : perUnitTo100g(food.perUnit, grams, food.kcalPerUnit);
}

async function foodRefFor(
  h: AccountHandle, supabase: SupabaseClient,
  kind: "user" | "catalog", catalogFoodId: number | null, userFoodId: string | null,
): Promise<string | null> {
  const { data, error } = await withAccount(h, (owner) => supabase.rpc("get_or_create_food_ref", {
    p_user_id: owner, p_kind: kind,
    p_catalog_food_id: catalogFoodId, p_user_food_id: userFoodId,
  }));
  return error || typeof data !== "string" ? null : data;
}

/**
 * Their row for this food, minting one when the backfill never made it. Null when a write refused.
 *
 * The ordering is not cosmetic: two rows can share a name (the 2026-09-11 backfill minted one and
 * `adoptBundledFood` or a label scan minted another), and only a MAPPED row carries the catalog
 * ref that search, the scanner and the coach read. Take the mapped one, then the oldest.
 */
async function userFoodRowFor(
  h: AccountHandle, supabase: SupabaseClient, food: Food,
): Promise<UserFoodRow | null> {
  const userId = h.userId;
  const found = await withAccount(h, (owner) => supabase.from("user_foods")
    .select("id, catalog_food_id, rev")
    .eq("user_id", owner)
    .eq("name", food.name)
    .in("kind", OWN_FOOD_KINDS)
    .is("deleted_at", null)
    .order("catalog_food_id", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle());
  if (found.error) return null;
  if (found.data) return found.data as UserFoodRow;

  const id = await uuidV5(LEGACY_FOOD_NAMESPACE, `legacy-food:${userId}:${food.id}`);
  const inserted = await withAccount(h, (owner) => supabase.from("user_foods")
    .upsert({
      id, user_id: owner, name: food.name, kind: "custom",
      per_100g: per100gFor(food), allergen_tags: [],
    }, { onConflict: "id" })
    .select("id, catalog_food_id, rev")
    .maybeSingle());
  if (inserted.error || !inserted.data) return null;
  return inserted.data as UserFoodRow;
}

type ResolvedRefs = {
  userRefId: string;
  catalogRefId?: string;
  /**
   * Every ref this food SHOULD have was minted. A mapped food whose catalog ref was refused is
   * incomplete: no membership op is queued and nothing is cached, so the next attempt retries the
   * missing ref instead of falsely reporting a complete save.
   */
  complete: boolean;
};

async function resolveRefs(
  h: AccountHandle, supabase: SupabaseClient, food: Food,
): Promise<ResolvedRefs | null> {
  const row = await userFoodRowFor(h, supabase, food);
  if (!row) return null;

  const userRefId = await foodRefFor(h, supabase, "user", null, row.id);
  if (!userRefId) return null;
  if (row.catalog_food_id == null) return { userRefId, complete: true };

  const catalogRefId = await foodRefFor(h, supabase, "catalog", row.catalog_food_id, null);
  return catalogRefId
    ? { userRefId, catalogRefId, complete: true }
    : { userRefId, complete: false };
}

/**
 * The refs a Foods row is known by — its own user ref (the key `favorites_foods` stars) and, for a
 * catalog-mapped food, the catalog ref. Cached refs cost nothing; otherwise they are resolved
 * (minting the user ref once) the same way a membership mark resolves them. Null when they cannot
 * be resolved right now (offline, or a refused mint).
 */
export async function foodRefsFor(food: Food, h: AccountHandle = accountHandle(),
  supabase?: SupabaseClient): Promise<{ userRefId: string; catalogRefId?: string } | null> {
  const cached = readPrefRefCache(h.userId)[food.id];
  if (cached?.userRefId) {
    return { userRefId: cached.userRefId, ...(cached.catalogRefId ? { catalogRefId: cached.catalogRefId } : {}) };
  }
  const refs = await resolveRefs(h, supabase ?? browserClient(), food);
  assertCurrent(h);
  return refs ? { userRefId: refs.userRefId, ...(refs.catalogRefId ? { catalogRefId: refs.catalogRefId } : {}) }
    : null;
}

/** Shared catalog nutrition and historical log items are never editable here. */
export function canEditFoodNutrients(food: Food): boolean {
  const h = currentAccountOrNull();
  const refs = h ? readPrefRefCache(h.userId)[food.id] : undefined;
  return food.catalogFoodId === undefined && !refs?.catalogRefId && (
    accountUnitGrams(food)) !== null;
}

/** The server's mapped row wins when a local food has no catalogFoodId marker yet. */
export async function verifyFoodNutrientsEditable(food: Food,
  supabase: SupabaseClient = browserClient()): Promise<boolean> {
  if (!canEditFoodNutrients(food)) return false;
  const h = accountHandle();
  const found = await withAccount(h, (owner) => supabase.from("user_foods")
    .select("id,catalog_food_id")
    .eq("user_id", owner).eq("name", food.name)
    .in("kind", OWN_FOOD_KINDS).is("deleted_at", null)
    .order("catalog_food_id", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true }).limit(1).maybeSingle());
  return !found.error && (found.data?.catalog_food_id ?? null) === null;
}

export type FoodEditFields = { note: boolean; role: boolean; nutrition: boolean };
export type FoodEditResult = { saved: FoodEditFields; syncing: boolean;
  membership: FoodMembershipAcknowledgement | null };

export class FoodPartialSaveError extends Error {
  constructor(readonly saved: FoodEditFields, readonly syncing: boolean) {
    super("Some changes saved. Save again to retry the rest.");
    this.name = "FoodPartialSaveError";
  }
}

function foodNoteError(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code : null;
  return new Error(code === "40001"
    ? "This note changed on another device. Reload and try again."
    : "Could not save this note. Check your connection and try again.");
}

/** Coach note actions may target a catalog-only preference, which has no user_foods row. */
export async function saveFoodNoteForRef(
  foodRefId: string, note: string | null, h: AccountHandle = accountHandle(),
  supabase: SupabaseClient = browserClient(),
  expectedNote?: string | null,
): Promise<void> {
  if (note && note.trim().length > 2000) throw new Error("Keep food notes under 2,000 characters.");
  const prefRead = await withAccount(h, (owner) => supabase.from("user_food_prefs")
    .select("rev,note").eq("user_id", owner).eq("food_ref_id", foodRefId).maybeSingle());
  if (prefRead.error || !prefRead.data || !Number.isSafeInteger(prefRead.data.rev)) {
    throw new Error("Could not load this food note. Try again.");
  }
  if (expectedNote !== undefined && (prefRead.data.note?.trim() || null) !== (expectedNote?.trim() || null)) {
    throw foodNoteError({ code: "40001" });
  }
  const pref = prefRead.data;
  const response = await withAccount(h, (owner) => supabase.rpc("save_food_note", {
    p_user: owner, p_food_id: null, p_food_ref_id: foodRefId,
    p_base_rev: pref.rev, p_expected_note: pref.note ?? null,
    p_note: note?.trim() || null,
  }));
  if (response.error) throw foodNoteError(response.error);
  const result = response.data as { food_rows?: unknown; pref_rows?: unknown } | null;
  if (!result || !Number.isSafeInteger(result.pref_rows)) throw foodNoteError(null);
}

/** apply_sync_op is the only row writer here that also emits a pullable change_log entry. */
async function applyFoodRow(h: AccountHandle, supabase: SupabaseClient,
  entity: "user_foods" | "user_food_prefs", id: string, baseRev: number,
  payload: Record<string, unknown>, onApplied: () => void): Promise<number> {
  const at = new Date().toISOString();
  const applied = await withAccount(h, (owner) => supabase.rpc("apply_sync_op", {
    p_user_id: owner, p_op: { op_id: crypto.randomUUID(), entity, entity_id: id,
      kind: "update", base_rev: baseRev, payload, client_ts: at },
  }));
  const result = applied.data as OpResult | null;
  if (applied.error || result?.status !== "applied" || typeof result.rev !== "number") {
    throw new Error("This food changed elsewhere. Reload and try again.");
  }
  onApplied();
  await putRow(h, entity, id, { ...payload, rev: result.rev, updated_at: at });
  return result.rev;
}

/** A note edit updates the name-wide note without replaying a membership status. */
export async function saveFoodEdits(food: Food, note: string, role: Food["role"],
  perUnit: Food["perUnit"] = food.perUnit,
  options: { supabase?: SupabaseClient; ensureMembership?: boolean } = {}): Promise<FoodEditResult> {
  const h = accountHandle();
  const supabase = options.supabase ?? browserClient();
  const saved: FoodEditFields = { note: false, role: false, nutrition: false };
  let syncing = false;
  let membership: FoodMembershipAcknowledgement | null = null;
  let membershipStarted = false;
  const nutrientsChanged = (Object.keys(food.perUnit) as (keyof Food["perUnit"])[])
    .some((key) => food.perUnit[key] !== perUnit[key]);
  if (nutrientsChanged && (!canEditFoodNutrients(food)
    || Object.values(perUnit).some((value) => !Number.isFinite(value) || value < 0))) {
    throw new Error("Check the nutrition values and try again.");
  }
  try {
    const noteChanged = (food.note?.trim() || null) !== (note.trim() || null);
    // Resolve before any edit so a refused ref cannot leave half of a multi-field save behind.
    const refs = await resolveRefs(h, supabase, food);
    assertCurrent(h);
    if (!refs?.complete) throw new FoodMembershipSaveError();
    // A new food needs a durable membership operation. NULL means preserve the existing note;
    // carrying a stale local note here would overwrite a more recent edit from another device.
    if (options.ensureMembership) {
      membership = await setFoodMembership(food.name,
        food.status === "neutral" ? null : food.status, {
          food, note: null, acknowledge: true, supabase, account: h,
        });
      membershipStarted = true;
      syncing = membership === null;
    }
    if (noteChanged) {
      if (note.trim().length > 2000) throw new Error("Keep food notes under 2,000 characters.");
      const row = await userFoodRowFor(h, supabase, food);
      if (!row) throw new Error("Could not load this food note. Try again.");
      const response = await withAccount(h, (owner) => supabase.rpc("save_food_note", {
        p_user: owner, p_food_id: row.id, p_food_ref_id: null,
        p_base_rev: row.rev, p_expected_note: food.note?.trim() || null,
        p_note: note.trim() || null,
      }));
      const result = response.data as { food_rows?: unknown; pref_rows?: unknown } | null;
      if (response.error) throw foodNoteError(response.error);
      if (!result || !Number.isSafeInteger(result.food_rows)
        || Number(result.food_rows) < 0 || !Number.isSafeInteger(result.pref_rows)
        || Number(result.pref_rows) < 0) {
        throw new Error("Could not save this note. Check your connection and try again.");
      }
      saved.note = true;
    }
    const prefRead = await withAccount(h, (owner) => supabase.from("user_food_prefs")
      .select("food_ref_id,status,role,no_cook,note,rev")
      .eq("user_id", owner).eq("food_ref_id", refs.userRefId).maybeSingle());
    if (prefRead.error) throw new FoodMembershipSaveError();
    const pref = prefRead.data as { food_ref_id: string; status: "eats" | "avoid";
      role: Food["role"] | null; no_cook: boolean | null; note: string | null; rev: number } | null;
    if ((options.ensureMembership || role !== food.role) && food.status !== "neutral") {
      if (!pref) throw new Error("Membership is syncing. Retry the group change after it appears.");
      const payload = { food_ref_id: refs.userRefId, status: pref.status, role,
        no_cook: pref.no_cook ?? false, note: pref.note ?? null };
      await applyFoodRow(h, supabase, "user_food_prefs", refs.userRefId, pref.rev, payload,
        () => { saved.role = true; });
    }
    if (nutrientsChanged) {
      const row = await userFoodRowFor(h, supabase, food);
      if (!row || row.catalog_food_id !== null) throw new Error("This food's nutrition cannot be edited here.");
      const full = await withAccount(h, (owner) => supabase.from("user_foods")
        .select("id,name,brand,ingredients_text,catalog_food_id,kind,per_100g,allergen_tags,rev")
        .eq("id", row.id).eq("user_id", owner).single());
      if (full.error || !full.data) throw new Error("Could not load this food for editing.");
      const per100g = per100gFor(withPerUnit(food, perUnit));
      if (Object.keys(per100g).length === 0) throw new Error("This serving has no known gram weight.");
      const payload = { ...full.data, per_100g: per100g } as Record<string, unknown>;
      delete payload.rev;
      await applyFoodRow(h, supabase, "user_foods", row.id, Number(full.data.rev), payload,
        () => { saved.nutrition = true; });
    }
    return { saved, syncing, membership };
  } catch (cause) {
    if (membershipStarted || saved.note || saved.role || saved.nutrition)
      throw new FoodPartialSaveError(saved, syncing);
    throw cause;
  }
}

/**
 * Resolve the refs one name-wide transaction needs, then queue exactly one `food_membership` op.
 * Idempotent: the same status and note twice is a no-op once this food's refs are cached.
 */
export async function syncFoodPref(food: Food, opts: SyncFoodPrefOptions = {}): Promise<void> {
  const note = food.note ?? null;
  try {
    await setFoodMembership(food.name, food.status === "neutral" ? null : food.status, {
      ...opts, food, note,
    });
  } catch {
    // Backfill is retry-only. Direct Foods-tab callers use setFoodMembership and surface the error.
  }
}

/**
 * One pass over their whole list for a device that has never emitted a pref — the Foods tab on mount
 * and SyncBootstrap after the first successful sync both call it. Serialised on purpose: 53 foods
 * would otherwise be 100+ concurrent RPCs on a phone that just woke up.
 *
 * `synced` counts foods this run got onto the op-log; `skipped` is what is still waiting, whether
 * because the per-run cap stopped at 20 or because a food could not be resolved.
 */
export type BackfillResult = { synced: number; skipped: number };

/**
 * One run at a time PER ACCOUNT. The Foods tab mounts and SyncBootstrap finishes a sync at roughly
 * the same moment, and React strict mode double-invokes the effect — several callers for the same
 * 20 foods, each resolving the same refs and queueing its own create op.
 *
 * Keyed by user id, not process-wide: a run for one account must not make a caller for another
 * account wait, because their pending lists, their ref ids and their caches have nothing to do
 * with each other.
 */
const inFlight = new Map<string, Promise<BackfillResult>>();

/**
 * Foods this session could not resolve, as `${userId}:${foodId}`. They stay in the pending list —
 * a failure is usually the network, and the next sync is a new chance — but they sort to the BACK
 * of it, so twenty permanently broken foods at the head of the list cannot keep the per-run cap
 * pointed at themselves for ever while the rest of their list is never reached.
 */
const failedIds = new Set<string>();

/** The account the failed set is currently keeping notes for. */
let stateOwner: string | null = null;

const failedKey = (userId: string, foodId: string): string => `${userId}:${foodId}`;

/** Test-only, like lib/store.ts's __resetStoreCache. */
export function __resetBackfillState(): void {
  inFlight.clear();
  failedIds.clear();
  stateOwner = null;
}

/** Phase 9 §0.3: every account-bearing global of this module, cleared on unbind. */
export function resetPrefsState(): void {
  __resetFoodMembershipState();
  __resetBackfillState();
  __resetEatsFacetWarmTimers();
}

/** Test-only: what the session is still holding against a retry. */
export function __backfillFailures(): string[] {
  return [...failedIds].sort();
}

/**
 * A different account has arrived. Forget the outgoing account's failures — they are a guess about
 * a session that is over — and forget nothing else.
 *
 * In particular the in-flight map is NOT cleared. It is keyed by user id, so it already isolates
 * accounts, and every run removes its own entry in its own `finally`. Clearing it here orphaned a
 * run that was still executing: it could no longer unregister, and the next caller for that
 * account saw no run to wait for and started a second one over the same foods — the duplicate
 * create the map exists to stop.
 */
function claimState(userId: string): void {
  if (stateOwner === userId) return;
  const outgoing = stateOwner;
  stateOwner = userId;
  if (outgoing === null) return;
  const prefix = `${outgoing}:`;
  for (const stale of [...failedIds]) if (stale.startsWith(prefix)) failedIds.delete(stale);
}

function pendingFor(userId: string, ordered: Food[]): Food[] {
  const cache = readPrefRefCache(userId);
  return ordered.filter((f) => !cache[f.id]);
}

export async function backfillFoodPrefs(
  h: AccountHandle, foods: Record<string, Food>, opts: SyncFoodPrefOptions = {},
): Promise<BackfillResult> {
  const supabase = opts.supabase ?? browserClient({ fetch: opts.fetchImpl });
  // The account comes from the handle the sync pass started with (audit plan r3 finding 3), never
  // from a claims read: after an await that read can answer for another account.
  const userId = h.userId;
  const ordered = Object.keys(foods).sort().map((id) => foods[id]);
  if (!isCurrent(h)) return { synced: 0, skipped: ordered.length };
  claimState(userId);

  let waited = inFlight.get(userId);
  while (waited) {
    const prior = await waited.catch(() => null);
    // The user may have signed out, or signed in as someone else, while we were queued. Our pending
    // list and our ref ids belong to the account we started as; writing them now would file one
    // account's marks under another's session.
    if (!isCurrent(h)) return { synced: 0, skipped: ordered.length };
    // Read OUR map, not the finished run's answer: the run may have emptied its own backlog while
    // this caller was handed a food that run never saw.
    const mine = pendingFor(userId, ordered);
    if (mine.length === 0) return prior ?? { synced: 0, skipped: 0 };
    // A backlog made only of foods the run just failed on is not worth spending another 20
    // lookups on per waiter — SyncBootstrap triggers on every sync, so the next one is the retry.
    const worthRetrying = (prior?.synced ?? 0) > 0
      || mine.some((f) => !failedIds.has(failedKey(userId, f.id)));
    if (!worthRetrying) return prior ?? { synced: 0, skipped: mine.length };
    waited = inFlight.get(userId);
  }

  const run = runBackfill(h, supabase, foods, ordered, opts);
  inFlight.set(userId, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(userId) === run) inFlight.delete(userId);
  }
}

async function runBackfill(
  h: AccountHandle, supabase: SupabaseClient, foods: Record<string, Food>, ordered: Food[],
  opts: SyncFoodPrefOptions,
): Promise<BackfillResult> {
  const userId = h.userId;
  // A food the user has deleted is not a pending retry, and the set would otherwise only ever grow.
  const prefix = `${userId}:`;
  for (const stale of [...failedIds]) {
    if (stale.startsWith(prefix) && !(stale.slice(prefix.length) in foods)) failedIds.delete(stale);
  }

  const pending = pendingFor(userId, ordered);
  const queue = [
    ...pending.filter((f) => !failedIds.has(failedKey(userId, f.id))),
    ...pending.filter((f) => failedIds.has(failedKey(userId, f.id))),
  ];

  let synced = 0;
  for (const food of queue.slice(0, BACKFILL_PER_RUN)) {
    // A switch ends the run: nothing more is resolved, queued or cached for this account.
    if (!isCurrent(h)) break;
    await syncFoodPref(food, { ...opts, supabase, account: h });
    if (readPrefRefCache(userId)[food.id]) {
      synced += 1;
      failedIds.delete(failedKey(userId, food.id));
    } else {
      failedIds.add(failedKey(userId, food.id));
    }
  }
  return { synced, skipped: pending.length - synced };
}
