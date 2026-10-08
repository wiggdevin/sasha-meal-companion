/**
 * The two network halves of sync. Pull reads the change feed and writes each row straight into
 * IndexedDB; push drains the outbox. Both take an injectable `fetch`, so the tests never touch the
 * network, and neither holds module-level state beyond the in-flight guard.
 *
 * Phase 9 §0.2: every entry point takes the `AccountHandle` of the account the pass is for. A pass
 * that meets `AccountChanged` stops without saving a cursor, a sync time or an error.
 */
import {
  AccountChanged, assertCurrent, isCurrent, accountFetch, accountJson, type AccountHandle,
} from "@/lib/device/account";
import {
  allOps, allRows, deleteRow, getCursor, getLastError, getLastSyncAt, getRow, putOp, putRow, setCursor,
  setLastError, setLastSyncAt, type OutboxOp,
} from "./idb";
import { foodsFromSyncRows, loadStore, saveStoreFor } from "../store";
import { normalizeFoodName } from "@/lib/foods/normalize";
import { loadAccountFoodSnapshot } from "./food-refs";
import { applyPulledPlanDay } from "./plan-days";
import { decodeKey } from "./keys";
import { drainOutbox, type DrainResult } from "./outbox";
import {
  applyPulledUserSettings, clearPulledUserSettings, establishEmptySettingsBaseline,
  pendingSettingsOps, settingsAwaitingBaseline, USER_SETTINGS_KEY,
} from "./settings";
import { ENTITIES, type ChangesResponse, type Entity, type OpsResponse } from "./types";
import type { OwnedOp } from "./idb";
import { settingsProfileFromRow, type UserSettingsProfileRow } from "./user-settings";
import type { TargetProfile } from "../api-types";
import {
  settingsFromTargetMirror, settingsWithoutTargetRevision, settingsWithTargetRevision,
  targetDayFor, targetRevisionFromProfile,
} from "../targets/revision";
import type { TargetRevision } from "../types";

export const SYNCED_EVENT = "meal-companion:synced";

/** A route answered, but not with 2xx. The status matters: a 4xx will fail the same way forever,
 *  so the outbox parks the op instead of retrying it; a 5xx/429 is worth backing off. */
export class SyncHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "SyncHttpError";
  }
}

const PAGE_LIMIT = 500;
const DEFAULT_MAX_PAGES = 50;
const SYNCED = new Set<string>(ENTITIES);

export type SyncOptions = { fetchFn?: typeof fetch; maxPages?: number };
export type PullResult = {
  applied: number; skipped: number; cursor: number; hasMore: boolean; pages: number;
};

/** A row this client cannot address (an unknown key shape) is quarantined, not fatal: one poisoned
 *  row must never stop every device from syncing. Returns false when the row was skipped. */
function addressable(entity: Entity, key: string, seq: number): boolean {
  try {
    decodeKey(entity, key);
    return true;
  } catch {
    console.warn(`sync: skipping change ${seq} (${entity} ${key}) — this client cannot address it`);
    return false;
  }
}

async function getJson<T>(h: AccountHandle, url: string, fetchFn: typeof fetch): Promise<T> {
  const res = await accountFetch(h, url, { method: "GET", headers: { accept: "application/json" } },
    { fetchImpl: fetchFn });
  if (!res.ok) throw new SyncHttpError(res.status, `sync: GET ${url} failed with ${res.status}`);
  return accountJson<T>(h, res);
}

/**
 * A log entry deleted elsewhere — another device's Today, or a server Undo of a coach meal
 * (review t4r9 #3) — leaves this phone's mirror AND its day: the day's `extras` are what Today and
 * the rings read (`lib/resolve.ts`), and nothing else removes one. The date comes from the row
 * (pulled, or the mirror's before it goes); without one every day is searched.
 */
