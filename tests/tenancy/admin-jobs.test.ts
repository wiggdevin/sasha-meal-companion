/**
 * Spec 3.5 (Phase 9 slice 3), cron jobs: "each write carries the user id of the row it read."
 * The real jobs run against the database through a recording wrapper around the real admin client.
 * Every write to an account-owned table (insert, upsert, update, delete, or an RPC with a user id
 * argument) must name one user: in the row, in a user_id filter, or in p_user_id.
 *
 * Each job is driven to its consequential write (review r2 finding 4): both users have 28 days of
 * history and an active target, so the estimator reaches `estimating` and the weekly job writes a
 * proposal; both have an Oura source with a valid sealed token and a stubbed Oura API, so the pull
 * applies samples. Each user's data carries a distinct value (intake, steps), and every written row
 * must carry its own user's value, never the other's.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, runSql, type TestUser,
} from "../helpers/supabase";
import manifest from "./table-ops.json";
import {
  ouraFetch, seedEatsUserFood, seedEstimatorHistory, seedIntake, seedOuraSource,
  uncoveredReviewDays,
} from "./job-fixtures";
import { weekStartOf } from "@/lib/server/jobs";
import { purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

type Write = { table: string; op: string; rows: Record<string, unknown>[];
  filters: Record<string, unknown> };
const writes: Write[] = [];

function chain<T extends object>(target: T, w: Write): T {
  return new Proxy(target, { get(t, p) {
    const v = Reflect.get(t, p) as unknown;
    if (typeof v !== "function") return v;
    if (p === "then" || p === "catch" || p === "finally") return v.bind(t);
    return (...args: unknown[]) => {
      if ((p === "eq" || p === "match") && args.length > 0) {
        Object.assign(w.filters, p === "eq" ? { [args[0] as string]: args[1] } : args[0]);
      }
      const r = (v as (...a: unknown[]) => unknown).apply(t, args);
      return r !== null && typeof r === "object" ? chain(r as object, w) : r;
    };
  } }) as T;
}

function recordFrom(table: string, qb: object): object {
  return new Proxy(qb, { get(t, p) {
    const v = Reflect.get(t, p) as unknown;
    if (typeof v !== "function") return v;
    if (!["insert", "upsert", "update", "delete"].includes(p as string)) return v.bind(t);
    return (...args: unknown[]) => {
      const rows = p === "delete" ? [] : [args[0]].flat() as Record<string, unknown>[];
      const w: Write = { table, op: p as string, rows, filters: {} };
      writes.push(w);
      return chain((v as (...a: unknown[]) => object).apply(t, args), w);
    };
  } });
}

function recording(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, { get(t, p) {
    if (p === "from") return (table: string) => recordFrom(table, t.from(table));
    if (p === "rpc") {
      return (name: string, args: Record<string, unknown> = {}, ...rest: unknown[]) => {
        writes.push({ table: `rpc:${name}`, op: "rpc", rows: [args], filters: {} });
        return (t.rpc as (...a: unknown[]) => unknown)(name, args, ...rest);
      };
    }
    const v = Reflect.get(t, p) as unknown;
    return typeof v === "function" ? v.bind(t) : v;
  } });
}

/** The weekly review's model prompt per user, so whose data it carries can be checked. */
const reviewPrompts = new Map<string, string>();
const candidateFilter = vi.hoisted(() => ({ ids: null as string[] | null }));
vi.mock("@/lib/server/jobs", async (orig) => {
  const real = await orig<typeof import("@/lib/server/jobs")>();
  return { ...real,
    accountIds: async function* (...args: Parameters<typeof real.accountIds>) {
      for await (const id of real.accountIds(...args)) {
        if (candidateFilter.ids === null || candidateFilter.ids.includes(id)) yield id;
      }
    },
    accountZones: async function* (...args: Parameters<typeof real.accountZones>) {
      for await (const u of real.accountZones(...args)) {
        if (candidateFilter.ids === null || candidateFilter.ids.includes(u.userId)) yield u;
      }
    },
  // The review's local Sunday-evening hour has its own tests (tests/jobs/weekly-review-local);
  // this suite checks write ownership whenever it runs, so every hour counts as due.
  inWeeklyReviewWindow: () => true, weeklyReviewDue: () => true };
});
vi.mock("@/lib/ai/adapter", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/adapter")>()),
  generateStructured: vi.fn(async (req: { userId: string;
    payload: { parts: readonly { text?: string }[] } }) => {
    reviewPrompts.set(req.userId, req.payload.parts.map((p) => p.text ?? "").join("\n"));
    return { wentWell: "logging", focus: "protein" };
  }),
}));

vi.mock("@/lib/server/admin", async (orig) => {
  const real = await orig<typeof import("@/lib/server/admin")>();
  return { ...real, adminClient: () => recording(real.adminClient()) };
});

