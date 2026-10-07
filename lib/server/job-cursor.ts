/**
 * One pass of a periodic job, strung across budgeted runs (scale-readiness S3). The pass state lives
 * in `job_cursors` (migration 20261217120300), one row per job and period (a UTC date):
 *
 * - `after_key`: the last item the listing phase started. The next run lists after it.
 * - `listed`: the listing ran to its end once.
 * - `retry_keys`: items that did not finish cleanly (failed, still held by another run, or cut off
 *   at the hard stop). Once the listing is done, the next runs work through exactly these.
 * - `relist`: the retry queue overflowed `MAX_RETRY_KEYS`; when the listing ends, the pass lists
 *   again from the start instead of retrying a list, and the per-user locks skip whoever is done.
 * - `done`: listed with nothing left to retry. Later fires of the period return at once.
 * - `pass_started_at`: the instant the pass began. Work that derives a date or week from "now"
 *   uses it, so every run of one pass computes the same date or week for an account.
 * - `lease_owner` / `lease_until`: one run at a time advances a pass. `claim_job_cursor` takes the
 *   lease in one statement (only when none is live) and returns the state; the save is a
 *   compare-and-set on the owner, so a run that lost its lease never overwrites the pass.
 *
 * The per-user `job_runs` lock, not this row, keeps an account to one run per key. A claim that
 * fails (the table or function is missing, the database is unreachable) is logged and the run
 * walks the whole listing with no cursor: slower, never wrong.
 */
import { randomUUID } from "node:crypto";
import type { adminClient } from "@/lib/server/admin";
import { runWithinBudget, type BudgetedRun, type RunOutcome } from "@/lib/server/job-sweep";

type Admin = ReturnType<typeof adminClient>;

/** Longer than any job's `maxDuration` (300 s), so a live run never loses its lease; a killed
 *  run's lease lapses well before the next hourly fire. */
export const LEASE_SECONDS = 360;

/** The most keys a pass queues for retry; past it the pass re-lists instead (`relist`). */
export const MAX_RETRY_KEYS = 2_000;

export type PassState = {
  after: string | null;
  listed: boolean;
  retry: string[];
  relist: boolean;
  done: boolean;
  startedAt: Date;
};

type Claim =
  | { kind: "claimed"; state: PassState }
  | { kind: "busy" }
  | { kind: "unavailable" };

function parseState(row: unknown): PassState | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const startedAt = new Date(String(r.pass_started_at));
  if (typeof r.listed !== "boolean" || typeof r.done !== "boolean" || typeof r.relist !== "boolean"
    || !Array.isArray(r.retry_keys) || Number.isNaN(startedAt.getTime())) return null;
  return {
    after: typeof r.after_key === "string" ? r.after_key : null,
    listed: r.listed, done: r.done, relist: r.relist, startedAt,
    retry: r.retry_keys.filter((k): k is string => typeof k === "string"),
  };
}

export async function claimPass(
  admin: Admin, job: string, period: string, owner: string, restart: boolean,
): Promise<Claim> {
  try {
    const { data, error } = await admin.rpc("claim_job_cursor", {
      p_job: job, p_period: period, p_owner: owner, p_lease_seconds: LEASE_SECONDS,
      p_restart: restart,
    });
    if (error) throw new Error(error.message);
    if (Array.isArray(data) && data.length === 0) return { kind: "busy" };
    const state = parseState(Array.isArray(data) ? data[0] : data);
    if (!state) throw new Error("claim_job_cursor returned no readable state");
    return { kind: "claimed", state };
  } catch (e) {
    console.error("job cursor claim failed; this run walks the whole listing", { job, period,
      error: e instanceof Error ? e.message : "unknown" });
    return { kind: "unavailable" };
  }
}

/** Saves the pass and releases the lease, only while `owner` still holds it. */
export async function savePass(
  admin: Admin, job: string, period: string, owner: string,
  state: Omit<PassState, "startedAt">,
): Promise<void> {
  try {
    const { data, error } = await admin.from("job_cursors").update({
      after_key: state.after, listed: state.listed, retry_keys: state.retry, relist: state.relist,
      done: state.done,
      lease_owner: null, lease_until: null, updated_at: new Date().toISOString(),
    }).eq("job", job).eq("period", period).eq("lease_owner", owner).select("job");
    if (error) throw new Error(error.message);
    if ((data?.length ?? 0) !== 1) {
      console.error("job cursor lease lost; this run's progress was not saved", { job, period });
    }
  } catch (e) {
    console.error("job cursor save failed; the next run repeats this one", { job, period,
      error: e instanceof Error ? e.message : "unknown" });
  }
}

