/**
 * T0 §5 — the five hot routes carry a function config, and `GET /api/warm` is the no-op the PWA
 * pings when it comes to the foreground so the first tap after opening does not pay a cold start.
 *
 * The route-segment config is asserted from the module's own exports, not from the source text:
 * that is what Next actually reads.
 */
import { describe, expect, it, vi } from "vitest";
import { pingWarm, WARM_ROUTES, WARM_URL } from "@/lib/warm-client";

const HOT_ROUTES = [
  "@/app/api/log/propose/route",
  "@/app/api/foods/barcode/route",
  "@/app/api/coach/route",
  "@/app/api/log/commit/route",
  "@/app/api/foods/search/route",
] as const;

vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

describe("the five hot routes", () => {
  it.each(HOT_ROUTES)("%s stays on the node runtime and pins a region and a duration", async (path) => {
    const mod = (await import(path)) as Record<string, unknown>;
    expect(mod.runtime).toBe("nodejs");
    expect(mod.maxDuration).toBeTypeOf("number");
    // us-west-1 is where the Supabase project lives (scripts/db-branch.sh), so sfo1 is the
    // Vercel region whose round trip to Postgres is shortest.
    expect(mod.preferredRegion).toEqual(["sfo1"]);
  });

  it("gives the coach the longest duration, because a turn is the longest hop", async () => {
    const coach = (await import("@/app/api/coach/route")) as { maxDuration: number };
    const commit = (await import("@/app/api/log/commit/route")) as { maxDuration: number };
    expect(coach.maxDuration).toBeGreaterThan(commit.maxDuration);
  });
});

describe("GET /api/warm", () => {
  it("holds one caller to a rate limit like every other route", async () => {
    const { resetRateLimits } = await import("@/lib/server/ratelimit");
    resetRateLimits();
    const { GET } = await import("@/app/api/warm/route");
    const req = new Request("https://a.test/api/warm", { headers: { "x-forwarded-for": "9.9.9.9" } });
    let last = 200;
    for (let i = 0; i < 130; i += 1) last = (await GET(req)).status;
    expect(last).toBe(429);
  });

  const warmRequest = () =>
    new Request("https://a.test/api/warm", { headers: { "x-forwarded-for": "1.2.3.4" } });

  it("answers 200 and touches nothing", async () => {
    const { resetRateLimits } = await import("@/lib/server/ratelimit");
    resetRateLimits();
    const { GET, runtime, preferredRegion } = await import("@/app/api/warm/route");
    const res = await GET(warmRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(runtime).toBe("nodejs");
    expect(preferredRegion).toEqual(["sfo1"]);
  });

  it("tells every cache to leave it alone, so a ping always reaches the function", async () => {
    const { resetRateLimits } = await import("@/lib/server/ratelimit");
    resetRateLimits();
    const { GET } = await import("@/app/api/warm/route");
    expect((await GET(warmRequest())).headers.get("cache-control")).toContain("no-store");
  });
});

describe("pingWarm", () => {
  it("touches the warm route and every hot route — each is its own function on Vercel", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await pingWarm({ fetchImpl });
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u));
    expect(urls).toContain(WARM_URL);
    for (const route of WARM_ROUTES) expect(urls).toContain(route);
    expect(WARM_ROUTES).toEqual([
      "/api/log/propose", "/api/foods/barcode", "/api/coach", "/api/log/commit", "/api/foods/search",
    ]);
  });

  it("pings keepalive, and so must send no signal at all", async () => {
    // The ping fires on the way back to the foreground, which on iOS is exactly when a signal
    // makes WebKit drop the request (Grok pass 4, HIGH 1).
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await pingWarm({ fetchImpl });
    for (const [, init] of (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      expect((init as RequestInit).keepalive).toBe(true);
      expect((init as RequestInit).signal ?? null).toBeNull();
    }
  });

  it("sends no body, and asks for nothing back", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await pingWarm({ fetchImpl });
    for (const [, init] of (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      expect((init as RequestInit).body).toBeUndefined();
    }
  });

  it("HEADs the hot routes — a warm ping must never run a real search", async () => {
    // Grok pass 2, MEDIUM 10: a GET to /api/foods/search is a search, with the catalog read and
    // the rate-limit budget that implies. HEAD loads the function and returns no body; a 405 from
    // a POST-only route still loaded it, which is all the ping is for.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 405 })) as unknown as typeof fetch;
    await pingWarm({ fetchImpl });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const route of WARM_ROUTES) {
      const call = calls.find(([u]) => String(u) === route);
      expect(call, `no ping for ${route}`).toBeDefined();
      expect((call?.[1] as RequestInit).method).toBe("HEAD");
    }
  });

  it("still GETs /api/warm itself, which exists to answer one", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await pingWarm({ fetchImpl });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const warm = calls.find(([u]) => String(u) === WARM_URL);
    expect((warm?.[1] as RequestInit).method).toBe("GET");
  });

  it("never throws, whatever any of them answers", async () => {
    const broken = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(pingWarm({ fetchImpl: broken })).resolves.toBeUndefined();

    const refusing = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    // A 401 or a 405 still loaded the function, which is the entire point of the ping.
    await expect(pingWarm({ fetchImpl: refusing })).resolves.toBeUndefined();
  });
});
