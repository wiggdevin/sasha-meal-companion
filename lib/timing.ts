/**
 * Client latency marks — T0 §1 (docs/plans/2026-09-17-t0-speed-foundations.md).
 *
 * "They are slow" had no number behind it. This is the number: `mark(path, step)` stamps the
 * START of a hop, `measure(path, runId)` closes the run and turns the stamps into one row per
 * step, and the rows are batched into a single `POST /api/timings`. A row is a duration, never an
 * instant, so a client hop and the server's own `model`/`ground` ms (returned on the propose and
 * coach responses) are the same kind of number and sit in the same run.
 *
 * Nothing here may ever break the screen the user is on: a failed post is swallowed, and the buffered
 * rows are dropped rather than retried — telemetry that queues forever is a second bug, not a
 * measurement.
 */

export const TIMING_PATHS = ["barcode", "label", "photo", "voice", "text", "search-log",
  "meal-log", "coach-turn", "coach-action",
  // One path per Plan-sheet chip (lib/plan/chips.ts), so p50/p95 read per chip.
  "plan-chip:choose", "plan-chip:protein", "plan-chip:quick15", "plan-chip:light",
  "plan-chip:on_hand", "plan-chip:surprise"] as const;
export type TimingPath = (typeof TIMING_PATHS)[number];

/** The real hops, in the order a run walks them. `model` and `ground` are server-reported. */
export const TIMING_STEPS = ["decode", "lookup", "sign", "upload", "propose", "model",
  "ground", "confirm-shown", "commit", "card-visible",
  // `dictation` is the coach's spoken hop (T7 §1): the press on the mic to the final transcript.
  // It sits before `sent` because that is the order a spoken turn walks them. `attach` is the
  // corresponding start mark for a barcode or photo turn, whose body intentionally has no text.
  "dictation", "attach", "sent", "first-text", "reply-done", "action-applied", "action-failed",
  "action-undone",
  // `server` is a server-reported hop: POST /api/plan/ideas' own build time (`serverMs`).
  "server"] as const;
export type TimingStep = (typeof TIMING_STEPS)[number];

import { accountFetch, currentAccountOrNull } from "@/lib/device/account";

export const TIMINGS_URL = "/api/timings";

/** One post per run would be one request per tap; one post per 2 s is one request per burst. */
export const FLUSH_DELAY_MS = 2000;
/** Rows buffered before a flush is forced rather than scheduled. */
export const MAX_BATCH = 50;
/**
 * The route accepts 8 KB; a post is capped a little under that. Fifty rows is NOT reliably inside
 * it — a 120-character `device` on the longest path and step is enough to carry a batch over, and
 * the whole thing then comes back 413 (Grok pass 2, HIGH 4). So the batch is cut by serialized
 * bytes, not by a row count anyone has to keep in their head.
 */
export const MAX_BATCH_BYTES = 7 * 1024;

const DEVICE_MAX = 120;

/** The wire row, snake_case like every other body this app posts. */
export type TimingRow = {
  run_id: string; path: TimingPath; step: TimingStep; ms: number; at: string; device: string;
};

type Mark = { step: TimingStep; at: number };

/**
 * One run of one path. Marks are keyed by the run, not by the path: two runs of one path can
 * overlap — the user scans a second barcode while the first is still resolving — and sharing one bag
 * of marks made whichever closed first take both runs' steps under one id (Grok 4.6 MEDIUM 12).
 */
export type TimingRun = { readonly path: TimingPath; readonly key: string };

const open = new Map<string, Mark[]>();
/** Steps whose duration is already known — a server-reported hop, or one the caller timed. */
const known = new Map<string, Map<TimingStep, number>>();
/** The run a bare `mark(path, step)` continues: the last one begun on that path. */
const currentByPath = new Map<TimingPath, string>();
/**
 * The handle's identity is a local counter, not a uuid: a run that is never closed should cost
 * nothing, and the id the rows are stamped with is minted by `measure`, where it is actually used.
 */
let runSeq = 0;
let buffer: TimingRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** The flush currently running, so a later one queues behind it rather than racing it. */
let inFlight: Promise<void> | null = null;

