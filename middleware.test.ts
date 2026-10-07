import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import middleware, { config } from "./middleware";

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

const mockedCreate = vi.mocked(createServerClient);

function clientWith(sub: string | null) {
  return {
    auth: {
      getClaims: vi.fn().mockResolvedValue({
        data: sub ? { claims: { sub } } : null,
        error: null,
      }),
    },
  } as never;
}

// Proxy for Next's matcher: the pattern is a plain negative-lookahead regex.
const matcher = new RegExp(`^${config.matcher[0]}$`);

describe("the matcher", () => {
  it("covers the page routes", () => {
    for (const p of ["/", "/week", "/foods", "/settings"]) expect(matcher.test(p)).toBe(true);
  });

  it("never touches api, auth, next internals, sign-in or static files", () => {
    for (const p of [
      "/api/mcp",
      "/api/sync",
      "/api/health",
      "/auth/callback",
      "/_next/static/chunk.js",
      "/sign-in",
      "/manifest.webmanifest",
      "/ground-v1.mp4",
      "/favicon.ico",
    ]) {
      expect(matcher.test(p)).toBe(false);
    }
  });
});

describe("middleware", () => {
  beforeEach(() => {
    mockedCreate.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects a signed-out page request to /sign-in with the path to return to", async () => {
    mockedCreate.mockReturnValue(clientWith(null));
    const res = await middleware(new NextRequest(new Request("https://app.test/week?d=2026-09-10")));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://app.test/sign-in?next=%2Fweek%3Fd%3D2026-09-10",
    );
  });

  it("passes a signed-in request through", async () => {
    mockedCreate.mockReturnValue(clientWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    const res = await middleware(new NextRequest(new Request("https://app.test/week")));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("carries a refreshed session cookie and its no-cache headers from the setAll callback onto the response", async () => {
    mockedCreate.mockImplementation((_url, _key, options) => {
      options.cookies.setAll?.(
        [{ name: "sb-refreshed", value: "new-token", options: { path: "/" } }],
        { "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0" },
      );
      return clientWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") as never;
    });
    const res = await middleware(new NextRequest(new Request("https://app.test/week")));
    expect(res.cookies.get("sb-refreshed")?.value).toBe("new-token");
    expect(res.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  });

  it("passes cookieOptions with Secure and SameSite=Lax so the session cookie is never sent over plain HTTP", async () => {
    mockedCreate.mockReturnValue(clientWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    await middleware(new NextRequest(new Request("https://app.test/week")));
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ cookieOptions: { secure: true, sameSite: "lax" } }),
    );
  });

  it("redirects to /sign-in instead of throwing when getClaims fails", async () => {
    mockedCreate.mockReturnValue({
      auth: { getClaims: vi.fn().mockRejectedValue(new Error("network down")) },
    } as never);
    const res = await middleware(new NextRequest(new Request("https://app.test/week")));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.test/sign-in?next=%2Fweek");
  });

  it("does nothing when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const res = await middleware(new NextRequest(new Request("https://app.test/week")));
    expect(res.status).toBe(200);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