async function dropDeletedEntry(
  h: AccountHandle, entryId: string, current: Record<string, unknown> | null,
): Promise<void> {
  const mirror = (await getRow(h, "log_entries", entryId)) as { local_date?: unknown } | undefined;
  if (current === null) await deleteRow(h, "log_entries", entryId);
  else await putRow(h, "log_entries", entryId, current);
  const hint = typeof current?.local_date === "string" ? current.local_date
    : typeof mirror?.local_date === "string" ? mirror.local_date : null;
  const store = loadStore();
  // The hinted day first; every day when it does not hold the entry (moved locally since).
  const hinted = hint ? store.days[hint]?.extras?.some((extra) => extra.id === entryId) : false;
  const dates = hinted && hint ? [hint] : Object.keys(store.days);
  let days = store.days;
  for (const date of dates) {
    const day = days[date];
    if (!day?.extras?.some((extra) => extra.id === entryId)) continue;
    days = { ...days, [date]: { ...day, extras: day.extras.filter((extra) => extra.id !== entryId) } };
  }
  if (days !== store.days) saveStoreFor(h, { ...store, days }, { silent: true });
}

async function applyAndMirrorPulledUserSettings(
  h: AccountHandle,
  row: Record<string, unknown>,
  rev: number,
): Promise<void> {
  await applyPulledUserSettings(h, row, rev);
  const mirror = await getRow(h, "user_settings", USER_SETTINGS_KEY);
  if (!mirror) return;
  const store = loadStore();
  saveStoreFor(h, {
    ...store,
    settings: {
      ...store.settings,
      ...settingsProfileFromRow(mirror as UserSettingsProfileRow),
    },
  }, { silent: true });
}

/**
 * A `user_settings` row a server route answered with (Phase 18 W5b-2: the taste-chip confirm and
 * Undo RPCs, which write the row on the server and report it as the change feed will): settled
 * exactly as a pulled row, so it becomes the baseline, every pending local edit is rebased onto it,
 * and an older or equal rev never rolls the baseline back. A row with no numeric rev is ignored.
 */
export async function applyServerUserSettings(
  h: AccountHandle, row: Record<string, unknown>,
): Promise<boolean> {
  if (typeof row.rev !== "number" || !Number.isInteger(row.rev)) return false;
  await applyAndMirrorPulledUserSettings(h, row, row.rev);
  return true;
}

/** Every target row this account's mirror holds: the ids of all of them, and the ones that parse
 *  (a malformed row is held but never parsed into a revision). */
async function mirroredTargetRevisions(
  h: AccountHandle,
): Promise<{ heldIds: string[]; revisions: TargetRevision[] }> {
  const rows = await allRows(h, "target_profiles");
  const heldIds = rows.map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  const revisions = rows.map((row) => targetRevisionFromProfile(row as TargetProfile))
    .filter((revision): revision is TargetRevision => revision !== null);
  return { heldIds, revisions };
}

async function applyAndMirrorTargetProfile(
  h: AccountHandle,
  key: string,
  row: Record<string, unknown>,
): Promise<void> {
  await putRow(h, "target_profiles", key, row);
  const revision = targetRevisionFromProfile(row as TargetProfile);
  if (!revision) return;
  const store = loadStore();
  // Every row joins the dated history; current becomes the revision in force today by the
  // server's order (effective date, then rev), never simply the highest rev.
  const settings = settingsWithTargetRevision(store.settings, revision);
  if (settings === store.settings) return;
  saveStoreFor(h, { ...store, settings }, { silent: true });
}

/** A pulled delete of a target row: the mirror drops it and so does the phone cache, so a later
 *  pass never mistakes it for a saved revision that has not been pulled yet. */
async function deleteMirroredTargetProfile(h: AccountHandle, key: string): Promise<void> {
  await deleteRow(h, "target_profiles", key);
  const store = loadStore();
  const settings = settingsWithoutTargetRevision(store.settings, key);
  if (settings === store.settings) return;
  saveStoreFor(h, { ...store, settings }, { silent: true });
}

