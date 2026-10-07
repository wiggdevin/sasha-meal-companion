/**
 * Cold-start binding (Phase 9 slice 1, reload boundary). A page binds at most ONE account, once:
 *
 *   session → bind → claim the writer lock → adopt legacy data → ready
 *
 * A later session for another account (or none) never rebinds this page: it starts a departure
 * (lib/device/departure.ts), which reloads, and the next page binds at its own cold start. Legacy
 * adoption therefore runs only here, before ready, and only in the writer tab of the account.
 *
 * A second tab of the same account does not become ready: it waits as "elsewhere" (no data, no
 * sync, no writes) until the user asks to use it here; see lib/device/writer-lock.ts.
 */
import {
  AccountChanged, bindAccount, isAccountClosing, isCurrent, markAccountReady, type AccountHandle,
} from "./account";
import { beginDeparture, isDeparting } from "./departure";
import { touchAccount } from "./forget";
import { adoptLegacyDevice } from "./legacy-adoption";
import { announce, onTabSignal, type TabSignal } from "./tab-signal";
import { claimWriter } from "./writer-lock";

export type BootPhase = "idle" | "binding" | "elsewhere" | "waiting" | "ready" | "failed";

const ADOPTION_TRIES = 2;

type BootDeps = {
  claim?: typeof claimWriter;
  reload?: () => void;
};

let documentAccount: string | null = null;
let handle: AccountHandle | null = null;
let writer = false;
let phase: BootPhase = "idle";
let deps: BootDeps = {};
const listeners = new Set<(p: BootPhase) => void>();

function setPhase(next: BootPhase): void {
  phase = next;
  for (const fn of [...listeners]) fn(next);
}

export function bootPhase(): BootPhase { return phase; }

export function onBootPhase(fn: (p: BootPhase) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The account this page bound at cold start, even after it started leaving it. */
export function documentAccountId(): string | null { return documentAccount; }

export type SessionOutcome = "bound" | "signed-out" | "departing";

/**
 * Apply the session's account to this page. The first account binds; the same account again (a
 * token refresh, a navigation) changes nothing; any other account, or none, departs.
 */
export function applySessionAccount(userId: string | null): SessionOutcome {
  if (isDeparting()) return "departing";
  if (documentAccount !== null) {
    if (userId === documentAccount) return "bound";
    // The account's other tabs may have missed the auth event (reload review r1 #8).
    void beginDeparture({ announce: true });
    return "departing";
  }
  if (userId === null) return "signed-out";
  documentAccount = userId;
  const h = bindAccount(userId);
  handle = h;
  touchAccount(userId);
  void claimThenAdopt(h, false);
  return "bound";
}

async function claimThenAdopt(h: AccountHandle, wait: boolean): Promise<void> {
  setPhase(wait ? "waiting" : "binding");
  // A lease-based writer (no Web Locks) that loses its lease leaves: another tab writes now.
  const claim = await (deps.claim ?? claimWriter)(h.userId, {
    wait, onLost: () => { void beginDeparture(); },
  });
  if (!isCurrent(h)) return;
  if (claim === "elsewhere") { setPhase("elsewhere"); return; }
  writer = true;
  await adoptThenReady(h);
}

/** Ready only after a successful adoption (spec §0.1; audit plan r1 finding 7). */
async function adoptThenReady(h: AccountHandle): Promise<void> {
  if (typeof indexedDB !== "undefined") {
    let adopted = false;
    for (let attempt = 0; attempt < ADOPTION_TRIES && !adopted; attempt += 1) {
      try {
        await adoptLegacyDevice(h);
        adopted = true;
      } catch (e) {
        if (e instanceof AccountChanged || !isCurrent(h)) return;
        console.warn("Legacy adoption failed", e instanceof Error ? e.name : "unknown");
      }
    }
    if (!adopted) { if (isCurrent(h)) setPhase("failed"); return; }
  }
  if (!isCurrent(h) || isAccountClosing()) return; // leaving: this page is never ready again
  markAccountReady(h);
  setPhase("ready");
}

/** "Use here" in a tab of the same account: ask the writer to hand over, then wait for the lock. */
export function useHere(): void {
  if (phase !== "elsewhere" || handle === null || !isCurrent(handle)) return;
  announce({ type: "handover", userId: handle.userId });
  void claimThenAdopt(handle, true);
}

/** Retry after a failed adoption: a fresh page, so adoption runs again at its cold start only. */
export function retryBoot(): void {
  (deps.reload ?? (() => window.location.reload()))();
}

/** Another tab's signal for this page's account: leave it, or hand the writer lock over. A
 *  received signal is never announced again (no echo). */
export function handleTabSignal(signal: TabSignal): void {
  if (documentAccount === null || signal.userId !== documentAccount) return;
  if (signal.type === "leaving") { void beginDeparture(); return; }
  if (signal.type === "handover" && writer) void beginDeparture();
}

/** AuthGate mounts this once: other tabs' signals reach this page for as long as it lives. */
export function watchTabSignals(): () => void {
  return onTabSignal(handleTabSignal);
}

/**
 * The server answered `409 account_mismatch`: the session is confirmed to be another account's.
 * The page leaves at once, without waiting for a session read (reload review r4 #2).
 */
export function onAccountMismatch(): void {
  if (documentAccount === null) return;
  void beginDeparture({ announce: true });
}

/** Test seam. */
export function __setBootDeps(next: BootDeps): void { deps = next; }

/** Test seam: a fresh page. */
export function __resetBoot(): void {
  documentAccount = null;
  handle = null;
  writer = false;
  phase = "idle";
  deps = {};
  listeners.clear();
}
