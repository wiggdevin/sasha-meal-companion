import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobRunsTable } from "../helpers/job-doubles";
import { MODELS } from "@/lib/ai/adapter";
import { toMessageView } from "@/lib/coach/message-view";
import { writeWeeklyReview } from "@/lib/server/coach";
import { resetRateLimits } from "@/lib/server/ratelimit";

// The route resolves identity through adminClient() only after the bearer check, so the module is
// mocked and each test installs the fake the route needs.
vi.mock("@/lib/server/admin", () => ({ adminClient: vi.fn() }));

// Wrapped (not replaced): every existing `writeWeeklyReview` test below still runs the real
// function. Only the route-level lock-lifecycle tests further down override it, to force a
// failure without needing a real AI provider or a full coach-tables double.
vi.mock("@/lib/server/coach", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/coach")>("@/lib/server/coach");
  return { ...actual, writeWeeklyReview: vi.fn(actual.writeWeeklyReview) };
});
vi.mock("@/lib/server/expenditure", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/expenditure")>("@/lib/server/expenditure");
  return { ...actual, timeZoneFor: vi.fn(async () => "UTC") };
});

const { adminClient } = await import("@/lib/server/admin");
const { GET, POST } = await import("@/app/api/jobs/weekly-review/route");
const { weekStartOf } = await import("@/lib/server/jobs");

type Row = Record<string, unknown>;
type Write = { table: string; row: Row; op: "insert" | "update" };

const SECRET = "cron-s3cret";

/**
 * Minimal Supabase doubles. `job_runs` is Lane P's table and has not landed on this branch yet
 * (contracts §2), so the route fixture stands it up: a lock-conflicting insert answers with the
 * same unique-violation (23505) a real Postgres one raises.
 */
function routeAdmin(opts: { lockConflict: boolean }) {
  const from = (table: string) => {
    let pending: Row | null = null;
    let conflict = false;
    const settle = () => conflict
      ? { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }
      : { data: pending ? [pending] : table === "user_settings" ? [{ user_id: "u1" }] : [], error: null };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, is: () => chain, not: () => chain, gte: () => chain,
      order: () => chain, limit: () => chain, or: () => chain, match: () => chain,
      range: () => Promise.resolve(settle()),
      insert: (row: Row) => {
        pending = row;
        if (opts.lockConflict && table === "job_runs") conflict = true;
        return chain;
      },
      update: (row: Row) => {
        pending = row;
        // takeLock's reclaim update only matches a stale/finished row; this fixture models a
        // genuinely live "running" lock when `lockConflict` is set, so that update must match
        // nothing — otherwise a still-held lock would look reclaimable.
        if (opts.lockConflict && table === "job_runs") pending = null;
        return chain;
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    });
    return chain;
  };
  return { from, rpc: async () => ({ data: [], error: null }) };
}

/** An in-memory admin for the write path: inserts are recorded and read back by later selects. */
function memoryAdmin(initial?: { threads?: Row[] }) {
  const writes: Write[] = [];
  const tables: Record<string, Row[]> = {
    coach_threads: initial?.threads ?? [],
    coach_messages: [],
    ai_calls: [],
    job_runs: [],
  };
  let n = 0;
  const from = (table: string) => {
    let pending: Row | null = null;
    let failure: { code: string; message: string } | null = null;
    // eq/is filters apply to reads, so a per-week lookup only sees that week's rows.
    const filters: ((row: Row) => boolean)[] = [];
    const matched = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const settle = () => failure ? { data: null, error: failure }
      : { data: pending ? [pending] : matched(), error: null };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, in: () => chain, order: () => chain, limit: () => chain, gte: () => chain,
      eq: (col: string, val: unknown) => { filters.push((row) => row[col] === val); return chain; },
      is: (col: string, val: unknown) => {
        filters.push((row) => (row[col] ?? null) === val); return chain;
      },
      insert: (row: Row) => {
        const full: Row = { id: `row-${++n}`, ...row };
        if (table === "coach_messages" && full.review_week != null && (tables[table] ?? [])
          .some((r) => r.user_id === full.user_id && r.review_week === full.review_week)) {
          failure = { code: "23505", message: "coach_messages_one_weekly_review" };
          return chain;
        }
        pending = full;
        writes.push({ table, row: full, op: "insert" });
        tables[table] = [...(tables[table] ?? []), full];
        return chain;
      },
      update: (row: Row) => { writes.push({ table, row, op: "update" }); return chain; },
      maybeSingle: async () => ({ data: pending ?? matched()[0] ?? null, error: null }),
      single: async () => ({ data: pending ?? matched()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    });
    return chain;
  };
  return { db: { from, rpc: async () => ({ data: [], error: null }) }, writes, tables };
}