function nowMs(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

/** Enough to tell a phone from a laptop in the p95 table, and nothing more. */
function device(): string {
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  return typeof ua === "string" ? ua.slice(0, DEVICE_MAX) : "unknown";
}

/**
 * Start a new run on `path` and make it the one a bare `mark(path, step)` continues. Callers with
 * one run in flight at a time never need this; a caller that can have two does.
 */
export function beginRun(path: TimingPath): TimingRun {
  runSeq += 1;
  const run = { path, key: `${path}#${runSeq}` };
  open.set(run.key, []);
  currentByPath.set(path, run.key);
  return run;
}

/** The run a bare call belongs to: the one already open on that path, or a fresh one. */
function runFor(path: TimingPath, run?: TimingRun): TimingRun {
  if (run) return run;
  const current = currentByPath.get(path);
  return current === undefined ? beginRun(path) : { path, key: current };
}

/**
 * Stamp the start of `step`, and hand back the run it belongs to so the rest of that run can name
 * it. A step marked twice in one run is re-timed in place — a retried upload is the same hop
 * taking longer, not a second hop.
 */
export function mark(path: TimingPath, step: TimingStep, run?: TimingRun): TimingRun {
  const mine = runFor(path, run);
  const marks = open.get(mine.key) ?? [];
  const existing = marks.find((m) => m.step === step);
  if (existing) existing.at = nowMs();
  else marks.push({ step, at: nowMs() });
  open.set(mine.key, marks);
  return mine;
}

/**
 * Record a step whose duration is already a number: the server's own `model` and `ground` ms off
 * the propose and coach responses, or a hop the caller timed itself. It joins the run that is
 * already open on `path`, so one tap still closes as one row set.
 */
export function markMs(
  path: TimingPath, step: TimingStep, ms: number, run?: TimingRun
): TimingRun {
  const mine = runFor(path, run);
  if (!Number.isFinite(ms)) return mine;
  const map = known.get(mine.key) ?? new Map<TimingStep, number>();
  map.set(step, Math.max(0, Math.round(ms)));
  known.set(mine.key, map);
  return mine;
}

function rowsFor(path: TimingPath, runId: string, marks: Mark[], endedAt: number): TimingRow[] {
  const at = new Date().toISOString();
  const dev = device();
  return marks.map((m, i) => ({
    run_id: runId, path, step: m.step,
    // A clock that goes backwards (a resumed tab, a coarse timer) reports 0, never a negative.
    ms: Math.max(0, Math.round((marks[i + 1]?.at ?? endedAt) - m.at)),
    at, device: dev,
  }));
}

/**
 * Close the run on `path` and buffer one row per marked step. `serverMs` carries the hops only
 * the server can time — `model` and `ground` — so one run is one row set even though two
 * machines measured it.
 */
export function measure(
  path: TimingPath,
  run: string | TimingRun,
  serverMs?: Partial<Record<TimingStep, number>>,
  opts: { fetchImpl?: typeof fetch } = {},
): TimingRow[] {
  // A caller with one run in flight passes the id to stamp it with; a caller with two passes the
  // handle, and the run closes under its own id.
  const closing = typeof run === "string" ? runFor(path) : run;
  const runId = typeof run === "string" ? run : newRunId();
  const marks = open.get(closing.key) ?? [];
  const fixed = known.get(closing.key) ?? new Map<TimingStep, number>();
  open.delete(closing.key);
  known.delete(closing.key);
  if (currentByPath.get(path) === closing.key) currentByPath.delete(path);
  const rows = rowsFor(path, runId, marks, nowMs());
  const at = rows[0]?.at ?? new Date().toISOString();
  const dev = rows[0]?.device ?? device();
  const extras: [string, number | undefined][] =
    [...fixed.entries(), ...Object.entries(serverMs ?? {})];
  for (const [step, ms] of extras) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) continue;
    if (rows.some((r) => r.step === step)) continue;
    rows.push({ run_id: runId, path, step: step as TimingStep, ms: Math.max(0, Math.round(ms)),
      at, device: dev });
  }
  if (rows.length === 0) return rows;
  buffer = [...buffer, ...rows];
  if (buffer.length >= MAX_BATCH) void flushTimings(opts);
  else schedule(opts);
  return rows;
}

