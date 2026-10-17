/**
 * W049 — the 1,000-account job-sweep soak, run ONLY against the isolated local test stack
 * (scripts/test-stack.sh, API 56321). lib/server/job-sweep.ts and job-cursor.ts are used as they
 * are; this tool only drives them.
 *
 * 1. Seeds `--accounts` (default 1,000) accounts with `admin.createUser`, each tagged with the run
 *    (email `w049-soak-<run>-<n>@load.invalid`, `user_metadata.load_run`), plus the `user_settings`
 *    row every account job lists by.
 * 2. Harness pass: the real `sweep` (keysetRows over the real `accountIds` listing, runWithinBudget,
 *    the real `job_cursors` lease and resume) under job `w049-soak-<run>`, with deterministic
 *    injected failures on the seeded accounts: `--fail-rate` of them answer "retry" or throw on the
 *    first attempt, and a smaller share fail the second time too. Runs repeat until the pass is
 *    done; `--budget-ms` below the real 240 s forces the listing to resume across runs.
 * 3. Route passes (only with `--app`): the real cron handlers on a local app server that points at
 *    the test stack, `--routes estimate,weekly-proposal` (an allowlist: neither calls a model or a
 *    provider). The first fire is a POST (a fresh pass), the rest GETs (resume) until the response
 *    is neither `incomplete` nor `busy`. Before firing, a probe account proves the app accepts the
 *    test stack's sessions; after the first fire, the pass row must exist in the test stack's
 *    `job_cursors`, else the run stops (the app is on another database).
 * Records pass time, runs, retry depth and the retry queue per run. Deletes every seeded account and
 * the harness's `job_cursors` row in `finally`, then sweeps any leftover by email prefix. The
 * route jobs' own cursor rows stay; their next POST starts a fresh pass.
 *
 *   scripts/test-stack.sh start && set -a && . .supabase-test/.env && set +a
 *   pnpm exec tsx scripts/load/job-sweep-soak.ts --accounts 1000 --budget-ms 20000
 *   pnpm exec tsx scripts/load/job-sweep-soak.ts --app http://localhost:3523 --routes estimate
 *   pnpm exec tsx scripts/load/job-sweep-soak.ts --dry-run
 *
 * Results: docs/operations/load-soak-report.md.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BUDGET_MS, HARD_STOP_MS, listOf, sweep, utcDate } from "@/lib/server/job-cursor";
import { accountIds } from "@/lib/server/jobs";
import {
  assertLocalApp, assertLocalStack, cookieSessionClient, sweepLoadAccounts, type Env,
} from "./signup-load";

export const SOAK_EMAIL_PREFIX = "w049-soak-";
/** Cron handlers this tool may fire: account jobs that write only derived rows, no model calls. */
export const SOAK_ROUTES = ["estimate", "weekly-proposal"] as const;
const MAX_RUNS = 60;
const MAX_FIRES = 30;

export type SoakArgs = {
  accounts: number;
  failRate: number;
  budgetMs: number;
  concurrency: number;
  workMs: number;
  app: string | null;
  routes: string[];
  dryRun: boolean;
  out: string | null;
};

export function parseSoakArgs(argv: string[]): SoakArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number, min: number, max: number, whole = true): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || (whole && !Number.isInteger(n)) || n < min || n > max) {
      throw new Error(`${flag} must be a ${whole ? "whole " : ""}number from ${min} to ${max}`);
    }
    return n;
  };
  const routes = (value("--routes") ?? "estimate").split(",").map((r) => r.trim()).filter(Boolean);
  for (const route of routes) {
    if (!(SOAK_ROUTES as readonly string[]).includes(route)) {
      throw new Error(`--routes: ${route} is not one of ${SOAK_ROUTES.join(", ")}`);
    }
  }
  return {
    accounts: num("--accounts", 1_000, 1, 20_000),
    failRate: num("--fail-rate", 0.03, 0, 0.5, false),
    budgetMs: num("--budget-ms", BUDGET_MS, 1_000, BUDGET_MS),
    concurrency: num("--concurrency", 6, 1, 64),
    workMs: num("--work-ms", 5, 0, 10_000),
    app: value("--app") ?? null,
    routes,
    dryRun: argv.includes("--dry-run"),
    out: value("--out") ?? null,
  };
}