/**
 * A stateful `job_runs`-only double: unlike `routeAdmin` (which only asserts a single insert or
 * conflict), this actually records the row's status across the insert → release sequence, so a
 * test can check the lock is not left stuck at "running" after a thrown failure.
 */
function fakeJobRunsAdmin() {
  const jobRuns = jobRunsTable();
  const from = (table: string) => {
    if (table === "user_settings") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        not: () => chain,
        order: () => chain,
        range: async () => ({ data: [{ user_id: "u1", time_zone: null }], error: null }),
      };
      return chain;
    }
    if (table !== "job_runs") throw new Error(`fakeJobRunsAdmin only models job_runs, got "${table}"`);
    return jobRuns.from();
  };
  return { from, rows: jobRuns.rows };
}

const review = (wentWell: "logging" | "protein", focus: "none" | "meal_timing") =>
  vi.fn(async () => ({ wentWell, focus }));

describe("writeWeeklyReview", () => {
  it("writes into the one pinned weekly_review thread and creates it only once", async () => {
    const { db, writes } = memoryAdmin();
    const generate = review("logging", "none");
    const deps = {
      generate: generate as never,
      latestEstimate: async () => ({ status: "estimating", tdeeKcal: 2400 }),
    };

    const first = await writeWeeklyReview(db as never, "u1", "2026-09-07", deps);
    const second = await writeWeeklyReview(db as never, "u1", "2026-09-14", deps);

    const created = writes.filter((w) => w.table === "coach_threads" && w.op === "insert");
    expect(created).toHaveLength(1);
    expect(created[0].row).toMatchObject({ kind: "weekly_review", title: "Weekly review" });
    expect(first.threadId).toBe(second.threadId);
  });

  it("persists the review as an assistant message with model_id = MODELS.weeklyReview", async () => {
    const { db, writes } = memoryAdmin();
    const generate = review("protein", "meal_timing");
    const { messageId } = await writeWeeklyReview(db as never, "u1", "2026-09-07", {
      generate: generate as never,
      latestEstimate: async () => null,
    });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ purpose: "weeklyReview" }) }));
    const message = writes.find((w) => w.table === "coach_messages")!.row;
    expect(message).toMatchObject({
      id: messageId, role: "assistant",
      content: "Based on your logged week, protein was the strongest pattern. Next week, focus on meal timing.",
      model_id: MODELS.weeklyReview,
    });
    // C8: read back through the thread view, the stored model id labels the review as AI.
    expect(toMessageView(message as never).provenance).toEqual({ ai: true, source: "model" });
  });

  it("never persists free model prose that can name an unsafe food or medical action", async () => {
    const { db, writes } = memoryAdmin();
    const generate = vi.fn(async (args: { schema: { parse: (value: unknown) => unknown } }) =>
      args.schema.parse({
        kind: "final",
        text: "Eat yogurt next week and stop your medication.",
        wentWell: "protein",
        focus: "meal_timing",
      }));

    await writeWeeklyReview(db as never, "u1", "2026-09-07", {
      generate: generate as never,
      latestEstimate: async () => null,
    });

    const message = writes.find((w) => w.table === "coach_messages")!.row;
    expect(message.content).toBe(
      "Based on your logged week, protein was the strongest pattern. Next week, focus on meal timing.",
    );
    expect(message.content).not.toMatch(/yogurt|medication/i);
  });
});