function schedule(opts: { fetchImpl?: typeof fetch }): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushTimings(opts);
  }, FLUSH_DELAY_MS);
}

/** What is waiting to be posted. Exported for tests and for the flush itself. */
export function buffered(): TimingRow[] {
  return buffer;
}

/**
 * Post whatever is buffered. Best effort in both directions: it never throws, and it never
 * re-queues — the next run measures again.
 */
/**
 * Flushes run one after another, and awaiting one awaits everything queued before it.
 *
 * Without that, a flush already running — `measure` forces one the moment the buffer is full —
 * held the whole buffer while it posted its first body, and a caller's own flush found nothing
 * left and returned. Fifty rows were reported as sent and twenty-six arrived (panel round 7).
 */
export function flushTimings(opts: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  // `.catch` before `.then`: chaining on a rejected promise would skip the next flush's callback
  // entirely, and one failed post must not stop every later one.
  const run = (inFlight ?? Promise.resolve()).catch(() => {}).then(() => flushOnce(opts));
  const settled = run.catch(() => {}).finally(() => { if (inFlight === settled) inFlight = null; });
  inFlight = settled;
  return settled;
}

async function flushOnce(opts: { fetchImpl?: typeof fetch }): Promise<void> {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  // Taken synchronously, before any await: two flushes racing would otherwise both read the same
  // rows and post them twice.
  const rows = buffer;
  if (rows.length === 0) return;
  buffer = [];
  const doFetch = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) {
    console.warn(`client_timings has no fetch to post with; ${rows.length} rows dropped.`);
    return;
  }
  for (const batch of batches(rows)) await post(doFetch, batch);
}

/**
 * `rows` cut into as many posts as it takes, each serializing inside the route's limit, in order.
 * Nothing is left out: a measurement dropped for being the 27th of fifty is a measurement lost.
 *
 * The one exception is a row that alone will not fit — a device string wider than a whole body.
 * There is no body that could carry it, so it is said once and dropped.
 */
