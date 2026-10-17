/**
 * W044 (scale step 4): `/api/jobs/retention-purge` runs the four bounded purges of migration
 * 20270105100100 in passes through the S3 budget runner and answers per-table purged counts with
 * the row counts before and after. The cron secret is checked before the shared rate limit (scale
 * S2). The SQL runs on the local stack in tests/migrations/retention-purge-db.test.ts and
 * tests/tenancy/admin-retention-purge.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const TABLES = ["client_timings", "ai_calls", "job_runs", "recipe_plan_previews"] as const;
const mocked = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: unknown }[]>,
  calls: [] as string[],
  counts: {} as Record<string, number[]>,
  countFails: new Set<string>(),
}));
const admin = {
  rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (!fn.endsWith("_purge") || args.p_max !== 5000) throw new Error(`unexpected ${fn}`);
    mocked.calls.push(fn);
    return mocked.results[fn]?.shift() ?? { data: 0, error: null };
  }),
  from: (table: string) => ({
    select: async (_cols: string, opts: { count: string; head: boolean }) => {
      if (opts.count !== "exact" || !opts.head) throw new Error("not a head count");
      if (mocked.countFails.has(table)) return { count: null, error: { code: "57014" } };
      return { count: mocked.counts[table]?.shift() ?? 0, error: null };
    },
  }),
};
vi.mock("@/lib/server/admin", () => ({ adminClient: () => admin }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));

const { enforceRateLimit } = await import("@/lib/server/ratelimit");
const { GET, POST } = await import("@/app/api/jobs/retention-purge/route");

const cron = (token?: string) => new Request("https://app.test/api/jobs/retention-purge",
  { headers: token ? { authorization: `Bearer ${token}` } : {} });
const full = { data: 5000, error: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocked.results = {};
  mocked.calls = [];
  mocked.counts = {};
  mocked.countFails = new Set();
  vi.stubEnv("CRON_SECRET", "cron-secret");
});

describe("retention purge job", () => {
  it("checks the cron secret before it spends the shared limit", async () => {
    expect((await GET(cron())).status).toBe(401);
    expect((await GET(cron("wrong"))).status).toBe(401);
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(mocked.calls).toEqual([]);
    expect((await POST(cron("cron-secret"))).status).toBe(200);
    expect(enforceRateLimit).toHaveBeenCalledWith("jobs:retention-purge", 12, 3600);
  });

  it("runs each table's passes until one deletes less than a full batch, with counts before and after", async () => {
    mocked.results = {
      client_timings_purge: [full, full, { data: 7, error: null }],
      ai_calls_purge: [{ data: 3, error: null }],
    };
    mocked.counts = { client_timings: [10_100, 93], ai_calls: [50, 47], job_runs: [5, 5],
      recipe_plan_previews: [0, 0] };
    const res = await GET(cron("cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 10_010, passes: 6, tables: {
      client_timings: { purged: 10_007, passes: 3, before: 10_100, after: 93 },
      ai_calls: { purged: 3, passes: 1, before: 50, after: 47 },
      job_runs: { purged: 0, passes: 1, before: 5, after: 5 },
      recipe_plan_previews: { purged: 0, passes: 1, before: 0, after: 0 },
    } });
    expect(mocked.calls).toEqual([...Array(3).fill("client_timings_purge"),
      ...TABLES.slice(1).map((t) => `${t}_purge`)]);
  });

  it("a failed table is left for the next run and the others still go; an unreadable count is null", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocked.results = { ai_calls_purge: [{ data: null, error: { code: "57014" } }],
      job_runs_purge: [{ data: 2, error: null }] };
    mocked.countFails.add("job_runs");
    const res = await GET(cron("cron-secret"));
    expect(res.status).toBe(200);
    const body = await res.json() as { purged: number; incomplete?: true;
      tables: Record<string, { purged: number; before: number | null; incomplete?: true }> };
    expect(body.purged).toBe(2);
    expect(body.incomplete).toBe(true);
    expect(body.tables.ai_calls).toMatchObject({ purged: 0, incomplete: true });
    expect(body.tables.job_runs).toMatchObject({ purged: 2, before: null });
    expect(body.tables.recipe_plan_previews.incomplete).toBeUndefined();
    expect(JSON.stringify(error.mock.calls)).toContain("57014");
  });

  it("answers 500 when passes failed and nothing was purged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocked.results = Object.fromEntries(TABLES.map((t) =>
      [`${t}_purge`, [{ data: null, error: { code: "42501" } }]]));
    expect((await GET(cron("cron-secret"))).status).toBe(500);
  });
});
