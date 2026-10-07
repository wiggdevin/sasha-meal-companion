/**
 * The client half of the morning weight — T8 §2.
 *
 * `lib/today/water-and-weight.ts` writes `weightLb` to the per-device store first, so the number is
 * the user's the instant the user taps Save, offline or not. This file is what makes it reach the server as a
 * `health_samples` row: one POST, and a small pending list for the times the POST cannot land.
 *
 * The list lives in the `meta` store of the same IndexedDB database the outbox uses, so a weight
 * typed in airplane mode survives a reload and goes up whenever signal comes back.
 * `components/SyncBootstrap.tsx` drains it after every successful sync — the shape T1's
 * `backfillFoodPrefs` established:
 *
 *   - **owned by an account.** IndexedDB is per device, not per sign-in, so every record carries
 *     the `userId` that parked it, the drain touches only its own, and the claims are re-read after
 *     the awaits. Without that, B's first sync posts A's weight under B's JWT.
 *   - **bounded batch.** `DRAIN_PER_RUN` days a run; the rest wait for the next sync.
 *   - **one drain at a time, per account.** Several syncs can land together (open, focus,
 *     `online`); a second caller joins the run already going rather than posting the same day twice.
 *   - **failed records retried next run.** A transport failure, a 5xx, or a request that runs past
 *     `POST_TIMEOUT_MS` keeps the record.
 *   - **serialized across tabs.** The list is one `meta` key and a phone can have the app open
 *     twice; `navigator.locks` is what keeps two heaps from overwriting each other's parked
 *     weigh-ins, with the in-heap chain as the fallback where it is missing.
 *   - **nothing re-posted once the server has answered.** A settled record leaves the list.
 *
 * Two rules the first round got wrong, both of which quietly reverted the user's own correction:
 *
 * 1. An ANSWER retires that day's parked record (`saveWeighIn` below). The RPC upserts on
 *    `manual:<local_date>`, so a stale 170 posted after an accepted 171 writes 170 back.
 * 2. The drain settles the RECORD it posted, never the day. A correction queued while the batch was
 *    in the air is a different record, and deleting it by date would lose it on both sides.
 *
 * A refusal (422, and only 422) is not retried — the server will never accept that number — and its own
 * message goes back to the caller for the FAB to show.
 */
import {
  accountHandle, assertCurrent, isCurrent, rethrowAccountChanged, accountFetch, accountJson, type AccountHandle,
} from "@/lib/device/account";
import { getDay, updateDay } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { getMeta, putMeta } from "@/lib/sync/idb";

/** The `meta` key the pending list lives under. */
export const PENDING_WEIGH_INS_KEY = "pending_weigh_ins";

/** One run's share of the backlog. A week offline is one week of days, not a stampede. */
export const DRAIN_PER_RUN = 20;

const ENDPOINT = "/api/health/weigh-in";

/**
 * How long one POST may take. A request that never answers is not a request that failed — nothing
 * rejects — so without a deadline the drain's promise never settles, and because every later caller
 * JOINS the run already going, one hung POST took the drain out for the life of the page. Ten
 * seconds is the budget the log commit already works to.
 */
export const POST_TIMEOUT_MS = 10_000;

/**
 * The route's body, stored exactly as it was typed — not a translation of it.
 *
 * The zone especially: it is part of what the user typed, because it is what turns a local date into
 * 07:00 of THAT morning. A record the drain had to rebuild could take the phone's zone at posting
 * time instead, and a weigh-in typed in Los Angeles and drained after the user lands in Denver would
 * stamp the wrong morning.
 */
export type WeighInRequest = { localDate: string; lb: number; tz: string };

/** One parked request and the account it belongs to. */
export type PendingWeighIn = { userId: string; request: WeighInRequest };

export type WeighInOptions = {
  fetchImpl?: typeof fetch;
  tz?: string;
  /** How long one POST may take before it counts as a failure. Defaults to `POST_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** The account a delayed caller started as. Default: the bound one. */
  account?: AccountHandle;
};

export type DrainResult = { posted: number; pending: number };