function batches(rows: TimingRow[]): TimingRow[][] {
  const out: TimingRow[][] = [];
  let current: TimingRow[] = [];
  for (const row of rows) {
    if (bodyBytes([row]) > MAX_BATCH_BYTES) {
      console.warn(`client_timings row too large to post (${bodyBytes([row])} bytes); dropped.`);
      continue;
    }
    const next = [...current, row];
    if (current.length > 0 && bodyBytes(next) > MAX_BATCH_BYTES) {
      out.push(current);
      current = [row];
    } else {
      current = next;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function bodyBytes(rows: TimingRow[]): number {
  return new TextEncoder().encode(JSON.stringify({ rows })).length;
}

async function post(doFetch: typeof fetch, rows: TimingRow[]): Promise<void> {
  // Filed under the account bound at send time (Phase 9 §0.5a). Rows carry no account data; with
  // no account bound they go the way a signed-out post always went: dropped.
  const h = currentAccountOrNull();
  if (h === null) return;
  try {
    // With a deadline: a post that never answers would otherwise hold the whole chain.
    const res = await accountFetch(h, TIMINGS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
      keepalive: true,
    }, { budget: "timings", fetchImpl: doFetch });
    // Said once, and the rows go either way: a measurement worth retrying is not worth the code
    // that would retry it, and a route quietly refusing every post should be visible in a log.
    if (!res.ok) console.warn(`client_timings post refused (${res.status}); ${rows.length} rows dropped.`);
  } catch {
    // Offline, signed out, or the route is off. The screen the user is on must not notice.
  }
}

/**
 * Forget an open run without measuring it: a capture sheet dismissed without saving, a coach
 * action that failed. Nothing is buffered, and the next run on that path starts clean instead of
 * inheriting marks nobody is going to close (Grok pass 2, LOW 15 and LOW 18).
 */
export function discardRun(path: TimingPath, run?: TimingRun): void {
  const key = run?.key ?? currentByPath.get(path);
  if (key === undefined) return;
  open.delete(key);
  known.delete(key);
  if (currentByPath.get(path) === key) currentByPath.delete(path);
}

/**
 * Forget ONE step of an open run, keeping the rest.
 *
 * The commit that ends in the outbox is the case: it has not happened yet — it happens when the
 * drain sends it — so there is no `commit` duration to file, while the card DID go up and §6
 * budgets exactly that (Grok pass 6, MEDIUM 5). Discarding the whole run threw the card away with
 * the commit.
 */
export function dropMark(path: TimingPath, step: TimingStep, run?: TimingRun): void {
  const key = run?.key ?? currentByPath.get(path);
  if (key === undefined) return;
  const marks = open.get(key);
  if (marks !== undefined) open.set(key, marks.filter((m) => m.step !== step));
  known.get(key)?.delete(step);
}

/** Drop every open run and every buffered row — tests, and a sign-out. */
export function resetTimings(): void {
  runSeq = 0;
  inFlight = null;
  open.clear();
  known.clear();
  currentByPath.clear();
  buffer = [];
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
}

// ------------------------------------------------------------------ reading

/** One bucket of the report: every run's `ms` for one (path, step), reduced. `p50` and `p95` are
 *  interpolated between ranks (see `percentile`), so neither is necessarily a run that happened. */
export type StepSummary = { path: string; step: string; p50: number; p95: number; n: number };

/**
 * LINEAR INTERPOLATION between ranks — the `PERCENTILE.INC` / NumPy definition. This function
 * interpolates; it does not pick a run. The number it returns is usually not one of the values.
 *
 * Worked, so the comment and the arithmetic cannot drift apart: over the ten runs
 * `[100, 133, 166, 200, 233, 266, 300, 333, 366, 400]`, p95 sits at position `0.95 × 9 = 8.55`,
 * between the ninth (366) and the tenth (400), and comes out at 384.7. p0 is 100 and p100 is 400.
 *
 * Why not pick a run: over the ten runs each budget in spec §6 is measured across, taking the
 * value at the 95th rank makes the p95 the slowest of the ten every single time, so the number
 * meant to describe a bad tap is the worst tap by construction.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const STEP_ORDER = new Map<string, number>(TIMING_STEPS.map((step, i) => [step, i]));
const PATH_ORDER = new Map<string, number>(TIMING_PATHS.map((path, i) => [path, i]));

/** Report order is the order a run walks its hops, never alphabetical. */
function byRunOrder(a: { path: string; step: string }, b: { path: string; step: string }): number {
  const byPath = (PATH_ORDER.get(a.path) ?? 99) - (PATH_ORDER.get(b.path) ?? 99);
  return byPath !== 0 ? byPath : (STEP_ORDER.get(a.step) ?? 99) - (STEP_ORDER.get(b.step) ?? 99);
}

/**
 * One bucket per (path, step), with its p50, p95 and n — what `pnpm timings` prints. It lives
 * here rather than in the script because the vocabulary it buckets by lives here: the script
 * reads rows and formats a table, and owns no statistics of its own.
 */
export function summarize(rows: { path: string; step: string; ms: number }[]): StepSummary[] {
  const groups = new Map<string, { path: string; step: string; ms: number[] }>();
  for (const row of rows) {
    const key = `${row.path}|${row.step}`;
    const group = groups.get(key) ?? { path: row.path, step: row.step, ms: [] };
    group.ms.push(row.ms);
    groups.set(key, group);
  }
  // Rounded: an interpolated percentile of whole milliseconds lands between two of them, and a
  // p95 of 95.49999999999999 in a report is noise pretending to be precision.
  return [...groups.values()].sort(byRunOrder).map((g) => ({
    path: g.path, step: g.step,
    p50: Math.round(percentile(g.ms, 50) as number),
    p95: Math.round(percentile(g.ms, 95) as number),
    n: g.ms.length,
  }));
}

/** A run id for one tap. Its only job is to tie a run's rows together. */
export function newRunId(): string {
  return crypto.randomUUID();
}
