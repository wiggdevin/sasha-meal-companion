/**
 * Leaving an account (Phase 9 slice 1, reload boundary; replaces the in-place switch of PR #248).
 *
 * On sign-out, or when the session changes under this page (another tab signed in or out), the
 * page never switches accounts in place. It:
 *
 *  1. CLOSES, synchronously: no new work may start (`accountHandle()` refuses), the gone listeners
 *     stop sync and the gate shows the neutral shell. The account stays bound, so work already
 *     running (it holds its handle) can finish — an outbox commit and the store projection after
 *     it land together (reload review r1 #2).
 *  2. Waits for quiet: until no handle check happened across one database barrier and a short
 *     pause, bounded by QUIET_BUDGET_MS. Work still waiting on the network after that is the
 *     server's answer; the queued write it answers is already durable and reconciles later.
 *  3. FREEZES, synchronously, with no await in between: takes the account's in-memory-only store
 *     edit (a save localStorage refused), refuses every later store save, and unbinds. Every
 *     handle of the account is stale from then on.
 *  4. Makes the state durable under the account's OWN keys: the store edit is written (retried
 *     once), and one barrier transaction over its database commits after every transaction this
 *     page started on it.
 *  5. Only then signs out (app-initiated sign-out only) and replaces the page. The next page binds
 *     whatever account the session holds, once, at cold start (lib/device/boot.ts).
 *
 * If step 4 or the sign-out fails, nothing else happens: no auth change, no reload. The gate shows
 * a neutral "could not be saved yet" screen, the edit stays in this module's memory, and Retry runs
 * step 4 again. The page shows neither account's data meanwhile.
 */
import {
  accountActivity, closeAccount, currentAccountOrNull, unbindAccount,
} from "./account";
import { announce } from "./tab-signal";
import { writerFenceOk } from "./writer-lock";
import { freezeStore, unsavedStoreFor, writeDepartingStore } from "@/lib/store";
import { settleAccountDb } from "@/lib/sync/idb";
import type { Store } from "@/lib/types";

/** The longest the page waits for running work before it freezes anyway. */
export const QUIET_BUDGET_MS = 3_000;
/** The longest the durability barrier may take before the page blocks with Retry. */
export const SETTLE_BUDGET_MS = 5_000;
const QUIET_PAUSE_MS = 30;

/** Rejects when `p` has not settled within `ms` (reload review r2 #5: an IndexedDB open or
 *  transaction that never answers must not hold the page on "Saving changes" forever). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

export type DeparturePhase = "none" | "leaving" | "blocked";

type Departing = {
  userId: string | null;
  frozen: boolean;
  store: Store | null;
  signOut: (() => Promise<void>) | null;
  /** Where the page goes once it has left (account deletion: the sign-in page). */
  reloadTo: string | null;
};

export type DepartureDeps = {
  /** Replaces the page. Default: `location.replace(location.href)`. */
  reload?: () => void;
  /** Test seams for the two budgets. */
  quietMs?: number;
  settleMs?: number;
};

let departing: Departing | null = null;
let phase: DeparturePhase = "none";
let running: Promise<DeparturePhase> | null = null;
let deps: DepartureDeps = {};
const listeners = new Set<(p: DeparturePhase) => void>();

function setPhase(next: DeparturePhase): void {
  phase = next;
  for (const fn of [...listeners]) fn(next);
}

export function departurePhase(): DeparturePhase { return phase; }

/** True once this page has started leaving its account: it binds nothing again. */
export function isDeparting(): boolean { return departing !== null; }

