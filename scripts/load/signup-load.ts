/**
 * W049 — concurrent sign-up load test, run ONLY against the isolated local test stack
 * (scripts/test-stack.sh: API 56321, DB 56322, shadow 56320, project_id "mc-care-test").
 *
 * N sign-ups go through Supabase Auth's real `signUp` (the anon key, the same call the sign-in
 * screen's server route makes), at most `--concurrency` at a time. Each new account then calls the
 * app's first-run bootstrap route (`GET /api/foods/world` by default: the world and starter-seed
 * decision every phone reads before Today) with the session cookies the sign-up returned. The run
 * records p50/p95 per step (lib/timing `summarize`), the error rate, the rate-limited count apart
 * from errors, and the 1-minute load average, which it holds under `--max-load` (default 20) by
 * starting nothing new while it is at or above it. Every account it made is deleted in `finally`.
 *
 * Refuses any Supabase URL other than http://127.0.0.1:56321 (or localhost / [::1] on 56321), and
 * any app URL that is not on this machine. It never reads SUPABASE_URL, so a production env file
 * cannot leak in.
 *
 *   scripts/test-stack.sh start && set -a && . .supabase-test/.env && set +a
 *   pnpm dev --port 3523        # in another shell, pointed at the test stack (see the report)
 *   pnpm exec tsx scripts/load/signup-load.ts --n 200 --concurrency 20 --app http://localhost:3523
 *   pnpm exec tsx scripts/load/signup-load.ts --dry-run       # checks and plan only, no network
 *
 * Results: docs/operations/load-soak-report.md.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { summarize, type StepSummary } from "@/lib/timing";

/** The isolated test stack's API port (scripts/test-stack.sh). Nothing else is ever accepted. */
export const TEST_STACK_API_PORT = "56321";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** Every account this tool makes has this email prefix, so a cleanup sweep can find leftovers. */
export const LOAD_EMAIL_PREFIX = "w049-load-";
const LOAD_EMAIL_DOMAIN = "load.invalid";

/** Throws unless `raw` is the isolated test stack's API on this machine. */
export function assertLocalStack(raw: string | undefined): URL {
  if (!raw) throw new Error("SUPABASE_TEST_URL is not set; source .supabase-test/.env first");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`refusing: ${raw} is not a URL`); }
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname) || url.port !== TEST_STACK_API_PORT) {
    throw new Error(`refusing: ${url.origin} is not the isolated test stack `
      + `(http://127.0.0.1:${TEST_STACK_API_PORT}); this tool never runs anywhere else`);
  }
  return url;
}

/** Throws unless `raw` is an app server on this machine (never a deployment). */
export function assertLocalApp(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`refusing: ${raw} is not a URL`); }
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`refusing: ${url.origin} is not a local app server`);
  }
  return url;
}

export type SignupArgs = {
  n: number;
  concurrency: number;
  maxLoad: number;
  app: string | null;
  bootstrap: string;
  dryRun: boolean;
  out: string | null;
};

