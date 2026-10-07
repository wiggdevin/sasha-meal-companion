/**
 * Phase 18 W6: `/api/jobs/signal-purge` purges food signal events older than 180 days in bounded
 * passes through the S3 budget runner. The cron secret is checked before the shared rate limit
 * (scale S2). The SQL itself runs on the local stack in tests/migrations/food-signal-events-db.test.ts
 * and tests/tenancy/admin-jobs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ results: [] as { data: unknown; error: unknown }[], calls: 0 }));
const admin = {
  rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "food_signal_events_purge" || args.p_max !== 5000) throw new Error(`unexpected ${fn}`);
    mocked.calls += 1;
    return mocked.results.shift() ?? { data: 0, error: null };
  }),
};
vi.mock("@/lib/server/admin", () => ({ adminClient: () => admin }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));

const { enforceRateLimit } = await import("@/lib/server/ratelimit");
const { GET, POST } = await import("@/app/api/jobs/signal-purge/route");

const cron = (token?: string) => new Request("https://app.test/api/jobs/signal-purge",
  { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  mocked.results = [];
  mocked.calls = 0;
  vi.stubEnv("CRON_SECRET", "cron-secret");
});

describe("signal purge job", () => {
  it("checks the cron secret before it spends the shared limit", async () => {
    expect((await GET(cron("wrong"))).status).toBe(401);
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(mocked.calls).toBe(0);
    expect((await POST(cron("cron-secret"))).status).toBe(200);
    expect(enforceRateLimit).toHaveBeenCalledWith("jobs:signal-purge", 12, 3600);
  });

  it("runs passes until one deletes less than a full batch", async () => {
    mocked.results = [{ data: 5000, error: null }, { data: 5000, error: null }, { data: 12, error: null }];
    const res = await GET(cron("cron-secret"));
    expect(await res.json()).toEqual({ purged: 10_012, passes: 3 });
    expect(mocked.calls).toBe(3);
  });

  it("a failed first pass answers 500; a later failure keeps what was purged and says incomplete", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocked.results = [{ data: null, error: { code: "57014" } }];
    expect((await GET(cron("cron-secret"))).status).toBe(500);
    mocked.results = [{ data: 5000, error: null }, { data: null, error: { code: "57014" } }];
    const res = await GET(cron("cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 5000, passes: 2, incomplete: true });
    expect(JSON.stringify(error.mock.calls)).toContain("57014");
  });
});
