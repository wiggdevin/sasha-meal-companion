/**
 * Scale S1: GET /api/health — no session, no user data, never cached; 200 when the database
 * answers, 503 when it fails or overruns its 2 s budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PingResult = { error: { code: string; message: string } | null };
const ping = vi.hoisted(() => ({
  impl: async (_signal: AbortSignal): Promise<PingResult> => ({ error: null }),
  tables: [] as string[],
}));

vi.mock("@/lib/server/admin", () => ({
  adminClient: () => ({
    from: (table: string) => {
      ping.tables.push(table);
      const query = {
        select: () => query,
        limit: () => query,
        abortSignal: (signal: AbortSignal) => ping.impl(signal),
      };
      return query;
    },
  }),
}));

const req = (ip = "203.0.113.7") => new Request("https://a.test/api/health", { headers: { "x-real-ip": ip } });

beforeEach(async () => {
  (await import("@/lib/server/ratelimit")).resetRateLimits();
  ping.impl = async () => ({ error: null });
  ping.tables = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("GET /api/health", () => {
  it("answers 200 with the commit when the database answers, cached only at the edge for 10 s", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=10");
    expect(await res.json()).toEqual({ ok: true, db: "ok", version: "abc123" });
    expect(ping.tables).toEqual(["catalog_versions"]);
  });

  it("names no version off Vercel", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    const { GET } = await import("@/app/api/health/route");
    expect(await (await GET(req())).json()).toMatchObject({ version: null });
  });

  it("answers 503 db down when the ping errors or throws", async () => {
    const { GET } = await import("@/app/api/health/route");
    ping.impl = async () => ({ error: { code: "PGRST000", message: "no connection" } });
    const errored = await GET(req());
    expect(errored.status).toBe(503);
    expect(errored.headers.get("cache-control")).toBe("no-store");
    expect(await errored.json()).toMatchObject({ ok: false, db: "down" });
    ping.impl = async () => { throw new Error("socket hang up"); };
    expect((await GET(req())).status).toBe(503);
  });

  it("gives up on a hung database at 2 s and aborts the query", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let aborted = false;
    ping.impl = (signal) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); });
    const { GET } = await import("@/app/api/health/route");
    const pending = GET(req());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(aborted).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("holds one address to a rate limit, keyed on x-real-ip", async () => {
    const { GET } = await import("@/app/api/health/route");
    let last = 200;
    for (let i = 0; i < 61; i += 1) last = (await GET(req("198.51.100.1"))).status;
    expect(last).toBe(429);
    expect((await GET(req("198.51.100.2"))).status).toBe(200);
  });

  it("needs no session and runs beside the database", async () => {
    const mod = await import("@/app/api/health/route");
    expect(mod.runtime).toBe("nodejs");
    expect(mod.preferredRegion).toEqual(["sfo1"]);
    expect(mod.maxDuration).toBeLessThanOrEqual(5);
  });
});