/** A stable number in [0, 1) for a key and a salt, so a soak's failures repeat run to run. */
function unit(key: string, salt: string): number {
  return createHash("sha256").update(`${salt}:${key}`).digest().readUInt32BE(0) / 2 ** 32;
}

/**
 * The injected outcome for one attempt at one account: about `failRate` of keys fail their first
 * attempt (half answer "retry" as a held lock does, half throw), a quarter of those fail their
 * second attempt too, and every key succeeds by its third. So the deepest retry is 2.
 */
export function injectedOutcome(key: string, attempt: number, failRate: number): "ok" | "retry" | "throw" {
  if (attempt === 1 && unit(key, "first") < failRate) {
    return unit(key, "kind") < 0.5 ? "retry" : "throw";
  }
  if (attempt === 2 && unit(key, "first") < failRate / 4) return "throw";
  return "ok";
}

export type RunRecord = { phase: "listing" | "retry"; ms: number; started: number; failed: number;
  retryQueued: number; complete: boolean; passDone: boolean };

export type HarnessReport = {
  job: string;
  accountsSeeded: number;
  listed: number;
  budgetMs: number;
  concurrency: number;
  failRate: number;
  passDone: boolean;
  passMs: number;
  runs: RunRecord[];
  /** Most attempts any account needed, minus one. */
  retryDepth: number;
  /** How many accounts needed 1, 2, 3 … attempts. */
  attemptsHistogram: Record<string, number>;
};

export type RouteReport = {
  route: string;
  fires: { method: string; status: number; ms: number; body: unknown }[];
  passDone: boolean;
  passMs: number;
  retryQueued: number | null;
  /** Why the pass stopped short: a non-OK answer (429 at the hourly cron limit, 503 with the
   *  job's flag off) or the fire limit. */
  error?: string;
};

export type SoakReport = {
  stack: string;
  seedMs: number;
  harness: HarnessReport;
  routes: RouteReport[];
  cleanup: { deleted: number; leftoversSwept: number; cursorRowsDeleted: number };
};

type Admin = Parameters<typeof sweep>[0];

/** Pushes each created id into `ids` as it lands, so cleanup sees a partial seed too. */
async function seed(admin: SupabaseClient, prefix: string, tag: string, n: number,
  ids: string[]): Promise<void> {
  for (let i = 0; i < n; i += 25) {
    const batch = await Promise.allSettled(Array.from({ length: Math.min(25, n - i) }, (_, k) =>
      admin.auth.admin.createUser({
        email: `${prefix}${i + k}@load.invalid`,
        password: randomBytes(18).toString("base64url"),
        email_confirm: true,
        user_metadata: { load_run: tag },
      })));
    let failure: string | null = null;
    for (const result of batch) {
      if (result.status === "fulfilled" && result.value.data.user && !result.value.error) {
        ids.push(result.value.data.user.id);
      } else {
        failure ??= result.status === "rejected" ? String(result.reason)
          : result.value.error?.message ?? "no user";
      }
    }
    if (failure) throw new Error(`createUser: ${failure}`);
  }
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await admin.from("user_settings")
      .upsert(ids.slice(i, i + 500).map((user_id) => ({ user_id, first_opened_at: now })),
        { onConflict: "user_id" });
    if (error) throw new Error(`user_settings: ${error.message}`);
  }
}