/** Each pass rebuilds history and current from the mirror (audit 2026-10-05 #16, #23): backfill,
 *  a future revision turning current on its date, a stale coerced cache re-parsed, and an account
 *  whose rows are all malformed returned to needs_profile. */
async function refreshTargetHistory(h: AccountHandle): Promise<void> {
  const { heldIds, revisions } = await mirroredTargetRevisions(h);
  const store = loadStore();
  const cached = store.settings.activeTargetProfile;
  // An unsaved onboarding candidate (no revision number) is the user's preview; leave it.
  if (cached && typeof cached.revision !== "number") return;
  const settings = settingsFromTargetMirror(store.settings, revisions, undefined, heldIds);
  if (settings === store.settings) return;
  saveStoreFor(h, { ...store, settings }, { silent: true });
}

async function refreshFoodProjection(h: AccountHandle): Promise<void> {
  const snapshot = await loadAccountFoodSnapshot(h);
  const pending = await allOps(h);
  const store = loadStore();
  const foods = foodsFromSyncRows(snapshot.foods, snapshot.prefs, snapshot.refs);
  const membership = new Map<string, { status: "eats" | "avoid" | null;
    note: string | null; rev: number }>();
  for (const op of pending) {
    if (op.entity !== "food_membership" || typeof op.payload.name_norm !== "string") continue;
    const status = op.payload.status;
    if (status !== "eats" && status !== "avoid" && status !== null) continue;
    const rev = typeof op.payload.rev === "number" ? op.payload.rev : -1;
    const name = op.payload.name_norm;
    if (rev > (membership.get(name)?.rev ?? -1)) membership.set(name, {
      status, note: typeof op.payload.note === "string" ? op.payload.note : null, rev,
    });
  }
  for (const [id, food] of Object.entries(foods)) {
    const pendingStatus = membership.get(normalizeFoodName(food.name));
    if (pendingStatus) foods[id] = { ...food, status: pendingStatus.status ?? "neutral",
      note: pendingStatus.note ?? food.note };
  }
  for (const [id, food] of Object.entries(store.foods)) {
    const name = normalizeFoodName(food.name);
    if (!membership.has(name) || Object.values(foods).some((item) =>
      normalizeFoodName(item.name) === name)) continue;
    foods[id] = food;
  }
  const foodIdByRef = new Map(snapshot.refs.map((ref) => [ref.id, ref.user_food_id]));
  for (const op of pending) {
    const id = op.entity === "user_foods" ? op.entity_id
      : op.entity === "user_food_prefs" ? foodIdByRef.get(op.entity_id) : undefined;
    if (id && op.kind !== "delete" && store.foods[id]) foods[id] = store.foods[id];
  }
  saveStoreFor(h, { ...store, foods }, { silent: true });
}

/** Apply pages of `ChangeRow` until the feed runs out. The cursor is saved ONLY after a whole page
 *  is applied, so a crash mid-page replays that page rather than skipping it. */