export function onDeparturePhase(fn: (p: DeparturePhase) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Where the reload goes (reload review r3 #3): the same page when the service worker has its
 * document cached, else "/" — the one route whose document and build chunks every install
 * guarantees (public/sw.js). An uncached route could come back offline as another route's
 * document; "/" always opens, as the new account's Today or the signed-out card.
 */
export async function reloadTarget(
  href: string, match: ((url: string) => Promise<unknown>) | null,
): Promise<string> {
  if (match === null) return href; // no service worker cache: the network serves every route
  try {
    return (await match(href)) ? href : "/";
  } catch {
    return "/";
  }
}

function defaultReload(): void {
  const match = typeof caches === "undefined" ? null : (url: string) => caches.match(url);
  void reloadTarget(window.location.href, match).then((target) => window.location.replace(target));
}

/** Two tries: a quota refusal can clear between them (another tab freed space). */
function persistStore(d: Departing): void {
  if (d.userId === null || d.store === null) return;
  // Lease mode only: another tab is the writer now, and writing this page's copy over its blob
  // would erase its edits (reload review r3 #1). With Web Locks this cannot happen.
  if (!writerFenceOk()) {
    console.warn("This tab is no longer the writer; its unsaved change is not written.");
    d.store = null;
    return;
  }
  if (writeDepartingStore(d.userId, d.store) || writeDepartingStore(d.userId, d.store)) {
    d.store = null;
    return;
  }
  throw new Error("store_not_persisted");
}

/** Step 2: until no work of the account ran across one barrier and a pause (bounded). */
async function waitForQuiet(userId: string): Promise<void> {
  const deadline = Date.now() + (deps.quietMs ?? QUIET_BUDGET_MS);
  let seen = -1;
  while (Date.now() < deadline) {
    const now = accountActivity();
    if (now === seen) return;
    seen = now;
    // Step 4 runs the barrier again, and blocks when it fails or does not answer.
    await within(settleAccountDb(userId), Math.max(0, deadline - Date.now())).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, QUIET_PAUSE_MS));
  }
}

/** Step 3, synchronous: nothing can save between the snapshot and the unbind. */
function freeze(d: Departing): void {
  if (d.frozen) return;
  d.store = d.userId === null ? null : unsavedStoreFor(d.userId);
  freezeStore();
  unbindAccount();
  d.frozen = true;
}

async function settle(): Promise<DeparturePhase> {
  const d = departing as Departing;
  if (!d.frozen && d.userId !== null) await waitForQuiet(d.userId);
  freeze(d);
  try {
    persistStore(d);
    if (d.userId !== null) {
      await within(settleAccountDb(d.userId, { close: true }), deps.settleMs ?? SETTLE_BUDGET_MS);
    }
    if (d.signOut) await d.signOut();
  } catch {
    setPhase("blocked");
    return "blocked";
  }
  const target = d.reloadTo;
  (deps.reload ?? (target === null ? defaultReload : () => window.location.replace(target)))();
  return "leaving";
}

/**
 * Leave the bound account (or, with none bound, just reload). Idempotent: a second call while one
 * runs returns the same promise.
 *
 * `signOut` runs only after the account's state is durable, and only when the departure was
 * started for it: a sign-out asked for while a departure for another reason runs is dropped, so
 * it can never remove the next account's session (reload review r1 #9). `announce` tells the
 * account's other tabs to leave too. `reloadTo` replaces the page with that path instead of the
 * same page (account deletion lands on the sign-in page).
 */
export function beginDeparture(opts: {
  signOut?: () => Promise<void>; announce?: boolean; reloadTo?: string;
} = {}): Promise<DeparturePhase> {
  if (departing === null) {
    const bound = currentAccountOrNull();
    departing = {
      userId: bound?.userId ?? null, frozen: false, store: null, signOut: opts.signOut ?? null,
      reloadTo: opts.reloadTo ?? null,
    };
    closeAccount();
    setPhase("leaving");
    if (bound && opts.announce) announce({ type: "leaving", userId: bound.userId });
  }
  if (phase === "blocked") return Promise.resolve("blocked");
  running ??= settle().finally(() => { running = null; });
  return running;
}

/** The blocked screen's Retry: step 2 (and the sign-out) again. */
export function retryDeparture(): Promise<DeparturePhase> {
  if (departing === null) return Promise.resolve(phase);
  if (running) return running;
  setPhase("leaving");
  running = settle().finally(() => { running = null; });
  return running;
}

/** Test seam. */
export function __setDepartureDeps(next: DepartureDeps): void { deps = next; }

/** Test seam: a fresh page. */
export function __resetDeparture(): void {
  departing = null;
  phase = "none";
  running = null;
  deps = {};
  listeners.clear();
}