function zone(opts: WeighInOptions): string {
  return opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export async function readPendingWeighIns(h: AccountHandle): Promise<PendingWeighIn[]> {
  try {
    const stored = await getMeta(h, PENDING_WEIGH_INS_KEY);
    return Array.isArray(stored) ? stored as PendingWeighIn[] : [];
  } catch (e) {
    rethrowAccountChanged(e);
    // A blocked database loses nothing the per-device store does not already hold.
    return [];
  }
}

async function writePendingWeighIns(h: AccountHandle, list: PendingWeighIn[]): Promise<void> {
  try {
    await putMeta(h, PENDING_WEIGH_INS_KEY, list);
  } catch (e) {
    rethrowAccountChanged(e);
    // Same: the weight is already on this phone, and nothing here is worth failing a save over.
  }
}

/**
 * Every read-modify-write of the pending list, serialized.
 *
 * A save and a drain touch the same IndexedDB key, and both are read-then-write across an await.
 * Interleaved, one overwrites the other's change with a list it read before that change existed —
 * which is how a weigh-in parked while the drain was finishing vanished without ever being sent.
 * The chain is process-wide rather than per account because the KEY is: two accounts' records share
 * one list, so two unsynchronised writers would lose each other's rows just the same.
 *
 * Two layers, because a promise chain only reaches as far as one JS heap:
 *
 *   - `navigator.locks`, when the browser has it, holds ACROSS TABS. An installed PWA opened twice
 *     — or a tab left on Today beside one the user just opened — is two heaps writing one `meta` key,
 *     and the chain below cannot see the other one at all.
 *   - the chain itself, which serializes this heap and is the whole guarantee where the Web Locks
 *     API is missing (older WebKit, and Node, which is where the fallback is tested).
 */
const PENDING_LOCK_NAME = "mc-pending-weigh-ins";

let pendingLock: Promise<unknown> = Promise.resolve();

/** This heap's turn, whatever else is going on in it. */
function withLocalChain<T>(work: () => Promise<T>): Promise<T> {
  const next = pendingLock.then(work, work);
  // The chain must not reject, or every later write is skipped.
  pendingLock = next.catch(() => undefined);
  return next;
}

function withPendingLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks) return withLocalChain(work);
  // The chain still runs inside the cross-tab lock: this tab may have several writers of its own
  // waiting, and they must not all pile into one held lock at once.
  return locks.request(PENDING_LOCK_NAME, async () => withLocalChain(work)) as Promise<T>;
}

/** The pending list's lock, for the legacy adoption that merges into it (PR #248 review r6 #3). */
export const withWeighInLock = withPendingLock;

/** The one write path. Read and write inside the lock, so nothing can interleave between them. */
async function updatePending(
  h: AccountHandle, mutate: (list: PendingWeighIn[]) => PendingWeighIn[],
): Promise<void> {
  await withPendingLock(async () => {
    await writePendingWeighIns(h, mutate(await readPendingWeighIns(h)));
  });
}

/**
 * Whether this record is still on the list AND still the newest for its day. Read inside the lock,
 * for the same reason. A record with a newer one behind it is superseded (PR #248 review r2 #4):
 * posting it could write an older number over one the server already accepted.
 */
function stillNewest(h: AccountHandle, entry: PendingWeighIn): Promise<boolean> {
  return withPendingLock(async () => {
    const list = await readPendingWeighIns(h);
    const at = lastIndexOf(list, entry);
    return at >= 0 && !list.slice(at + 1).some((e) => sameDay(e, entry));
  });
}

function withoutDay(list: PendingWeighIn[], userId: string, localDate: string): PendingWeighIn[] {
  return list.filter((e) => !(e.userId === userId && e.request.localDate === localDate));
}

function sameDay(a: PendingWeighIn, b: PendingWeighIn): boolean {
  return a.userId === b.userId && a.request.localDate === b.request.localDate;
}

function lastIndexOf(list: PendingWeighIn[], entry: PendingWeighIn): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (sameRecord(list[i], entry)) return i;
  return -1;
}

/**
 * An accepted record answers for itself and every OLDER record of its day; a record written after it
 * is a newer intent and stays. With the record gone from the list, the whole day is retired, as
 * before: nothing older may be replayed over the accepted number.
 */
function retireThrough(list: PendingWeighIn[], entry: PendingWeighIn): PendingWeighIn[] {
  const at = lastIndexOf(list, entry);
  if (at < 0) return withoutDay(list, entry.userId, entry.request.localDate);
  return list.filter((e, i) => i > at || !sameDay(e, entry));
}