export async function pullChanges(
  h: AccountHandle, since?: number, options: SyncOptions = {},
): Promise<PullResult> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let cursor = since ?? (await getCursor(h));
  let applied = 0;
  let skipped = 0;
  let pages = 0;
  let hasMore = true;

  // A settings op with no confirmed baseline was held back by the drain: the change feed may never
  // mention a row the cursor has already passed, so the recovery re-reads it from the start and
  // diffs the payload against the row the server actually holds (T11b eighth-round P1). The feed
  // is also the only way to find out that the server holds NO row — which the baseline-less payload
  // then creates (ninth-round P1, finding 2).
  const recoveringSettings = await settingsAwaitingBaseline(h, await allOps(h));
  if (recoveringSettings) cursor = 0;
  let recoveredSettings: { row: Record<string, unknown>; rev: number } | null = null;

  while (hasMore && pages < maxPages) {
    const page = await getJson<ChangesResponse>(
      h, `/api/sync/changes?since=${cursor}&limit=${PAGE_LIMIT}`, fetchFn,
    );
    for (const change of page.changes) {
      if (!SYNCED.has(change.entity as Entity)) continue;
      if (!addressable(change.entity, change.entity_key, change.seq)) {
        skipped += 1;
        continue;
      }
      if (change.entity === "user_settings" && recoveringSettings) {
        // A legacy payload stays parked until the COMPLETE replay says which settings row is
        // authoritative. Applying an early page would make the op sendable while later pages are
        // still outstanding (or when maxPages stops this pull before the end).
        recoveredSettings = change.current === null
          ? null : { row: change.current, rev: change.rev };
      }
      else if (change.entity === "plan_days") {
        if (!await applyPulledPlanDay(h, change)) {
          skipped += 1;
          continue;
        }
      }
      else if (change.entity === "log_entries"
        && (change.current === null || (change.current as { deleted_at?: unknown }).deleted_at)) {
        await dropDeletedEntry(h, change.entity_key, change.current);
      }
      else if (change.current === null) {
        if (change.entity === "user_settings") await clearPulledUserSettings(h);
        else if (change.entity === "target_profiles") {
          await deleteMirroredTargetProfile(h, change.entity_key);
        }
        else await deleteRow(h, change.entity, change.entity_key);
      }
      // `user_settings` is the one row a whole-row writer ALSO rewrites locally (profile save,
      // water goal), so the server's row becomes the BASELINE this client rebuilds the mirror
      // from — see lib/sync/settings.ts. Writing it straight over the mirror is the revert.
      else if (change.entity === "user_settings") {
        await applyAndMirrorPulledUserSettings(h, change.current, change.rev);
      }
      else if (change.entity === "target_profiles") {
        await applyAndMirrorTargetProfile(h, change.entity_key, change.current);
      }
      else await putRow(h, change.entity, change.entity_key, change.current);
      applied += 1;
    }
    cursor = page.next_cursor;
    await setCursor(h, cursor);
    pages += 1;
    hasMore = page.has_more;
  }

  // Only the end of the replay establishes what the server holds. Until then the legacy op remains
  // baseline-less and the drain keeps it parked.
  if (recoveringSettings && !hasMore) {
    if (recoveredSettings === null) await establishEmptySettingsBaseline(h);
    else await applyAndMirrorPulledUserSettings(h, recoveredSettings.row, recoveredSettings.rev);
  }

  // Direct Foods membership writes bypass the change feed. The account's canonical rows
  // must refresh on every sync pass, including one with an already-consumed cursor.
  await refreshFoodProjection(h);
  await refreshTargetHistory(h);

  return { applied, skipped, cursor, hasMore, pages };
}

export function lastSyncAt(h: AccountHandle): Promise<string | null> {
  return getLastSyncAt(h);
}

export function lastError(h: AccountHandle): Promise<string | null> {
  return getLastError(h);
}

/** One line the user can read on the settings card — never a stack trace, never the body. */
function shortMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : "something went wrong";
  return raw.replace(/^sync: /, "").slice(0, 90);
}

/** This device's IANA zone, or undefined when the platform will not name one. */
function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export async function pushOutbox(h: AccountHandle, options: SyncOptions = {}): Promise<DrainResult> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  return drainOutbox(h, async (ops: OwnedOp[]) => {
    const res = await accountFetch(h, "/api/sync/ops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // t24b: the phone's own day and zone, so the server's target recompute never dates a
      // revision after the day this phone is on (travel keeps the device day).
      body: JSON.stringify({ ops, local_date: targetDayFor(), time_zone: deviceTimeZone() }),
    }, { fetchImpl: fetchFn });
    if (!res.ok) {
      throw new SyncHttpError(res.status, `sync: POST /api/sync/ops failed with ${res.status}`);
    }
    return accountJson<OpsResponse>(h, res);
  });
}