describe("writeWeeklyReview: one review per local week, delivered unread (audit P2 #15)", () => {
  const deps = (generate: unknown = review("logging", "none")) => ({
    generate: generate as never, latestEstimate: async () => null,
  });

  it("stamps the message with its review week and marks the thread unread", async () => {
    const { db, writes } = memoryAdmin();
    const result = await writeWeeklyReview(db as never, "u1", "2026-10-05", deps());
    expect(result.duplicate).toBe(false);
    expect(writes.find((w) => w.table === "coach_messages")!.row)
      .toMatchObject({ user_id: "u1", review_week: "2026-10-05" });
    const stamp = writes.find((w) => w.table === "coach_threads" && w.op === "update")!.row;
    expect(typeof stamp.unread_at).toBe("string");
    expect(stamp.unread_at).toBe(stamp.last_message_at);
  });

  it("a second run for the same week calls no model and writes nothing", async () => {
    const { db, writes } = memoryAdmin();
    const first = await writeWeeklyReview(db as never, "u1", "2026-10-05", deps());
    const before = writes.length;
    const generate = review("protein", "meal_timing");
    const again = await writeWeeklyReview(db as never, "u1", "2026-10-05", deps(generate));
    expect(again).toEqual({ ...first, duplicate: true });
    expect(generate).not.toHaveBeenCalled();
    expect(writes).toHaveLength(before);
  });

  it("the next week is a new review in the same thread", async () => {
    const { db, writes } = memoryAdmin();
    const one = await writeWeeklyReview(db as never, "u1", "2026-10-05", deps());
    const two = await writeWeeklyReview(db as never, "u1", "2026-10-12", deps());
    expect(two.duplicate).toBe(false);
    expect(two.threadId).toBe(one.threadId);
    expect(writes.filter((w) => w.table === "coach_messages")).toHaveLength(2);
  });

  it("a racing insert refused by the unique index returns the winner, not an error", async () => {
    const { db, tables, writes } = memoryAdmin();
    // Another run's review lands after this run's pre-check, before its insert.
    const generate = vi.fn(async () => {
      tables.coach_messages.push({ id: "winner", thread_id: "row-1", user_id: "u1",
        review_week: "2026-10-05" });
      return { wentWell: "logging", focus: "none" };
    });
    const result = await writeWeeklyReview(db as never, "u1", "2026-10-05", deps(generate));
    expect(result).toEqual({ threadId: "row-1", messageId: "winner", duplicate: true });
    expect(writes.some((w) => w.table === "coach_threads" && w.op === "update")).toBe(false);
  });
});

describe("writeWeeklyReview: a reply in the review thread takes its seq (UI gap b)", () => {
  it("reads the next seq and delivers the review instead of failing the week", async () => {
    const { db, writes } = memoryAdmin();
    let refused = 0;
    const racing = { ...db, from: (table: string) => {
      const chain = db.from(table) as Record<string, unknown>;
      if (table !== "coach_messages") return chain;
      const insert = chain.insert as (row: Row) => unknown;
      chain.insert = (row: Row) => {
        if (refused > 0) return insert(row);
        refused += 1;
        // A user's reply landed at this seq first: the (thread_id, seq) unique refusal.
        return { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null,
          error: { code: "23505", message: "coach_messages_thread_seq" } }).then(resolve) };
      };
      return chain;
    } };
    const result = await writeWeeklyReview(racing as never, "u1", "2026-10-05", {
      generate: review("logging", "none") as never, latestEstimate: async () => null });
    expect(refused).toBe(1);
    expect(result.duplicate).toBe(false);
    expect(writes.filter((w) => w.table === "coach_messages")).toHaveLength(1);
    expect(writes.some((w) => w.table === "coach_threads" && w.op === "update")).toBe(true);
  });
});

