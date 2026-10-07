/**
 * One writer tab per account (Phase 9 slice 1, reload boundary; PR #248 review r7 #2).
 *
 * The store is one localStorage blob per account and every save writes all of it, so two tabs of
 * the same account would overwrite each other's edits. Only the tab that holds the Web Lock
 * `smc:writer:<userId>` becomes ready for that account (sync, screens, writes). Another tab of the
 * same account shows "open in another tab" and renders no account data; its "Use here" asks the
 * writer to hand over (lib/device/tab-signal.ts) and waits in the lock queue. The lock is held
 * until the page unloads, so a writer's reload releases it.
 *
 * A browser without Web Locks (older than iOS 15.4, Chrome 69, Firefox 96) uses a lease in
 * localStorage instead (reload review r2 #2): the writer renews it every BEAT_MS; another tab
 * claims it only once it has expired or been released, confirms the claim after a pause, and a
 * writer that finds the lease taken from it leaves (`onLost`). A lock service that exists but does
 * not answer within the budget fails CLOSED (reload review r1 #4): another tab may hold the lock,
 * so this tab waits as "elsewhere", and "Use here" queues for the grant.
 */
import { LOCK_GRANT_BUDGET_MS, lockManager } from "@/lib/log/web-lock";

export type WriterClaim = "writer" | "elsewhere";

export function writerLockName(userId: string): string {
  return `smc:writer:${userId}`;
}

type LockManagerLike = {
  request: (name: string, options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown> | unknown) => Promise<unknown>;
};

/** Released by nothing but the page unloading (or a test). */
let release: (() => void) | null = null;

/* ---- the lease, for browsers without Web Locks ------------------------------------------- */

const LEASE_PREFIX = "smc:device:writer:";
const WANTED_PREFIX = "smc:device:writer-wanted:";
const LEASE_MS = 6_000;
const BEAT_MS = 2_000;
const CONFIRM_MS = 150;
const POLL_MS = 250;

type Lease = { owner: string; until: number };

const SELF = (() => {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
})();

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

function leaseIsOurs(userId: string): boolean {
  return readJson<Lease>(LEASE_PREFIX + userId)?.owner === SELF;
}

/** Take the lease if it is free (expired, released, or ours) and nobody else asked first. */
function tryTake(userId: string, now: number): boolean {
  const lease = readJson<Lease>(LEASE_PREFIX + userId);
  if (lease && lease.owner !== SELF && lease.until > now) return false;
  const wanted = readJson<Lease>(WANTED_PREFIX + userId);
  if (wanted && wanted.owner !== SELF && wanted.until > now) return false;
  return writeJson(LEASE_PREFIX + userId, { owner: SELF, until: now + LEASE_MS } satisfies Lease);
}

async function claimLease(userId: string, wait: boolean, onLost: () => void): Promise<WriterClaim> {
  for (;;) {
    if (wait) writeJson(WANTED_PREFIX + userId, { owner: SELF, until: Date.now() + LEASE_MS });
    if (tryTake(userId, Date.now())) {
      // Two tabs that took it in the same moment: the later write wins; the other sees it here.
      await new Promise((r) => setTimeout(r, CONFIRM_MS));
      if (leaseIsOurs(userId)) {
        try { localStorage.removeItem(WANTED_PREFIX + userId); } catch { /* expires on its own */ }
        holdLease(userId, onLost);
        return "writer";
      }
    }
    if (!wait) return "elsewhere";
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** The lease this page holds (lease mode only), and whether it has lost it since. */
let leaseFor: string | null = null;
let leaseLost = false;
let lostHandler: (() => void) | null = null;

function lose(): void {
  if (leaseLost) return;
  leaseLost = true;
  lostHandler?.();
}

function holdLease(userId: string, onLost: () => void): void {
  const key = LEASE_PREFIX + userId;
  leaseFor = userId;
  leaseLost = false;
  lostHandler = onLost;
  const beat = setInterval(() => {
    if (!writerFenceOk()) { stop(); return; }
    writeJson(key, { owner: SELF, until: Date.now() + LEASE_MS } satisfies Lease);
  }, BEAT_MS);
  const onHide = (): void => { stop(); lose(); };
  function stop(): void {
    clearInterval(beat);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onHide);
    try { if (leaseIsOurs(userId)) localStorage.removeItem(key); } catch { /* it expires */ }
  }
  if (typeof window !== "undefined") window.addEventListener("pagehide", onHide);
  release = () => { stop(); lose(); };
}

/**
 * The store's fence (reload review r3 #1): true while this page may write the account's store. In
 * lease mode that means the lease is still ours and unexpired right now — checked on every save,
 * not only by the heartbeat. A page that lost it (expired while suspended, released on pagehide
 * before a back-forward-cache return, taken by another tab) writes nothing again and leaves.
 */
export function writerFenceOk(): boolean {
  if (leaseFor === null) return true; // Web Locks mode (exclusive until unload), or no claim yet
  if (leaseLost) return false;
  const lease = readJson<Lease>(LEASE_PREFIX + leaseFor);
  if (lease?.owner === SELF && lease.until > Date.now()) return true;
  lose();
  return false;
}

/** A page restored from the back-forward cache left its lock or lease behind: it leaves. */
let restoreOff: (() => void) | null = null;

function watchRestore(onLost: () => void): void {
  if (typeof window === "undefined") return;
  const onShow = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted) onLost();
  };
  window.addEventListener("pageshow", onShow);
  restoreOff = () => window.removeEventListener("pageshow", onShow);
}

/**
 * Claim the writer lock. `wait: false` answers "elsewhere" at once when another tab holds it;
 * `wait: true` queues behind it (for "Use here") and answers "writer" when it is granted.
 */
export function claimWriter(
  userId: string,
  opts: {
    wait?: boolean; locks?: LockManagerLike | null; budgetMs?: number; onLost?: () => void;
  } = {},
): Promise<WriterClaim> {
  const locks = opts.locks !== undefined ? opts.locks : lockManager() as LockManagerLike | null;
  const onLost = opts.onLost ?? (() => {});
  if (!locks) {
    return claimLease(userId, opts.wait ?? false, onLost).then((claim) => {
      if (claim === "writer") watchRestore(onLost);
      return claim;
    });
  }
  return new Promise<WriterClaim>((resolve) => {
    let answered = false;
    const answer = (claim: WriterClaim): void => {
      if (answered) return;
      answered = true;
      resolve(claim);
    };
    // Only an unanswered ifAvailable ask is bounded: a queued ask waits for its grant by design.
    const timer = opts.wait ? null : setTimeout(() => {
      console.warn("The browser is not answering about locks; this tab waits for another tab.");
      answer("elsewhere");
    }, opts.budgetMs ?? LOCK_GRANT_BUDGET_MS * 3);
    void locks.request(writerLockName(userId), opts.wait ? {} : { ifAvailable: true }, (lock) => {
      if (timer) clearTimeout(timer);
      if (!lock) { answer("elsewhere"); return undefined; }
      if (answered) return undefined; // a late grant after the budget is released at once
      watchRestore(onLost);
      answer("writer");
      return new Promise<void>((done) => { release = done; });
    }).catch(() => {
      if (timer) clearTimeout(timer);
      answer("elsewhere");
    });
  });
}

/** Test seam: release the lock this document holds, as an unload would. */
export function __releaseWriter(): void {
  release?.();
  release = null;
  restoreOff?.();
  restoreOff = null;
  leaseFor = null;
  leaseLost = false;
  lostHandler = null;
}