export type SweepOptions<T> = Omit<BudgetedRun<T>, "items" | "work"> & {
  job: string;
  /** The run period the pass belongs to, e.g. the UTC date of a daily job. */
  period: string;
  /** The listing, starting after a key (null: from the start). */
  list: (after: string | null) => AsyncIterable<T>;
  /** The items for these keys, for the retry phase (a key no longer listed may be left out). */
  byKeys: (keys: string[]) => AsyncIterable<T>;
  /** Discard the saved pass and start a fresh one (an explicit operator run). */
  restart?: boolean;
  /** `passStartedAt`: the instant the pass began; derive any date or week from it. */
  work: (item: T, pass: { passStartedAt: Date }) => Promise<"ok" | "skip" | "retry" | void>;
};

export type SweepResult = RunOutcome & {
  /** The period was already finished by an earlier run; nothing ran. */
  alreadyDone: boolean;
  /** Another run holds this pass; nothing ran. */
  busy: boolean;
  /** Listed to the end with nothing left to retry. */
  passDone: boolean;
};

const idle = (extra: Partial<SweepResult>): SweepResult => ({ started: 0, failed: 0,
  cursor: null, complete: false, retry: [], alreadyDone: false, busy: false, passDone: false,
  ...extra });

/**
 * One budgeted run of a pass: the listing phase until the listing ends, then the retry phase until
 * nothing is left to retry. A failed listing page saves the exact progress and then rethrows.
 */
export async function sweep<T>(admin: Admin, options: SweepOptions<T>): Promise<SweepResult> {
  const { job, period, list, byKeys, restart = false, work, ...run } = options;
  const owner = randomUUID();
  const claim = await claimPass(admin, job, period, owner, restart);
  if (claim.kind === "busy") return idle({ busy: true });
  const leased = claim.kind === "claimed";
  const state: PassState = leased ? claim.state
    : { after: null, listed: false, retry: [], relist: false, done: false, startedAt: new Date() };
  if (state.done) {
    await savePass(admin, job, period, owner, state);
    return idle({ alreadyDone: true, complete: true, passDone: true });
  }

  const pass = { passStartedAt: state.startedAt };
  const retryPhase = state.listed;
  const keys = retryPhase ? state.retry : [];
  const outcome = await runWithinBudget({
    ...run,
    items: retryPhase ? byKeys(keys) : list(state.after),
    work: (item) => work(item, pass),
  });

  let next: Omit<PassState, "startedAt">;
  if (retryPhase) {
    // Keys this run did not reach stay queued; a key byKeys no longer returns is dropped.
    const reached = outcome.complete ? keys.length : keys.indexOf(outcome.cursor ?? "") + 1;
    const left = [...new Set([...outcome.retry, ...keys.slice(reached)])];
    next = { after: state.after, listed: true, retry: left, relist: false,
      done: left.length === 0 };
  } else {
    let retry = [...new Set([...state.retry, ...outcome.retry])];
    let relist = state.relist;
    if (retry.length > MAX_RETRY_KEYS) {
      console.error(`job ${job} pass ${period}: retry queue overflow; it will list again`, {
        queued: retry.length, limit: MAX_RETRY_KEYS });
      retry = [];
      relist = true;
    }
    next = outcome.complete && relist
      // The listing ended with too many failures to queue: walk it again from the start.
      ? { after: null, listed: false, retry: [], relist: false, done: false }
      : { after: outcome.cursor ?? state.after, listed: outcome.complete, retry, relist,
        done: outcome.complete && retry.length === 0 };
  }
  if (leased) await savePass(admin, job, period, owner, next);
  if (!next.done) {
    console.warn(`job ${job} pass ${period} is not finished`, {
      phase: retryPhase ? "retry" : "listing", started: outcome.started,
      listed: next.listed, retryQueued: next.retry.length, stoppedAtBudget: !outcome.complete,
      stalledPage: outcome.stalled === true,
    });
  }
  if (outcome.listError !== undefined) throw outcome.listError;
  return { ...outcome, alreadyDone: false, busy: false, passDone: next.done };
}

/** The UTC calendar date, the run period of a daily job. */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** An async listing of fixed items (the retry phase of an account sweep, whose key is the item). */
export async function* listOf<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}

/** The function budget every account job shares (`maxDuration = 300`): no new account after
 *  240 s, in-flight work abandoned (and queued for retry) at 285 s, leaving time to save. */
export const BUDGET_MS = 240_000;
export const HARD_STOP_MS = 285_000;

/** Marks a job response from a sweep result: `incomplete` while the pass has work left, `busy`
 *  when another run held the pass. */
export function markPass(
  out: { incomplete?: true; busy?: true }, pass: SweepResult,
): void {
  if (pass.busy) out.busy = true;
  else if (!pass.passDone) out.incomplete = true;
}