export function parseSignupArgs(argv: string[]): SignupArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const int = (flag: string, fallback: number, min: number, max: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${flag} must be a whole number from ${min} to ${max}`);
    }
    return n;
  };
  const bootstrap = value("--bootstrap") ?? "/api/foods/world";
  if (!bootstrap.startsWith("/api/")) throw new Error("--bootstrap must be an /api/ path");
  return {
    n: int("--n", 50, 1, 5_000),
    concurrency: int("--concurrency", 10, 1, 200),
    maxLoad: int("--max-load", 20, 1, 1_000),
    app: argv.includes("--no-bootstrap") ? null : value("--app") ?? "http://localhost:3000",
    bootstrap,
    dryRun: argv.includes("--dry-run"),
    out: value("--out") ?? null,
  };
}

export type SignupReport = {
  stack: string;
  app: string | null;
  bootstrap: string | null;
  requested: number;
  concurrency: number;
  signedUp: number;
  /** Auth answered 429: the auth rate limit, the run's ceiling, not a fault. */
  rateLimited: number;
  errors: number;
  /** errors / requested (rate-limited sign-ups are not errors). */
  errorRate: number;
  bootstrapErrors: number;
  steps: StepSummary[];
  peakLoad1m: number;
  maxLoad: number;
  wallMs: number;
  errorSamples: string[];
};

type Row = { path: string; step: string; ms: number };

/** An auth client that keeps its session in cookies, as the app's server routes read it, and
 *  hands them back as one `Cookie:` value for a request to the local app. */
export function cookieSessionClient(origin: string, anonKey: string): {
  client: SupabaseClient; cookie: () => string;
} {
  const jar = new Map<string, string>();
  const client = createServerClient(origin, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const c of cookies) { if (c.value) jar.set(c.name, c.value); else jar.delete(c.name); }
      },
    },
  });
  const cookie = () => [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
  return { client, cookie };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoad(max: number, peak: { value: number }): Promise<void> {
  for (;;) {
    const now = loadavg()[0];
    peak.value = Math.max(peak.value, now);
    if (now < max) return;
    await waitMs(1_000);
  }
}

async function deleteAccounts(admin: SupabaseClient, ids: string[]): Promise<number> {
  let failed = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const results = await Promise.all(ids.slice(i, i + 20)
      .map((id) => admin.auth.admin.deleteUser(id)));
    failed += results.filter((r) => r.error).length;
  }
  return failed;
}

/** Leftover accounts from an earlier run that died before its `finally` (by email prefix). */
export async function sweepLoadAccounts(admin: SupabaseClient, prefix: string): Promise<number> {
  const found: string[] = [];
  for (let page = 1; page <= 200; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1_000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    for (const user of data.users) if (user.email?.startsWith(prefix)) found.push(user.id);
    if (data.users.length < 1_000) break;
  }
  const failed = await deleteAccounts(admin, found);
  if (failed > 0) throw new Error(`could not delete ${failed} leftover load account(s)`);
  return found.length;
}

export async function runSignupLoad(args: SignupArgs, env: NodeJS.ProcessEnv): Promise<SignupReport> {
  const stack = assertLocalStack(env.SUPABASE_TEST_URL);
  const app = args.app === null ? null : assertLocalApp(args.app);
  const anon = env.SUPABASE_TEST_ANON_KEY;
  const service = env.SUPABASE_TEST_SERVICE_ROLE_KEY;
  if (!anon || !service) {
    throw new Error("SUPABASE_TEST_ANON_KEY and SUPABASE_TEST_SERVICE_ROLE_KEY must be set");
  }
  const admin = createClient(stack.origin, service, {
    auth: { persistSession: false, autoRefreshToken: false } });
  const tag = randomUUID().slice(0, 8);
  const prefix = `${LOAD_EMAIL_PREFIX}${tag}-`;
  const created: string[] = [];
  const rows: Row[] = [];
  const errorSamples: string[] = [];
  const peak = { value: loadavg()[0] };
  let signedUp = 0;
  let rateLimited = 0;
  let errors = 0;
  let bootstrapErrors = 0;
  const sample = (text: string) => { if (errorSamples.length < 10) errorSamples.push(text); };

  const one = async (i: number): Promise<void> => {
    const { client, cookie } = cookieSessionClient(stack.origin, anon);
    const t0 = performance.now();
    const { data, error } = await client.auth.signUp({
      email: `${prefix}${i}@${LOAD_EMAIL_DOMAIN}`,
      password: randomBytes(18).toString("base64url"),
    });
    const ms = performance.now() - t0;
    if (data?.user?.id) created.push(data.user.id);
    if (error) {
      if (error.status === 429) rateLimited += 1;
      else { errors += 1; sample(`signup ${error.status ?? "?"}: ${error.message}`); }
      return;
    }
    if (!data.session || !data.user) {
      errors += 1;
      sample("signup returned no session (email confirmations on?)");
      return;
    }
    signedUp += 1;
    rows.push({ path: "signup", step: "auth", ms });
    if (app === null) return;
    const t1 = performance.now();
    try {
      const res = await fetch(new URL(args.bootstrap, app), {
        headers: { cookie: cookie(), "x-smc-account": data.user.id },
      });
      await res.arrayBuffer();
      rows.push({ path: "signup", step: "bootstrap", ms: performance.now() - t1 });
      if (!res.ok) { bootstrapErrors += 1; sample(`bootstrap ${res.status}`); }
    } catch (e) {
      bootstrapErrors += 1;
      sample(`bootstrap: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const started = performance.now();
  try {
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < args.n) {
        await waitForLoad(args.maxLoad, peak);
        const i = next;
        next += 1;
        await one(i);
      }
    };
    const sampler = setInterval(() => { peak.value = Math.max(peak.value, loadavg()[0]); }, 1_000);
    try {
      await Promise.all(Array.from({ length: Math.min(args.concurrency, args.n) }, lane));
    } finally {
      clearInterval(sampler);
    }
  } finally {
    const failed = await deleteAccounts(admin, created);
    const leftovers = await sweepLoadAccounts(admin, prefix);
    if (failed > 0 && leftovers === 0) console.warn(`${failed} delete(s) failed, then swept`);
  }

  return {
    stack: stack.origin,
    app: app?.origin ?? null,
    bootstrap: app === null ? null : args.bootstrap,
    requested: args.n,
    concurrency: args.concurrency,
    signedUp,
    rateLimited,
    errors,
    errorRate: errors / args.n,
    bootstrapErrors,
    steps: summarize(rows),
    peakLoad1m: Math.round(peak.value * 100) / 100,
    maxLoad: args.maxLoad,
    wallMs: Math.round(performance.now() - started),
    errorSamples,
  };
}

/** What a run would do, with no network: the checks have passed by the time this prints. */
export function signupPlan(args: SignupArgs, env: NodeJS.ProcessEnv): string[] {
  const stack = assertLocalStack(env.SUPABASE_TEST_URL);
  const app = args.app === null ? null : assertLocalApp(args.app);
  return [
    `stack ${stack.origin} (isolated test stack only)`,
    `${args.n} sign-ups, ${args.concurrency} at a time, holding the 1-minute load under ${args.maxLoad}`,
    app === null ? "no bootstrap call" : `then GET ${new URL(args.bootstrap, app).href} per account`,
    `every account made (${LOAD_EMAIL_PREFIX}<run>-<n>@${LOAD_EMAIL_DOMAIN}) is deleted afterwards`,
  ];
}

async function main(argv: string[]): Promise<void> {
  const args = parseSignupArgs(argv);
  if (args.dryRun) {
    for (const line of signupPlan(args, process.env)) console.log(line);
    return;
  }
  const report = await runSignupLoad(args, process.env);
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
