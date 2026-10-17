/**
 * GET|POST /api/jobs/retention-purge — Vercel cron, daily (W044, scale step 4).
 *
 * Four tables only ever grew; migration 20270105100100 gives each a bounded purge with its own
 * retention window: client_timings and ai_calls 90 days (ai_calls never a row an unsettled spend
 * hold or a coach message still names), job_runs 60 days, recipe_plan_previews 7 days past expiry.
 * This job runs each table's purge in passes of at most PASS_MAX rows (oldest first, SKIP LOCKED),
 * one pass at a time through the S3 budget runner (lib/server/job-sweep.ts), until a pass deletes
 * less than a full batch or the run's budget ends. No cursor is kept: a purged row leaves the
 * listing, so the next run starts on exactly what is left. A table whose pass fails is left for
 * the next run and the job moves on to the next table.
 *
 * The answer names, per table, the rows purged and the row counts before and after (an exact
 * count; null when that read failed or took over 15 s, which never fails the job).
 *
 * The cron secret is checked before the rate limit, as every job (scale S2): the limit is a shared
 * counter an unauthenticated caller must not spend. The limit fails closed. Vercel's scheduler
 * issues GET, so both verbs share one handler.
 */

import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { BUDGET_MS, HARD_STOP_MS } from "@/lib/server/job-cursor";
import { runWithinBudget } from "@/lib/server/job-sweep";
import { cronSecretOk } from "@/lib/server/jobs";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** One pass is one short delete transaction. */
const PASS_MAX = 5_000;

/** Purged in this order; each table's function is `<table>_purge(p_max)`. */
const RETENTION_TABLES = [
  "client_timings", "ai_calls", "job_runs", "recipe_plan_previews",
] as const;
type Table = (typeof RETENTION_TABLES)[number];

type TableResult = { purged: number; passes: number; before: number | null;
  after: number | null; incomplete?: true };

/** A count that takes longer than this answers null: it is a report, never worth the run. */
const COUNT_MS = 15_000;

async function rowCount(admin: ReturnType<typeof adminClient>, table: Table): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), COUNT_MS); });
  const read = (async () => {
    try {
      const { count, error } = await admin.from(table).select("*", { count: "exact", head: true });
      return !error && typeof count === "number" ? count : null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (!cronSecretOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:retention-purge", 12, 3600);
    const admin = adminClient();
    const state = Object.fromEntries(RETENTION_TABLES.map((t) => [t,
      { purged: 0, passes: 0, more: true, failed: false }])) as Record<Table,
      { purged: number; passes: number; more: boolean; failed: boolean }>;
    const before = await Promise.all(RETENTION_TABLES.map((t) => rowCount(admin, t)));

    // The next pass is listed only after the last one finished with a full batch (concurrency 1).
    async function* passes(): AsyncGenerator<{ table: Table; n: number }> {
      for (const table of RETENTION_TABLES) {
        for (let n = 1; state[table].more; n += 1) yield { table, n };
      }
    }
    const outcome = await runWithinBudget({
      items: passes(), keyOf: (pass) => `${pass.table}:${pass.n}`, concurrency: 1,
      deadline: startedAt + BUDGET_MS, hardStop: startedAt + HARD_STOP_MS,
      work: async ({ table }) => {
        const fn = `${table}_purge`;
        state[table].passes += 1;
        const { data, error } = await admin.rpc(fn, { p_max: PASS_MAX });
        if (error) throw new HttpError(500, "internal", `${fn} failed`, { cause: error });
        const deleted = Number(data);
        if (!Number.isInteger(deleted) || deleted < 0) {
          throw new HttpError(500, "internal", `${fn} returned no count`);
        }
        state[table].purged += deleted;
        if (deleted < PASS_MAX) state[table].more = false;
      },
      onError: ({ table }, error) => {
        state[table].more = false;
        state[table].failed = true;
        console.error("retention purge pass failed", { table,
          code: (error as { cause?: { code?: string } })?.cause?.code ?? "unknown" });
      },
    });

    const after = await Promise.all(RETENTION_TABLES.map((t) => rowCount(admin, t)));
    const tables = {} as Record<Table, TableResult>;
    let purged = 0;
    RETENTION_TABLES.forEach((t, i) => {
      const s = state[t];
      purged += s.purged;
      tables[t] = { purged: s.purged, passes: s.passes, before: before[i], after: after[i],
        ...(s.more || s.failed ? { incomplete: true as const } : {}) };
    });
    if (outcome.failed > 0 && purged === 0) {
      throw new HttpError(500, "internal", "retention purge failed");
    }
    const incomplete = RETENTION_TABLES.some((t) => tables[t].incomplete);
    if (incomplete) console.warn("retention purge stopped early; the next run continues", { purged });
    return Response.json({ purged, passes: outcome.started, tables,
      ...(incomplete ? { incomplete: true } : {}) });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = run;
export const POST = run;