/**
 * One full pass, answerable: has this account's `user_settings` write actually reached the server?
 *
 * Onboarding asks before it lets an account leave the setup flow. The gate opens on the SERVER's
 * `onboarded_at` (components/AuthGate.tsx), and the write that stamps it only lands in the outbox
 * first — so navigating away on the strength of a queued op is what sent a finished account back to
 * step 1 on its next page load (lanes/W2).
 *
 * The PULL is not optional here, and it is why this is not `pushOutbox` alone: an account with no
 * row at all (R1) has no baseline to aim a whole-row write at, so the drain parks the op instead of
 * sending it, and only the feed — which proves the server holds no row — installs the empty baseline
 * its `create` needs (lib/sync/settings.ts:290). Pull-then-push is the order `syncOnce` already
 * uses, so this reuses the one real push path rather than inventing a second one.
 *
 * Never throws: a pass that failed leaves the op queued, which IS the answer. Neither does an outbox
 * this device cannot read at all (a disabled IndexedDB) — the caller asked a yes/no question about an
 * account's server row, and "we could not find out" is a no, not a rejected promise the onboarding
 * flow's own `catch` would have to render as a generic save failure.
 */
export async function flushOutboxNow(h: AccountHandle, options: SyncOptions = {}): Promise<boolean> {
  try {
    const queued = async (): Promise<boolean> =>
      pendingSettingsOps(await allOps(h)).length > 0;
    // Nothing queued: the server has the row already (a settled op leaves the queue) — or the write
    // this caller is asking about was never made. Either way there is nothing to push.
    if (!await queued()) return true;
    await syncOnce(h, options);
    // A pass that was already running when this write was queued pushed the outbox IT had read, so
    // one more — which now starts fresh — is what sends this one.
    if (await queued()) await syncOnce(h, options);
    return !await queued();
  } catch {
    // Offline, refused, or a malformed answer: the op is still queued and the caller must not leave.
    return false;
  }
}

/** What `flushOnboardingWritesNow` reports: delivered, or the ops still waiting by entity. */
export type OnboardingDelivery = {
  delivered: boolean;
  /** Ops of the gated entities still queued after the passes (waiting, backing off or parked). */
  pending: { userSettings: number; foodMembership: number };
};

/** Every op onboarding's save queues: the settings write (the `onboarded_at` stamp, profile) and
 *  each starter food's membership op. A food op leaves the queue only when the server answered it
 *  (`applied`, or `rejected` for a newer mark the phone then reconciles to). */
function pendingOnboardingOps(ops: readonly OutboxOp[]): OnboardingDelivery["pending"] {
  return {
    userSettings: pendingSettingsOps(ops).length,
    foodMembership: ops.filter((op) => op.entity === "food_membership").length,
  };
}

/**
 * GPT-6 Sol BLOCK (onb2-p0, "things didn't save"): `flushOutboxNow` answers for the settings op
 * only, so a food membership op that failed or was backing off still let onboarding open Today
 * without the chosen foods on the server. This is the onboarding save's delivery gate: true only
 * when NO settings whole-row op and NO food membership op remains queued after the passes.
 *
 * The caller asked now (the save, or its retry), so food ops that are backing off or parked after
 * an earlier failure are made due first — the same release "Sync now" gives (`retryParked`) — or a
 * retry tapped inside the backoff window would never send them. Settings ops keep their own
 * selection rules (a settings op with no baseline waits for the pull, lib/sync/settings.ts).
 *
 * Never throws: an outbox it cannot read, or a failed pass, answers not delivered.
 */
