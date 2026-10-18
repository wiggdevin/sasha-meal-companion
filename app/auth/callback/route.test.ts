import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestClient, recordCookies } from "@/lib/supabase/server";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/server")>();
  return { ...actual, createRequestClient: vi.fn() };
});

const mockedCreate = vi.mocked(createRequestClient);

function clientThat(result: { error: { message: string } | null }, onExchange?: (req: Request) => void) {
  return {
    auth: {
      exchangeCodeForSession: vi.fn().mockImplementation(async () => {
        onExchange?.(lastRequest!);
        return result;
      }),
    },
  } as never;
}

let lastRequest: Request | null = null;

function call(url: string): Promise<Response> {
  lastRequest = new Request(url);
  return GET(lastRequest);
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    mockedCreate.mockReset();
    resetRateLimits();
  });

  it("redirects to /sign-in?error=missing_code without a code", async () => {
    const res = await call("https://app.test/auth/callback");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/sign-in?error=missing_code");
  });

  it("302s to the same-origin next and carries the session cookies", async () => {
    mockedCreate.mockImplementation(() =>
      clientThat({ error: null }, (req) =>
        recordCookies(req, [{ name: "sb-auth", value: "tok", options: { path: "/" } }]),
      ),
    );
    const res = await call("https://app.test/auth/callback?code=abc&next=/week");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/week");
    expect(res.headers.get("set-cookie")).toBe("sb-auth=tok; Path=/");
  });

  it("refuses an off-origin next", async () => {
    mockedCreate.mockReturnValue(clientThat({ error: null }));
    const res = await call("https://app.test/auth/callback?code=abc&next=//evil.test/x");
    expect(res.headers.get("location")).toBe("https://app.test/");
  });

  it("302s to /sign-in?error= when the exchange fails", async () => {
    mockedCreate.mockReturnValue(clientThat({ error: { message: "expired" } }));
    const res = await call("https://app.test/auth/callback?code=abc&next=/week");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/sign-in?error=exchange_failed");
  });

  it("302s to /sign-in?error=service_unavailable, never JSON, when the exchange rejects", async () => {
    mockedCreate.mockReturnValue({
      auth: { exchangeCodeForSession: vi.fn().mockRejectedValue(new Error("network down")) },
    } as never);
    const res = await call("https://app.test/auth/callback?code=abc&next=/week");
    // UI audit 2026-10-18 §9: an email tap is a top-level navigation, so no failure shows JSON.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/sign-in?error=service_unavailable");
  });

  it("302s to /sign-in?error=service_unavailable, never JSON, when createRequestClient throws", async () => {
    mockedCreate.mockImplementation(() => {
      throw new Error("missing env");
    });
    const res = await call("https://app.test/auth/callback?code=abc&next=/week");
    // UI audit 2026-10-18 §9: an email tap is a top-level navigation, so no failure shows JSON.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/sign-in?error=service_unavailable");
  });

  it("does not share one rate-limit bucket across requests with no resolvable IP", async () => {
    for (let i = 0; i < 25; i += 1) {
      const res = await call("https://app.test/auth/callback");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://app.test/sign-in?error=missing_code");
    }
  });

  it("redirects to /sign-in?error=rate_limited instead of a raw JSON body once the limiter trips", async () => {
    const withIp = (url: string) => {
      lastRequest = new Request(url, { headers: { "x-real-ip": "203.0.113.5" } });
      return GET(lastRequest);
    };
    mockedCreate.mockReturnValue(clientThat({ error: null }));
    for (let i = 0; i < 20; i += 1) {
      await withIp("https://app.test/auth/callback?code=abc&next=/week");
    }
    const res = await withIp("https://app.test/auth/callback?code=abc&next=/week");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.test/sign-in?error=rate_limited");
  });
});
