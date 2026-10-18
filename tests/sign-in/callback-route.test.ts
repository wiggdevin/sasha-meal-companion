/**
 * UI audit 2026-10-18 §9: the magic-link callback is a top-level navigation from an email tap, so
 * every failure sends the browser back to /sign-in with a code the page has a line for, never JSON.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { CALLBACK_ERRORS } from "@/app/auth/callback/errors";

const limit = vi.fn(async (..._a: unknown[]) => {});
const exchange = vi.fn(async (_code: string) => ({ error: null as unknown }));

vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => limit(...a) }));
vi.mock("@/lib/supabase/server", () => ({
  createRequestClient: () => ({ auth: { exchangeCodeForSession: exchange } }),
  applyCookies: (_req: Request, res: Response) => res,
}));

const { GET } = await import("@/app/auth/callback/route");

async function land(query: string): Promise<{ status: number; location: string | null }> {
  const res = await GET(new Request(`https://app.example.com/auth/callback${query}`));
  return { status: res.status, location: res.headers.get("location") };
}

function errorOf(location: string | null): string | null {
  return location === null ? null : new URL(location).searchParams.get("error");
}

describe("auth callback", () => {
  beforeEach(() => {
    limit.mockReset().mockResolvedValue(undefined);
    exchange.mockReset().mockResolvedValue({ error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sends a link with no code back with missing_code", async () => {
    const res = await land("");
    expect(res.status).toBe(302);
    expect(errorOf(res.location)).toBe("missing_code");
  });

  it("sends a refused exchange back with exchange_failed", async () => {
    exchange.mockResolvedValueOnce({ error: { message: "expired" } });
    expect(errorOf((await land("?code=abc")).location)).toBe("exchange_failed");
  });

  it("sends a rate-limited tap back with rate_limited", async () => {
    limit.mockRejectedValueOnce(new HttpError(429, "rate_limited"));
    expect(errorOf((await land("?code=abc")).location)).toBe("rate_limited");
  });

  it.each([
    ["the limiter store is down", () => limit.mockRejectedValueOnce(new HttpError(503, "rate_limit_unavailable"))],
    ["the exchange throws", () => exchange.mockRejectedValueOnce(new TypeError("fetch failed"))],
  ])("redirects instead of answering JSON when %s", async (_label, arrange) => {
    arrange();
    const res = await land("?code=abc");
    expect(res.status).toBe(302);
    expect(errorOf(res.location)).toBe("service_unavailable");
  });

  it("only ever sends codes the sign-in page has a line for", async () => {
    const seen = new Set<string | null>();
    seen.add(errorOf((await land("")).location));
    exchange.mockResolvedValueOnce({ error: { message: "x" } });
    seen.add(errorOf((await land("?code=a")).location));
    limit.mockRejectedValueOnce(new HttpError(429, "rate_limited"));
    seen.add(errorOf((await land("?code=a")).location));
    limit.mockRejectedValueOnce(new Error("boom"));
    seen.add(errorOf((await land("?code=a")).location));
    for (const code of seen) expect(Object.keys(CALLBACK_ERRORS)).toContain(code);
  });

  it("lands a good link on the next path", async () => {
    const res = await land("?code=abc&next=/foods");
    expect(res.location).toBe("https://app.example.com/foods");
  });
});
