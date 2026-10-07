/**
 * Every Web Lock this app takes on the way to a save, and the budget all of them share.
 *
 * The lock is a guarantee across tabs, never a dependency: a browser whose lock service does not
 * answer must not be able to stop a meal being logged. One call was bounded and another was not,
 * and that was enough — the card was drawn and the write behind it never enqueued, never posted
 * and left no record, so the meal was on Today and nowhere else (panel round 11). So the budget
 * lives here, with the two shapes of request that need it, and nothing in the commit path asks the
 * browser for a lock any other way.
 *
 * On a timeout the caller carries on without the lock, which is the same position it is in on a
 * browser that has no Web Locks API at all — documented in docs/architecture.md — and a grant that
 * turns up late is released at once rather than held.
 */

/** How long a grant may take before the caller stops waiting for it. */
export const LOCK_GRANT_BUDGET_MS = 1_000;

type Locks = {
  request: (name: string, a: unknown, b?: unknown) => Promise<unknown>;
};

export function lockManager(): Locks | null {
  return (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks ?? null;
}

/**
 * How long an unanswered ask is remembered, and by WHAT.
 *
 * A latch for the life of the page was wrong twice over: a commit-lock ask that is never made is a
 * tab believing it owns an entry it does not, which is two tabs committing one meal (panel round
 * 12, item 2). So the memory is short, and only the queued records lock consults it — that one is
 * taken on every record write, and paying the budget on each of them would turn one wedged service
 * into a save of many seconds. Every commit-lock ask is made, every time.
 *
 * It is also set by nothing but that lock's OWN timeout, and remembered per name. A slow `isHeld`
 * on a busy main thread used to mark the whole path wedged, which took the guard off every record
 * write for the window — two tabs reading, changing and writing one `meta` key over each other,
 * which is what this lock exists to prevent (Grok pass 14, MEDIUM 1). A probe that times out is a
 * one-off: it warns, and nothing more.
 */
const WEDGED_WINDOW_MS = 5_000;

let wedgedName: string | null = null;
let wedgedUntil = 0;
let warned = false;

function sayOnce(): void {
  if (warned) return;
  warned = true;
  console.warn("The browser is not answering about locks; saving without them.");
}

function markWedged(name: string, now: number = Date.now()): void {
  wedgedName = name;
  wedgedUntil = now + WEDGED_WINDOW_MS;
  sayOnce();
}

function wedged(name: string, now: number = Date.now()): boolean {
  return wedgedName === name && now < wedgedUntil;
}

/** Tests only: the warning is once per page, and a suite is many pages' worth of runs. */
export function resetLockWarning(): void {
  wedgedName = null;
  wedgedUntil = 0;
  warned = false;
}

/** The answer, or the news that this browser's lock service is not answering. */
async function within<T>(answer: Promise<T>, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const budget = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), LOCK_GRANT_BUDGET_MS);
  });
  try {
    const first = await Promise.race([answer, budget]);
    if (first !== "timeout") return first;
    sayOnce();
    return onTimeout();
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Hold `name` for as long as the returned release is not called — or find out that something else
 * holds it. `ifAvailable` is what makes that question non-blocking: a plain request QUEUES, and a
 * caller that does not wait for the grant ends up holding a lock long after it needed it.
 *
 * `null` means another context has it. A browser with no lock service, or one that does not answer
 * within the budget, gives a release that does nothing — the caller proceeds.
 */
export async function acquireBounded(name: string): Promise<(() => void) | null> {
  const locks = lockManager();
  if (!locks) return () => {};
  const granted = new Promise<(() => void) | null>((resolve) => {
    void Promise.resolve(locks.request(name, { ifAvailable: true }, (lock: unknown) => {
      if (lock === null) { resolve(null); return Promise.resolve(); }
      // Held until the release runs — and the release only exists once the grant has, so it can
      // never be a no-op fired at a lock this tab has not been given yet.
      return new Promise<void>((done) => resolve(() => done()));
    })).catch(() => resolve(() => {}));
  });
  try {
    return await within<(() => void) | null>(granted, () => {
      // The grant may still arrive; releasing it when it does keeps nothing held.
      void granted.then((late) => late?.()).catch(() => undefined);
      return () => {};
    });
  } catch {
    return () => {};
  }
}

/** Is something holding `name`? Asked without waiting, and false when the browser will not say. */
export async function isHeld(name: string): Promise<boolean> {
  const locks = lockManager();
  if (!locks) return false;
  try {
    const answer = Promise.resolve(
      locks.request(name, { ifAvailable: true }, async (lock: unknown) => lock === null),
    ) as Promise<boolean>;
    return await within<boolean>(answer, () => false);
  } catch {
    // A browser that refuses the question is not a browser that is holding this name.
    return false;
  }
}

/**
 * Run `work` under `name`, waiting for the turn — and running it anyway only when the browser
 * never answers at all.
 *
 * A QUEUED request, deliberately: `ifAvailable` answering `null` means another document holds the
 * name, and carrying on then is two tabs' read-modify-write over one key, which is the lost clear
 * this lock exists to prevent (panel round 12, item 1). Waiting is the point; the budget is only
 * there so a wedged service cannot stop a save.
 */
export async function underBoundedLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  // Asked on every record write, so a service known to be wedged is not asked again for a few
  // seconds; a commit lock is never skipped this way.
  if (!locks || wedged(name)) return work();
  let letGo: (() => void) | null = null;
  const granted = new Promise<() => void>((resolve) => {
    void Promise.resolve(locks.request(name, () => new Promise<void>((done) => resolve(() => done()))))
      .catch(() => resolve(() => {}));
  });
  try {
    letGo = await within<(() => void) | null>(granted, () => {
      // This lock's own timeout, and only this one, is what the skip above remembers.
      markWedged(name);
      // The turn may still come; taking and dropping it keeps nothing held.
      void granted.then((late) => late()).catch(() => undefined);
      return null;
    });
  } catch {
    letGo = null;
  }
  try {
    return await work();
  } finally {
    letGo?.();
  }
}