async function harnessPass(admin: SupabaseClient, args: SoakArgs, job: string,
  seeded: Set<string>): Promise<HarnessReport> {
  const attempts = new Map<string, number>();
  const runs: RunRecord[] = [];
  const period = utcDate();
  const hardStopMs = Math.round(args.budgetMs * (HARD_STOP_MS / BUDGET_MS));
  const listedKeys = new Set<string>();
  const passStart = performance.now();
  let passDone = false;
  const cursorRow = async () => {
    const { data, error } = await admin.from("job_cursors").select("listed, retry_keys")
      .eq("job", job).eq("period", period).maybeSingle();
    if (error) throw new Error(`job_cursors: ${error.message}`);
    return data as { listed: boolean; retry_keys: string[] } | null;
  };
  for (let n = 0; n < MAX_RUNS && !passDone; n += 1) {
    const phase = (await cursorRow())?.listed ? "retry" : "listing";
    const runStart = Date.now();
    const t0 = performance.now();
    const result = await sweep(admin as Admin, {
      job, period, list: (after) => accountIds(admin as Admin, after), byKeys: listOf,
      keyOf: (id) => id, concurrency: args.concurrency,
      deadline: runStart + args.budgetMs, hardStop: runStart + hardStopMs,
      work: async (id) => {
        listedKeys.add(id);
        if (args.workMs > 0) await new Promise((r) => setTimeout(r, args.workMs));
        if (!seeded.has(id)) return "skip";
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        const outcome = injectedOutcome(id, attempt, args.failRate);
        if (outcome === "throw") throw new Error("injected failure");
        return outcome;
      },
    });
    if (result.busy) throw new Error(`job ${job}: the pass is held by another run`);
    const row = await cursorRow();
    runs.push({
      phase,
      ms: Math.round(performance.now() - t0), started: result.started, failed: result.failed,
      retryQueued: row?.retry_keys.length ?? 0, complete: result.complete, passDone: result.passDone,
    });
    passDone = result.passDone;
  }
  const histogram: Record<string, number> = {};
  let depth = 0;
  for (const count of attempts.values()) {
    histogram[String(count)] = (histogram[String(count)] ?? 0) + 1;
    depth = Math.max(depth, count - 1);
  }
  return {
    job, accountsSeeded: seeded.size, listed: listedKeys.size, budgetMs: args.budgetMs,
    concurrency: args.concurrency, failRate: args.failRate, passDone,
    passMs: Math.round(performance.now() - passStart), runs, retryDepth: depth,
    attemptsHistogram: histogram,
  };
}

/** Proves the local app trusts the test stack's sessions before any cron route is fired. */
async function probeApp(admin: SupabaseClient, stack: URL, anon: string, app: URL,
  prefix: string): Promise<void> {
  const email = `${prefix}probe@load.invalid`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`probe createUser: ${error?.message ?? "no user"}`);
  try {
    const { client, cookie } = cookieSessionClient(stack.origin, anon);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`probe sign-in: ${signIn.error.message}`);
    const res = await fetch(new URL("/api/foods/world", app), {
      headers: { cookie: cookie(), "x-smc-account": data.user.id } });
    await res.arrayBuffer();
    if (res.status === 401) {
      throw new Error(`refusing: ${app.origin} rejects the test stack's sessions, so it is not `
        + "running against the test stack");
    }
    if (!res.ok) throw new Error(`refusing: the app probe answered ${res.status}, not 200`);
  } finally {
    await admin.auth.admin.deleteUser(data.user.id);
  }
}

async function routePass(admin: SupabaseClient, app: URL, route: string,
  cronSecret: string): Promise<RouteReport> {
  const fires: RouteReport["fires"] = [];
  const period = utcDate();
  const start = performance.now();
  const firstAt = new Date();
  let passDone = false;
  let restarted = false;
  let error: string | undefined;
  for (let n = 0; n < MAX_FIRES && !passDone; n += 1) {
    // POST (a fresh pass) until one is not answered busy, then GETs resume it.
    const method = restarted ? "GET" : "POST";
    const t0 = performance.now();
    const res = await fetch(new URL(`/api/jobs/${route}`, app), {
      method, headers: { authorization: `Bearer ${cronSecret}` } });
    const body = await res.json().catch(() => null) as
      { incomplete?: boolean; busy?: boolean; error?: unknown } | null;
    fires.push({ method, status: res.status, ms: Math.round(performance.now() - t0), body });
    if (!res.ok) {
      error = `HTTP ${res.status}${res.status === 429 ? " (hourly cron limit)" : ""}`;
      break;
    }
    if (body?.busy) { await new Promise((r) => setTimeout(r, 5_000)); continue; }
    if (!restarted) {
      const { data } = await admin.from("job_cursors").select("pass_started_at")
        .eq("job", route).eq("period", period).maybeSingle();
      const at = (data as { pass_started_at: string } | null)?.pass_started_at;
      if (!at || new Date(at).getTime() < firstAt.getTime() - 5_000) {
        throw new Error(`refusing to continue: ${route}'s pass did not appear in the test stack's `
          + "job_cursors, so the app server is on another database");
      }
      restarted = true;
    }
    passDone = !body?.incomplete;
  }
  if (!passDone && error === undefined) error = `not done after ${MAX_FIRES} fires`;
  const { data } = await admin.from("job_cursors").select("retry_keys")
    .eq("job", route).eq("period", period).maybeSingle();
  return { route, fires, passDone, passMs: Math.round(performance.now() - start),
    retryQueued: (data as { retry_keys: string[] } | null)?.retry_keys.length ?? null, error };
}