describe("weekly review without a model (AI-integration audit: no fallback)", () => {
  it("still writes a review from the log alone when the model fails, with no model id", async () => {
    const { db, writes } = memoryAdmin();
    const generate = vi.fn(async () => { throw new Error("503 model overloaded"); });
    await writeWeeklyReview(db as never, "u1", "2026-09-07", {
      generate: generate as never, latestEstimate: async () => null,
    });
    const message = writes.find((w) => w.table === "coach_messages")!.row;
    expect(message.content).toMatch(/^Based on your logged week, /);
    expect(message).toMatchObject({ model_id: "", ai_call_id: null });
    // C8: the fallback is written from logged data alone, so it reads back as the app's, not AI.
    expect(toMessageView(message as never).provenance).toEqual({ ai: false, source: "app" });
  });

  it("states only what the log proves: logged days, never a macro pattern", async () => {
    const { fallbackReview } = await import("@/lib/coach/weekly-review");
    const day = (kcal: number) => ({ local_date: "2026-09-07", micro_coverage_pct: 0,
      nutrients: [{ code: "energy_kcal", amount: kcal }] }) as never;
    expect(fallbackReview([day(0), day(0), day(1800)]))
      .toEqual({ wentWell: "not_enough_data", focus: "logging" });
    expect(fallbackReview(Array.from({ length: 4 }, () => day(1900))))
      .toEqual({ wentWell: "logging", focus: "logging" });
    expect(fallbackReview(Array.from({ length: 7 }, () => day(1900))))
      .toEqual({ wentWell: "logging", focus: "none" });
  });
});

describe("weekStartOf", () => {
  it("uses UTC when an account has no saved timezone", () => {
    const cronFire = new Date("2026-09-14T01:30:00.000Z");
    expect(weekStartOf(cronFire)).toBe("2026-09-14");
  });
});

describe("POST /api/jobs/weekly-review", () => {
  const cron = (method: "GET" | "POST", token?: string) => new Request("https://app.test/api/jobs/weekly-review", {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("HEALTH_TZ", "");
    // Sunday 18:30 UTC: inside the review hour for an account with no saved zone.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T18:30:00.000Z"));
    vi.mocked(adminClient).mockReturnValue(routeAdmin({ lockConflict: false }) as never);
    vi.mocked(writeWeeklyReview).mockReset()
      .mockResolvedValue({ threadId: "thread-1", messageId: "message-1", duplicate: false });
  });
  afterEach(() => {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.mocked(adminClient).mockReset();
  });

  it.each([undefined, "not-the-secret"])("GET answers 401 on a missing or wrong CRON_SECRET (%s)", async (token) => {
    expect((await GET(cron("GET", token))).status).toBe(401);
    expect(writeWeeklyReview).not.toHaveBeenCalled();
  });

  it("GET runs the same review job and returns the same status as POST", async () => {
    const post = await POST(cron("POST", SECRET));
    const get = await GET(cron("GET", SECRET));
    expect(get.status).toBe(post.status);
    expect(get.status).toBe(200);
    expect(writeWeeklyReview).toHaveBeenCalledTimes(2);
  });

  it("answers 401 on a wrong CRON_SECRET and skips a user whose lock is already held", async () => {
    const unauthorized = await POST(cron("POST", "not-the-secret"));
    expect(unauthorized.status).toBe(401);

    vi.mocked(adminClient).mockReturnValue(routeAdmin({ lockConflict: true }) as never);
    const conflict = await POST(cron("POST", SECRET));
    expect(conflict.status).toBe(200);
    expect(await conflict.json()).toMatchObject({ ran: 0, skipped: 1, errors: 0 });
  });

  it("releases the job_runs lock as 'error' — not stuck at 'running' — when writeWeeklyReview " +
    "throws, so the same week can be retried (audit finding #15)", async () => {
    const { from, rows } = fakeJobRunsAdmin();
    vi.mocked(adminClient).mockReturnValue({ from } as never);
    vi.mocked(writeWeeklyReview).mockRejectedValueOnce(new Error("gemini 503 high demand"));

    const failed = await POST(cron("POST", SECRET));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ ran: 0, skipped: 0, errors: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "error" });
    expect(rows[0].finished_at).not.toBeNull();

    // A stuck "running" row would 409 every retry for the rest of the week; releasing it as
    // "error" lets the next attempt run, once, under the week's retry lock (S3 retry cap).
    vi.mocked(writeWeeklyReview).mockResolvedValueOnce(
      { threadId: "t1", messageId: "m1", duplicate: false });
    const retried = await POST(cron("POST", SECRET));
    expect(retried.status).toBe(200);
    expect(rows[0]).toMatchObject({ status: "error" });
    expect(rows[1]).toMatchObject({ run_key: `${rows[0].run_key}#retry`, status: "ok" });
  });
});
