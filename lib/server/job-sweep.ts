/**
 * The shared shape of every background job that walks accounts (scale-readiness S3, built for
 * 1,000 accounts and more). The resume cursor that strings budgeted runs into one pass is
 * lib/server/job-cursor.ts.
 *
 * - `keysetRows` pages a listing by its key (`key > last`, ordered by key), so no row past the API's
 *   1,000-row cap (`max_rows`, supabase/config.toml) is silently dropped and no page costs a deep
 *   OFFSET scan.
 * - `runWithinBudget` runs the work for each item with a bounded number in flight, isolates each
 *   item's failure, and stops STARTING items at a deadline (checked again after every page read).
 *   Work still in flight at the hard stop is abandoned and reported for retry, so the caller always
 *   has time to save its cursor before the function limit. The items started are an unbroken
 *   prefix of the listing and the last one started is an exact resume point; every item in that
 *   prefix that did not finish cleanly is in `retry`.
 */

export const KEYSET_PAGE = 1000;
/** A server that ignored the key filter would return the same full page forever. */
const MAX_PAGES = 10_000;

type Page<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Every row of a listing after `after`, one page at a time. `page(after, size)` must filter
 * `key > after` (when `after` is not null), order by the key ascending and return at most `size`
 * rows; the key must be unique. Throws on the first failed page.
 */
export async function* keysetRows<T>(
  page: (after: string | null, size: number) => PromiseLike<Page<T>>,
  keyOf: (row: T) => string,
  after: string | null = null,
  size: number = KEYSET_PAGE,
): AsyncGenerator<T> {
  let last = after;
  let previousFirst: string | null = null;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const { data, error } = await page(last, size);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    // A page that starts where the last one did, or at the key it was asked to pass, made no
    // progress: the key filter was ignored. (Keys are compared for equality only; text keys
    // sort by the database's collation, which JS string order need not match.)
    const first = rows.length > 0 ? keyOf(rows[0]) : null;
    if (first !== null && (first === last || first === previousFirst)) {
      throw new Error(`keysetRows: the page after ${last} repeats rows; the listing ignores its key`);
    }
    previousFirst = first;
    for (const row of rows) {
      last = keyOf(row);
      yield row;
    }
    if (rows.length < size) return;
  }
  throw new Error(`keysetRows: exceeded ${MAX_PAGES} pages; the paging contract likely broke`);
}

/** What one item's work came to. `retry`: it did not finish (failed, or another run holds it) and
 *  a later run must try it again. `skip`: nothing to do, finally. `ok` (or no value): done. */
export type ItemResult = "ok" | "skip" | "retry";

export type RunOutcome = {
  /** Items whose work started. */
  started: number;
  /** Items whose work threw past the job's own handling. */
  failed: number;
  /** Key of the last item started; every item up to it was started. */
  cursor: string | null;
  /** True when the listing ran out: nothing is left after `cursor`. */
  complete: boolean;
  /** Keys of started items that must run again: threw, returned "retry", or were still in flight
   *  at the hard stop. In listing order. */
  retry: string[];
  /** A listing page that failed. The prefix before it was started and `cursor` is still exact. */
  listError?: unknown;
  /** A listing page was still pending at the hard stop; the run stopped without it. */
  stalled?: boolean;
};

export type BudgetedRun<T> = {
  items: AsyncIterable<T>;
  keyOf: (item: T) => string;
  /** Most items in flight at once. */
  concurrency: number;
  /** Epoch ms after which no new item starts. */
  deadline: number;
  /** Epoch ms after which in-flight work is no longer awaited (default: never). */
  hardStop?: number;
  work: (item: T) => Promise<ItemResult | void>;
  onError?: (item: T, error: unknown) => void;
  now?: () => number;
};

const STALLED: unique symbol = Symbol("stalled");

/** A cancellable wait; an infinite or past wait never schedules a timer. */
function wait(ms: number): { done: Promise<void>; cancel: () => void } {
  if (!Number.isFinite(ms)) return { done: new Promise<void>(() => undefined), cancel: () => undefined };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); });
  return { done, cancel: () => clearTimeout(timer) };
}

async function raceWait(promise: Promise<unknown>, ms: number): Promise<void> {
  const timer = wait(ms);
  try { await Promise.race([promise, timer.done]); } finally { timer.cancel(); }
}

/**
 * Runs `work` over `items` in listing order with at most `concurrency` in flight. One item's
 * failure never stops another. At `deadline` no new item starts; in-flight work is awaited until
 * `hardStop`, and whatever is still running then is reported in `retry`.
 */
export async function runWithinBudget<T>(run: BudgetedRun<T>): Promise<RunOutcome> {
  const now = run.now ?? Date.now;
  const hardStop = run.hardStop ?? Infinity;
  const limit = Math.max(1, Math.floor(run.concurrency));
  const iterator = run.items[Symbol.asyncIterator]();
  const running = new Map<Promise<void>, string>();
  const order: string[] = [];
  const retry = new Set<string>();
  const outcome: RunOutcome = { started: 0, failed: 0, cursor: null, complete: false, retry: [] };

  try {
    while (now() < run.deadline) {
      if (running.size >= limit) {
        await raceWait(Promise.race(running.keys()), run.deadline - now());
        continue;
      }
      // The page read races the hard stop too: a stalled page must not hold the run past it.
      const timer = wait(hardStop - now());
      const pending = iterator.next();
      let next: IteratorResult<T> | typeof STALLED;
      try {
        next = await Promise.race<IteratorResult<T> | typeof STALLED>(
          [pending, timer.done.then((): typeof STALLED => STALLED)]);
      } finally {
        timer.cancel();                       // a failed page must not leave the timer live
      }
      if (typeof next === "symbol") {
        outcome.stalled = true;
        pending.catch(() => undefined);       // a late failure of the abandoned read is moot
        break;
      }
      if (next.done) {
        outcome.complete = true;
        break;
      }
      // A slow page can carry the run past its deadline: that item is not started, so the
      // cursor stays before it and the next run lists it again.
      if (now() >= run.deadline) break;
      const item = next.value;
      const key = run.keyOf(item);
      outcome.cursor = key;
      outcome.started += 1;
      order.push(key);
      // Deferred a tick so `task` is assigned before its own cleanup can run.
      const task: Promise<void> = Promise.resolve()
        .then(() => run.work(item))
        .then((result) => { if (result === "retry") retry.add(key); })
        .catch((error: unknown) => {
          outcome.failed += 1;
          retry.add(key);
          try { run.onError?.(item, error); } catch { /* a logger must not stop the run */ }
        })
        .then(() => { running.delete(task); });
      running.set(task, key);
    }
  } catch (error) {
    outcome.listError = error;
  }
  await raceWait(Promise.all(running.keys()), hardStop - now());
  for (const key of running.values()) retry.add(key);   // abandoned at the hard stop
  // A generator with a read still pending cannot be closed; it is abandoned with the run.
  if (!outcome.complete && !outcome.stalled) {
    void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
  }
  outcome.retry = order.filter((key) => retry.has(key));
  return outcome;
}