export async function runSoak(args: SoakArgs, env: Env): Promise<SoakReport> {
  const stack = assertLocalStack(env.SUPABASE_TEST_URL);
  const app = args.app === null ? null : assertLocalApp(args.app);
  const service = env.SUPABASE_TEST_SERVICE_ROLE_KEY;
  const anon = env.SUPABASE_TEST_ANON_KEY;
  if (!service) throw new Error("SUPABASE_TEST_SERVICE_ROLE_KEY must be set");
  if (app && (!anon || !env.CRON_SECRET)) {
    throw new Error("--app needs SUPABASE_TEST_ANON_KEY and CRON_SECRET (the app server's own)");
  }
  const admin = createClient(stack.origin, service, {
    auth: { persistSession: false, autoRefreshToken: false } });
  const tag = randomUUID().slice(0, 8);
  const prefix = `${SOAK_EMAIL_PREFIX}${tag}-`;
  const job = `w049-soak-${tag}`;
  const ids: string[] = [];
  const cleanup = { deleted: 0, leftoversSwept: 0, cursorRowsDeleted: 0 };
  try {
    const t0 = performance.now();
    await seed(admin, prefix, tag, args.accounts, ids);
    const seedMs = Math.round(performance.now() - t0);
    const harness = await harnessPass(admin, args, job, new Set(ids));
    const routes: RouteReport[] = [];
    if (app && anon && env.CRON_SECRET) {
      await probeApp(admin, stack, anon, app, prefix);
      for (const route of args.routes) routes.push(await routePass(admin, app, route, env.CRON_SECRET));
    }
    return { stack: stack.origin, seedMs, harness, routes, cleanup };
  } finally {
    // Each step on its own, so a cleanup failure never hides the run's own error.
    try {
      for (let i = 0; i < ids.length; i += 25) {
        const results = await Promise.all(ids.slice(i, i + 25)
          .map((id) => admin.auth.admin.deleteUser(id)));
        cleanup.deleted += results.filter((r) => !r.error).length;
      }
    } catch (e) {
      console.error("cleanup: deleting seeded accounts failed", e);
    }
    try {
      cleanup.leftoversSwept = await sweepLoadAccounts(admin, prefix);
    } catch (e) {
      console.error(`cleanup: sweep failed; delete accounts starting ${prefix} by hand`, e);
    }
    try {
      const { count } = await admin.from("job_cursors").delete({ count: "exact" }).eq("job", job);
      cleanup.cursorRowsDeleted = count ?? 0;
    } catch (e) {
      console.error(`cleanup: delete job_cursors row ${job} by hand`, e);
    }
  }
}

export function soakPlan(args: SoakArgs, env: Env): string[] {
  const stack = assertLocalStack(env.SUPABASE_TEST_URL);
  const app = args.app === null ? null : assertLocalApp(args.app);
  return [
    `stack ${stack.origin} (isolated test stack only)`,
    `seed ${args.accounts} accounts (${SOAK_EMAIL_PREFIX}<run>-<n>@load.invalid) with user_settings rows`,
    `harness sweep: budget ${args.budgetMs} ms, ${args.concurrency} in flight, `
      + `${Math.round(args.failRate * 100)} % injected first-attempt failures, until the pass is done`,
    app === null ? "no route passes (no --app)"
      : `route passes on ${app.origin}: ${args.routes.join(", ")} (probe first)`,
    "delete every seeded account and the harness job_cursors row afterwards",
  ];
}

async function main(argv: string[]): Promise<void> {
  const args = parseSoakArgs(argv);
  if (args.dryRun) {
    for (const line of soakPlan(args, process.env)) console.log(line);
    return;
  }
  const report = await runSoak(args, process.env);
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (args.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.out, `${text}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