/** Only this record goes (a refusal answers for the number, not the day). */
function retireOnly(list: PendingWeighIn[], entry: PendingWeighIn): PendingWeighIn[] {
  const at = lastIndexOf(list, entry);
  return at < 0 ? list : list.filter((_e, i) => i !== at);
}

/** The newest record of each day, oldest day first: the only ones the drain may send. */
function newestPerDay(list: PendingWeighIn[]): PendingWeighIn[] {
  return list.filter((e, i) => !list.slice(i + 1).some((later) => sameDay(later, e)));
}

function sameRecord(a: PendingWeighIn, b: PendingWeighIn): boolean {
  return a.userId === b.userId
    && a.request.localDate === b.request.localDate
    && a.request.lb === b.request.lb
    && a.request.tz === b.request.tz;
}

type PostResult = { kind: "ok" } | { kind: "refused"; message: string } | { kind: "retry" };

/** The marker a timed-out request resolves with, so the race below can tell it from an answer. */
const TIMED_OUT = Symbol("weigh-in post timed out");

async function post(
  h: AccountHandle, request: WeighInRequest, opts: WeighInOptions,
): Promise<PostResult> {
  const send = opts.fetchImpl ?? fetch;
  assertCurrent(h);
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Abort the request AND stop waiting for it. The abort is what frees the connection; the race is
  // what makes the deadline this module's own guarantee rather than a favour from the transport,
  // and a transport that ignores its signal is exactly the case that pinned the drain for the life
  // of the page.
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      resolve(TIMED_OUT);
    }, opts.timeoutMs ?? POST_TIMEOUT_MS);
  });

  let res: Response | typeof TIMED_OUT;
  try {
    // The stored record, posted back unchanged.
    res = await Promise.race([
      accountFetch(h, ENDPOINT, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(request), signal: deadline.signal }, { fetchImpl: send }),
      expiry,
    ]);
  } catch (e) {
    rethrowAccountChanged(e);
    // Offline, or the request never left.
    return { kind: "retry" };
  } finally {
    clearTimeout(timer);
  }
  // Phase 9 §0.2: an answer that arrives after a switch is not this account's to act on.
  assertCurrent(h);
  // No answer inside the deadline: the record stays and the next sync tries again.
  if (res === TIMED_OUT) return { kind: "retry" };
  if (res.ok) return { kind: "ok" };
  // ONLY 422 is final — the route's own "this weight, this zone or this day will never be
  // accepted". Everything else is worth trying again: signed out, rate limited, 5xx, a route
  // answering before its migration landed, and 400 in particular, which can come from something
  // that never reached the route at all (a proxy, a captive portal, an HTML error page). Treating
  // one of those as a refusal deleted the only copy of a weigh-in over a network fault.
  if (res.status !== 422) return { kind: "retry" };
  const message = await accountJson(h, res).then(
    (body: unknown) => (body as { message?: string }).message,
  ).catch(() => undefined);
  return { kind: "refused", message: message ?? "Could not save that weight." };
}

/**
 * Send one typed weigh-in. Returns the line the FAB should show the user's, or null when there is nothing
 * to say — which includes being offline, because the weight is saved either way.
 */
export async function saveWeighIn(
  localDate: string, lb: number, opts: WeighInOptions = {},
): Promise<string | null> {
  const request: WeighInRequest = { localDate, lb, tz: zone(opts) };
  // The account that owns this weigh-in is the account bound when the user saved it (Phase 9
  // §0.1); every step after an await checks it is still the one bound.
  const h = opts.account ?? accountHandle();
  const userId = h.userId;
  const entry: PendingWeighIn = { userId, request };
  // Write-ahead (PR #248 review r2 #4): the record is on the list BEFORE the send. If the server
  // accepts it and the answer is lost to a switch, this newest record — not an older parked one —
  // is what the drain sends when the account comes back.
  await updatePending(h, (list) => [...list, entry]);
  assertCurrent(h);
  const result = await post(h, request, opts);

  if (result.kind === "retry") {
    // Keep only the last number for a day: this record, and anything written after it.
    await updatePending(h, (list) => {
      const at = lastIndexOf(list, entry);
      return at < 0 ? [...withoutDay(list, userId, localDate), entry]
        : list.filter((e, i) => i >= at || !sameDay(e, entry));
    });
    return null;
  }

  if (result.kind === "refused") {
    // A refusal answers for THIS NUMBER, not for the day. A weigh-in parked earlier is still owed,
    // and retiring the day here deleted it: the user typed 170 offline, mistyped 10 on the way back into
    // signal, and the morning weight was gone with nothing said. Only this record goes.
    await updatePending(h, (list) => retireOnly(list, entry));
    return result.message;
  }

  // Accepted. Any older record for this day must go, or the next drain re-posts the stale number
  // and the RPC's upsert reverts what was just accepted. `post` already checked the account.
  await updatePending(h, (list) => retireThrough(list, entry));
  return null;
}

