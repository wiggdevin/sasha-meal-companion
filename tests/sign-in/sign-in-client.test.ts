/** W052: the sign-in screen's adapter posts JSON to the app's IP-limited routes and never throws. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { signInAuth } from "@/lib/sign-in-client";

function answer(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signInAuth", () => {
  it("posts each call as JSON to its own route", async () => {
    const fetchMock = answer(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const auth = signInAuth();
    expect(await auth.signInWithOtp({ email: "a@example.com", create: false, next: "/" })).toEqual({ error: null });
    expect(await auth.verifyOtp({ email: "a@example.com", token: "12345678", type: "email" })).toEqual({ error: null });
    expect(await auth.signInWithPassword({ email: "a@example.com", password: "pw" })).toEqual({ error: null });
    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(["/api/auth/otp", "/api/auth/verify", "/api/auth/password"]);
    for (const [, init] of calls) {
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    }
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ email: "a@example.com", code: "12345678" });
  });

  it("returns the server's error code", async () => {
    vi.stubGlobal("fetch", answer(429, { error: "rate_limited", message: "Too many requests." }));
    expect(await signInAuth().signInWithPassword({ email: "a@example.com", password: "pw" }))
      .toEqual({ error: { code: "rate_limited" } });
  });

  it("answers `failed` for a body that is not the app's error shape", async () => {
    vi.stubGlobal("fetch", answer(502, "<html>bad gateway</html>"));
    expect(await signInAuth().verifyOtp({ email: "a@example.com", token: "1", type: "email" }))
      .toEqual({ error: { code: "failed" } });
  });

  it("answers `offline` when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await signInAuth().signInWithOtp({ email: "a@example.com", create: true, next: "/" }))
      .toEqual({ error: { code: "offline" } });
  });
});