const { POST: estimateJob } = await import("@/app/api/jobs/estimate/route");
const { POST: proposalJob } = await import("@/app/api/jobs/weekly-proposal/route");
const { POST: ouraJob } = await import("@/app/api/jobs/oura-pull/route");
const { POST: reviewJob } = await import("@/app/api/jobs/weekly-review/route");
const { POST: sweepJob } = await import("@/app/api/jobs/media-sweep/route");
const { POST: facetWarmJob } = await import("@/app/api/jobs/facet-warm/route");
const { POST: spendSweepJob } = await import("@/app/api/jobs/spend-sweep/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

const OWNED = new Set(Object.keys(manifest));
/** RPCs that write only server-side tables with no account owner: `claim_job_cursor` leases a job
 *  pass in `job_cursors` (no user_id; migration 20261217120300). `ai_spend_sweep` is
 *  deployment-wide maintenance: it reconciles expired holds against their own owners' rows. */
const SERVER_ONLY_RPCS = new Set(["rpc:claim_job_cursor", "rpc:ai_spend_sweep"]);
const SECRET = `tenancy-${crypto.randomUUID()}`;
const REAL_FETCH = globalThis.fetch;
// Canary values, distinct per user, so every derived row can be traced to whose data produced it.
const A_KCAL = 2000;
const B_KCAL = 2600;
const A_STEPS = 1111;
const B_STEPS = 424_242;

/** The user a write is scoped to, or null when it names none. */
function scopedUser(w: Write): string | null {
  if (w.op === "rpc") return (w.rows[0]?.p_user_id ?? w.rows[0]?.p_user ?? null) as string | null;
  const fromRows = [...new Set(w.rows.map((r) => r.user_id))];
  if (w.rows.length > 0 && fromRows.length === 1 && typeof fromRows[0] === "string") {
    return fromRows[0];
  }
  return (w.filters.user_id as string | undefined) ?? null;
}

function cron(): Request {
  return new Request("https://app.test/api/jobs", { method: "POST",
    headers: { authorization: `Bearer ${SECRET}` } });
}

async function rows(table: string, userId: string, columns = "*") {
  const { data, error } = await adminClient().from(table).select(columns).eq("user_id", userId);
  if (error) throw new Error(`read ${table}: ${error.message}`);
  return (data ?? []) as unknown as Record<string, unknown>[];
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("cron jobs write only for the user they read", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    assertLocalTargets();
    vi.stubEnv("HEALTH_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
    await seedEstimatorHistory(a.id, A_KCAL, 60);
    await seedEstimatorHistory(b.id, B_KCAL, 80);
    await seedOuraSource(a.id, "token-a");
    await seedOuraSource(b.id, "token-b");
    await seedEatsUserFood(a.id, "tenancy facet food A");
    await seedEatsUserFood(b.id, "tenancy facet food B");
    vi.stubGlobal("fetch", ouraFetch({ "token-a": A_STEPS, "token-b": B_STEPS }, REAL_FETCH));
  });

  beforeEach(async () => {
    writes.length = 0;
    resetRateLimits();
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("ESTIMATOR_ENABLED", "1");
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    // Each job takes a per-user lock for today; clear them so every case runs the job for real.
    for (const id of [a.id, b.id]) {
      const { error } = await adminClient().from("job_runs").delete().eq("user_id", id);
      if (error) throw new Error(error.message);
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await purge([a.id, b.id]);
  });

  /**
   * A write filtered only by a row's primary key (for example the weekly review stamping
   * `last_message_at` on the thread it just wrote into) names no user itself; it is scoped when
   * that row exists and belongs to one of the job's users, which is read back here.
   */
  async function ownerOfKeyedRow(w: Write): Promise<string | null> {
    // Scale S2: a spend settle names its reservation, which belongs to exactly one user.
    if (w.table === "rpc:ai_spend_settle" && typeof w.rows[0]?.p_reservation_id === "string") {
      const { data, error } = await adminClient().from("ai_spend_reservations").select("user_id")
        .eq("id", w.rows[0].p_reservation_id).maybeSingle();
      if (error) throw new Error(`read ai_spend_reservations: ${error.message}`);
      const owner = (data as { user_id?: string } | null)?.user_id ?? null;
      return owner === a.id || owner === b.id ? owner : null;
    }
    if (typeof w.filters.id !== "string") return null;
    const { data, error } = await adminClient().from(w.table).select("user_id")
      .eq("id", w.filters.id).maybeSingle();
    if (error) throw new Error(`read ${w.table}: ${error.message}`);
    const owner = (data as { user_id?: string } | null)?.user_id ?? null;
    return owner === a.id || owner === b.id ? owner : null;
  }

  async function assertEveryWriteScoped(): Promise<void> {
    const owned = writes.filter((w) => (w.op === "rpc" && !SERVER_ONLY_RPCS.has(w.table))
      || OWNED.has(w.table));
    const unscoped: Write[] = [];
    for (const w of owned) {
      if (scopedUser(w) === null && (await ownerOfKeyedRow(w)) === null) unscoped.push(w);
    }
    expect(unscoped).toEqual([]);
  }

  it("estimate: each user's estimate is written under that user, from that user's data", async () => {
    expect((await estimateJob(cron())).status).toBe(200);
    await assertEveryWriteScoped();
    const [forA, forB] = await Promise.all([rows("expenditure_estimates", a.id),
      rows("expenditure_estimates", b.id)]);
    expect(forA.map((r) => r.status)).toContain("estimating");
    expect(forB.map((r) => r.status)).toContain("estimating");
    // The intake averages trace each row to its own user's log: never the other user's.
    expect(forA.every((r) => Math.round(Number(r.intake_avg_kcal)) === A_KCAL)).toBe(true);
    expect(forB.every((r) => Math.round(Number(r.intake_avg_kcal)) === B_KCAL)).toBe(true);
  });

  it("weekly-proposal: each proposal belongs to its user and rests on that user's estimate",
    async () => {
      expect((await proposalJob(cron())).status).toBe(200);
      await assertEveryWriteScoped();
      for (const [user, kcal] of [[a, A_KCAL], [b, B_KCAL]] as const) {
        const proposals = await rows("target_proposals", user.id);
        expect(proposals).toHaveLength(1);
        const estimate = await adminClient().from("expenditure_estimates")
          .select("user_id, intake_avg_kcal").eq("id", proposals[0].based_on_estimate_id).single();
        expect(estimate.error).toBeNull();
        expect(estimate.data?.user_id).toBe(user.id);
        expect(Math.round(Number(estimate.data?.intake_avg_kcal))).toBe(kcal);
      }
    });

  it("oura-pull: each user's pulled steps land under that user only", async () => {
    const res = await ouraJob(cron());
    expect(res.status).toBe(200);
    const body = await res.json() as { results: { user_id: string; inserted: number }[] };
    for (const id of [a.id, b.id]) {
      expect(body.results.find((r) => r.user_id === id)?.inserted).toBeGreaterThan(0);
    }
    await assertEveryWriteScoped();
    const steps = async (id: string) => (await rows("health_samples", id, "type, value"))
      .filter((r) => r.type === "step_count").map((r) => Number(r.value));
    expect(await steps(a.id)).toEqual([A_STEPS]);
    expect(await steps(b.id)).toEqual([B_STEPS]);
  });

  it("media-sweep: tombstones only expired drafts, never another account's live object",
    async () => {
      const put = async (owner: string, createdAt: string) => {
        const key = `${owner}/${crypto.randomUUID()}.jpg`;
        const up = await adminClient().storage.from("media").upload(key,
          new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }),
          { contentType: "image/jpeg" });
        expect(up.error).toBeNull();
        const row = await adminClient().from("media_objects").insert({ path: `media/${key}`,
          user_id: owner, kind: "image", bytes: 3, created_at: createdAt });
        expect(row.error).toBeNull();
        return { key, path: `media/${key}` };
      };
      const expiredA = await put(a.id, "2020-01-01T00:00:00Z");
      const liveB = await put(b.id, new Date().toISOString());
      const before = await rows("media_objects", b.id);

      const res = await sweepJob(cron());
      expect(res.status).toBe(200);
      const tomb = await adminClient().from("media_objects").select("user_id, deleted_at")
        .eq("path", expiredA.path).single();
      expect(tomb.data?.user_id).toBe(a.id);
      expect(tomb.data?.deleted_at).not.toBeNull();
      expect(await rows("media_objects", b.id)).toEqual(before);
      const stillThere = await adminClient().storage.from("media").download(liveB.key);
      expect(stillThere.error).toBeNull();
      // Every tombstone the sweep wrote names a path it listed as expired, never B's live one.
      const tombstoned = writes.filter((w) => w.table === "media_objects" && w.op === "update")
        .map((w) => w.filters.path);
      expect(tombstoned).toContain(expiredA.path);
      expect(tombstoned).not.toContain(liveB.path);
    });

  it("weekly-review: each review is written under its user, from that user's week only",
    async () => {
      vi.stubEnv("COACH_ENABLED", "1");
      // Every day of the week the job reviews carries each user's intake, on any weekday.
      const weekStart = weekStartOf(new Date(), "UTC");
      for (const [user, kcal] of [[a, A_KCAL], [b, B_KCAL]] as const) {
        const ref = await adminClient().from("food_refs").select("id, user_foods!inner(user_id)")
          .eq("user_foods.user_id", user.id).limit(1).single();
        expect(ref.error).toBeNull();
        await seedIntake(user.id, String(ref.data?.id), kcal, uncoveredReviewDays(weekStart));
      }
      reviewPrompts.clear();
      // The real job discovers local users, then this fixture narrows only the
      // candidate list. Its writes, row ownership, and A/B data checks stay real.
      candidateFilter.ids = [a.id, b.id];
      let res: Response;
      try { res = await reviewJob(cron()); }
      finally { candidateFilter.ids = null; }
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ errors: 0 });
      await assertEveryWriteScoped();
      // Each prompt carries its own user's daily intake and never the other user's.
      expect(reviewPrompts.get(b.id)).toContain(String(B_KCAL));
      expect(reviewPrompts.get(a.id)).toContain(String(A_KCAL));
      expect(reviewPrompts.get(a.id)).not.toContain(String(B_KCAL));
      expect(reviewPrompts.get(b.id)).not.toContain(String(A_KCAL));
      // All seven reviewed days carry the user's own intake, so the check does not depend on
      // which weekday the run falls.
      const days = (text = "", kcal: number) => text.split(`"amount":${kcal}`).length - 1;
      expect(days(reviewPrompts.get(a.id), A_KCAL)).toBeGreaterThanOrEqual(7);
      expect(days(reviewPrompts.get(b.id), B_KCAL)).toBeGreaterThanOrEqual(7);
      for (const user of [a, b]) {
        const threads = await rows("coach_threads", user.id, "id, kind");
        const weekly = threads.filter((t) => t.kind === "weekly_review");
        expect(weekly).toHaveLength(1);
        const messages = await adminClient().from("coach_messages").select("user_id")
          .eq("thread_id", weekly[0].id);
        expect(messages.error).toBeNull();
        expect(messages.data).toEqual([{ user_id: user.id }]);
      }
    });

  it("facet warm: each user's own Eats food is read and locked under that user only", async () => {
    candidateFilter.ids = [a.id, b.id];
    let res: Response;
    try { res = await facetWarmJob(cron()); }
    finally { candidateFilter.ids = null; }
    expect(res.status).toBe(200);
    await assertEveryWriteScoped();
    const [aRuns, bRuns] = await Promise.all([
      rows("job_runs", a.id, "job, status"), rows("job_runs", b.id, "job, status"),
    ]);
    // Without a Jev key (CI) nothing warms, so the lock is the reclaimable "error"; with one it is
    // "ok". Either way it is written under its own user.
    const lock = { job: "facet-warm", status: expect.stringMatching(/^(?:ok|error)$/) };
    expect(aRuns).toContainEqual(lock);
    expect(bRuns).toContainEqual(lock);
  });

  it("spend-sweep: each expired hold is reconciled and charged under its own owner only (canary)",
    async () => {
      const day = "2041-03-03";
      const hold = async (owner: string, amount: number) => {
        const { data, error } = await adminClient().from("ai_spend_reservations").insert({
          user_id: owner, day, amount_usd: amount, expires_at: "2020-01-01T00:00:00Z",
        }).select("id").single();
        expect(error).toBeNull();
        return (data as { id: string }).id;
      };
      for (const owner of [a.id, b.id]) {
        await adminClient().from("ai_spend_user_days").delete().eq("user_id", owner).eq("day", day);
        const row = await adminClient().from("ai_spend_user_days").insert({ user_id: owner, day, spent_usd: 0 });
        expect(row.error).toBeNull();
      }
      runSql(`insert into public.ai_spend_global_days (day, shard, spent_usd)
        select '${day}', g, 0 from generate_series(0, 15) g on conflict do nothing`);
      const [holdA, holdB] = [await hold(a.id, 0.42), await hold(b.id, 0.17)];

      const res = await spendSweepJob(cron());
      expect(res.status).toBe(200);
      const spent = async (owner: string) => Number((await adminClient().from("ai_spend_user_days")
        .select("spent_usd").eq("user_id", owner).eq("day", day).single()).data?.spent_usd);
      expect(await spent(a.id)).toBeCloseTo(0.42, 6);
      expect(await spent(b.id)).toBeCloseTo(0.17, 6);
      const settled = await adminClient().from("ai_spend_reservations")
        .select("id, user_id, settled_by").in("id", [holdA, holdB]);
      expect(new Map((settled.data ?? []).map((r) => [r.id, [r.user_id, r.settled_by]])))
        .toEqual(new Map([[holdA, [a.id, "reconcile"]], [holdB, [b.id, "reconcile"]]]));
      runSql(`delete from public.ai_spend_reservations where day = '${day}';
        delete from public.ai_spend_user_days where day = '${day}';
        delete from public.ai_spend_global_days where day = '${day}'`);
    });
});