const inFlight = new Map<string, Promise<DrainResult>>();

/** Forget every in-flight run and the write chain behind it. Tests only. */
export function __resetWeighInDrain(): void {
  inFlight.clear();
  pendingLock = Promise.resolve();
}

/** Forget every in-flight run (Phase 9 §0.3). The runs themselves stop at their next check. */
export function resetWeighInDrains(): void {
  inFlight.clear();
}

export async function drainWeighIns(
  h: AccountHandle, opts: WeighInOptions = {},
): Promise<DrainResult> {
  if (!isCurrent(h)) return { posted: 0, pending: 0 };
  const key = `${h.userId}:${h.epoch}`;
  // `get` and `set` with no await between them: a second caller resuming later finds this run.
  const running = inFlight.get(key);
  if (running) return running;
  // `finally`, so a run that threw on its way out still takes itself off the map. Anything that
  // leaves a settled promise in here is a drain that never runs again on this page.
  const run = runDrain(h, opts).finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

/**
 * A weigh-in the DRAIN gets refused was typed long ago; the user is not looking at the FAB and there is
 * nothing to show the user's. What must not be left behind is a weight on the pill the server has said it
 * will never hold — so the day is cleared, but only while it still holds the refused number. A
 * weight the user has typed since is the user's, and newer than anything this record knows about.
 */
function forgetRefusedWeight(h: AccountHandle, request: WeighInRequest): void {
  assertCurrent(h);
  try {
    if (getDay(request.localDate)?.weightLb !== request.lb) return;
    updateDay(request.localDate, { weightLb: undefined });
    // Today reads the day at render time, so taking the weight out of the store changes nothing on
    // screen until something re-renders — the pill went on showing a weight that had just been
    // removed. The page already listens for this, and lib/sync/client.ts dispatches it the same
    // optional way, because there is no window on the server or in a test.
    globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
  } catch {
    // A blocked localStorage is not a reason to abandon the rest of the batch.
  }
}

async function runDrain(h: AccountHandle, opts: WeighInOptions): Promise<DrainResult> {
  const userId = h.userId;
  const mine = (await readPendingWeighIns(h)).filter((e) => e.userId === userId);
  if (mine.length === 0) return { posted: 0, pending: 0 };

  let posted = 0;
  // Only the newest record of each day is sent (PR #248 review r2 #4): an older one may be
  // superseded by a number the server already accepted. It goes out only once the newer is refused.
  for (const entry of newestPerDay(mine).slice(0, DRAIN_PER_RUN)) {
    // The batch is a snapshot, and a batch takes as long as its POSTs do. By the time this record's
    // turn comes the user may have answered for that day themself — typed a correction that the server
    // took — and re-sending this one would have the RPC's upsert write the old number back over it.
    if (!await stillNewest(h, entry)) continue;

    // Immediately before the send, not after it. `post` carries the browser's ambient cookies, so a
    // session that flipped while the batch was running would file this account's parked weight
    // under the new one. Checking afterwards is one request too late — the damage is already done
    // on the server. `inFlight` is keyed per account, so the new account's own drain is free to run
    // at the same time; this one simply stops.
    if (!isCurrent(h)) break;

    const result = await post(h, entry.request, opts);

    // And again on the way back, because acting on the answer — retiring the record, clearing the
    // day — is a write against this account's state.
    if (!isCurrent(h)) break;
    if (result.kind === "retry") continue;
    if (result.kind === "ok") posted += 1;
    else forgetRefusedWeight(h, entry.request);

    // Settle inside the serialized write — not a list computed before the last await. Accepted:
    // this record and the older ones of its day. Refused: this record only. A correction parked
    // after it stays either way.
    await updatePending(h, (list) =>
      result.kind === "ok" ? retireThrough(list, entry) : retireOnly(list, entry));
  }

  const left = (await readPendingWeighIns(h)).filter((e) => e.userId === userId);
  return { posted, pending: left.length };
}