export async function flushOnboardingWritesNow(
  h: AccountHandle, options: SyncOptions & { now?: () => number } = {},
): Promise<OnboardingDelivery> {
  const now = options.now ?? Date.now;
  const unknown = { delivered: false, pending: { userSettings: -1, foodMembership: -1 } };
  const read = async () => pendingOnboardingOps(await allOps(h));
  const release = async () => {
    const at = now();
    for (const op of await allOps(h)) {
      if (op.entity !== "food_membership" || op.next_attempt_at <= at) continue;
      await putOp(h, { ...op, next_attempt_at: at });
    }
  };
  const settled = (pending: OnboardingDelivery["pending"]) =>
    pending.userSettings === 0 && pending.foodMembership === 0;
  try {
    let pending = await read();
    if (settled(pending)) return { delivered: true, pending };
    for (let pass = 0; pass < 2 && !settled(pending); pass += 1) {
      // A pass already running when these ops were queued pushed the outbox IT had read, so a
      // second, fresh pass is what sends them (same reasoning as `flushOutboxNow`).
      await release();
      try {
        await syncOnce(h, options);
      } catch (e) {
        if (e instanceof AccountChanged || !isCurrent(h)) return unknown;
      }
      pending = await read();
    }
    return { delivered: settled(pending), pending };
  } catch {
    return unknown;
  }
}

type SyncPass = {
  promise: Promise<{ pull: PullResult; push: DrainResult }>;
  /**
   * A wake that arrived while a pass was running. The pass it joined had already read the outbox,
   * so whatever was queued after that is not in it — and starting a second drain beside the first
   * would push the same ops twice and race their settle. So it runs once more, after (Grok pass 18,
   * MEDIUM 3).
   */
  runAgain: boolean;
};

/** One pass per account epoch (Phase 9 §0.3): a pass for A never answers a call for B. */
const passes = new Map<number, SyncPass>();

/** Forget every in-flight pass. The passes themselves stop at their next handle check. */
export function resetSyncPasses(): void {
  passes.clear();
}

/** Records the error line, unless the account changed: that is not a failure of this account. */
async function recordFailure(h: AccountHandle, e: unknown): Promise<void> {
  if (e instanceof AccountChanged || !isCurrent(h)) return;
  await setLastError(h, shortMessage(e));
}

async function runPass(
  h: AccountHandle, options: SyncOptions,
): Promise<{ pull: PullResult; push: DrainResult }> {
  let pull: PullResult;
  try {
    pull = await pullChanges(h, undefined, options);
  } catch (e) {
    await recordFailure(h, e);
    throw e;
  }
  let push: DrainResult;
  try {
    push = await pushOutbox(h, options);
  } catch (e) {
    await recordFailure(h, e);
    throw e;
  }
  if (push.failed) await setLastError(h, "some changes could not be sent");
  else {
    await setLastSyncAt(h, new Date().toISOString());
    await setLastError(h, null);
  }
  return { pull, push };
}

/** Pull before push, so a conflict merges against the freshest row we can see. Calls coalesce. */
export async function syncOnce(
  h: AccountHandle, options: SyncOptions = {},
): Promise<{ pull: PullResult; push: DrainResult }> {
  assertCurrent(h);
  const running = passes.get(h.epoch);
  if (running) {
    running.runAgain = true;
    return running.promise;
  }
  const pass: SyncPass = { promise: Promise.resolve() as never, runAgain: false };
  pass.promise = (async () => {
    try {
      return await runPass(h, options);
    } finally {
      if (passes.get(h.epoch) === pass) passes.delete(h.epoch);
      // Either way the card is now stale — a failure is exactly what the user needs to see.
      globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
    }
  })();
  passes.set(h.epoch, pass);
  // Only after a pass that worked: a failed one leaves the write queued, and the outbox's own
  // backoff decides when it is tried again — running straight into the same failure is a loop.
  void pass.promise.then(
    () => {
      if (!pass.runAgain || !isCurrent(h)) return;
      pass.runAgain = false;
      void syncOnce(h, options).catch(() => undefined);
    },
    () => { pass.runAgain = false; },
  );
  return pass.promise;
}
