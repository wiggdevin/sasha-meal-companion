/**
 * W052 (B103): email-code, code-check and password sign-in pass an IP-keyed server limiter before
 * Supabase Auth sees them (lib/server/sign-in.ts). The limiter runs on the test memory store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits, setRateLimitStore } from "@/lib/server/ratelimit";

type AuthError = { message: string; status?: number } | null;
const auth = {
  signInWithOtp: vi.fn(async (_a: unknown) => ({ error: null as AuthError })),
  verifyOtp: vi.fn(async (_a: unknown) => ({ error: null as AuthError })),
  signInWithPassword: vi.fn(async (_a: unknown) => ({ error: null as AuthError })),
};

vi.mock("@/lib/supabase/server", async (load) => {
  const real = await load<typeof import("@/lib/supabase/server")>();
  return {
    ...real,
    createRequestClient: (req: Request) => {
      // A successful sign-in writes the session cookie into the request's jar.
      real.recordCookies(req, [{ name: "sb-test-auth-token", value: "session", options: { path: "/" } }]);
      return { auth };
    },
  };
});

const { handleOtp, handlePassword, handleVerify, otpFailure, signInLimitKey, SIGN_IN_LIMIT } =
  await import("@/lib/server/sign-in");
const { POST: otpRoute } = await import("@/app/api/auth/otp/route");
const { POST: verifyRoute } = await import("@/app/api/auth/verify/route");
const { POST: passwordRoute } = await import("@/app/api/auth/password/route");

function req(path: string, body: unknown, opts: { ip?: string; type?: string; xff?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": opts.type ?? "application/json" };
  if (opts.ip) headers["x-real-ip"] = opts.ip;
  if (opts.xff) headers["x-forwarded-for"] = opts.xff;
  return new Request(`https://app.example.com${path}`, {
    method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const otpBody = { email: "owner@example.com", create: false, next: "/today" };
const verifyBody = { email: "owner@example.com", code: "12345678" };
const passwordBody = { email: "owner@example.com", password: "correct horse" };

beforeEach(() => {
  setRateLimitStore(null);
  resetRateLimits();
  for (const fn of Object.values(auth)) fn.mockReset().mockResolvedValue({ error: null });
});

describe("the IP-keyed sign-in limiter", () => {
  it.each([
    ["otp", handleOtp, otpBody, auth.signInWithOtp],
    ["verify", handleVerify, verifyBody, auth.verifyOtp],
    ["password", handlePassword, passwordBody, auth.signInWithPassword],
  ] as const)("%s: the 11th call in the window answers 429 and never reaches Supabase", async (_n, handle, body, fn) => {
    for (let i = 0; i < SIGN_IN_LIMIT; i += 1) {
      expect((await handle(req("/x", body, { ip: "203.0.113.7" }))).status).toBe(200);
    }
    const res = await handle(req("/x", body, { ip: "203.0.113.7" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fn).toHaveBeenCalledTimes(SIGN_IN_LIMIT);
  });

  it("keys by x-real-ip only: another IP still signs in, a spoofed x-forwarded-for does not help", async () => {
    for (let i = 0; i < SIGN_IN_LIMIT; i += 1) await handlePassword(req("/x", passwordBody, { ip: "198.51.100.1" }));
    const spoofed = await handlePassword(req("/x", passwordBody, { ip: "198.51.100.1", xff: "192.0.2.99" }));
    expect(spoofed.status).toBe(429);
    expect((await handlePassword(req("/x", passwordBody, { ip: "198.51.100.2" }))).status).toBe(200);
  });

  it("never keys by email, so guessing at the owner's address cannot lock the owner out", () => {
    const key = signInLimitKey("password", req("/x", passwordBody, { ip: "203.0.113.7" }));
    expect(key).toBe("auth:password:203.0.113.7");
    expect(key).not.toContain("owner@example.com");
  });

  it("counts the three actions apart: wrong codes never block a password sign-in", async () => {
    auth.verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });
    for (let i = 0; i <= SIGN_IN_LIMIT; i += 1) await handleVerify(req("/x", verifyBody, { ip: "203.0.113.8" }));
    expect((await handleVerify(req("/x", verifyBody, { ip: "203.0.113.8" }))).status).toBe(429);
    expect((await handlePassword(req("/x", passwordBody, { ip: "203.0.113.8" }))).status).toBe(200);
  });

  it("counts a malformed call too, before the body is read", async () => {
    for (let i = 0; i < SIGN_IN_LIMIT; i += 1) {
      expect((await handleOtp(req("/x", "not json", { ip: "203.0.113.9" }))).status).toBe(400);
    }
    expect((await handleOtp(req("/x", otpBody, { ip: "203.0.113.9" }))).status).toBe(429);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the limiter cannot count", async () => {
    setRateLimitStore({ hit: async () => { throw new Error("db down"); } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handlePassword(req("/x", passwordBody, { ip: "203.0.113.10" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("rate_limit_unavailable");
    expect(res.headers.get("retry-after")).toBe("5");
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("the sign-in routes", () => {
  it("wire each route to its handler", async () => {
    expect((await otpRoute(req("/api/auth/otp", otpBody, { ip: "192.0.2.1" }))).status).toBe(200);
    expect((await verifyRoute(req("/api/auth/verify", verifyBody, { ip: "192.0.2.1" }))).status).toBe(200);
    expect((await passwordRoute(req("/api/auth/password", passwordBody, { ip: "192.0.2.1" }))).status).toBe(200);
  });

  it("set the session cookie on success and are never cached", async () => {
    const res = await handlePassword(req("/x", passwordBody, { ip: "192.0.2.2" }));
    expect(res.headers.get("set-cookie")).toContain("sb-test-auth-token=session");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuse a body that is not declared JSON (no cross-site form can sign a browser in)", async () => {
    const res = await handlePassword(req("/x", passwordBody, { ip: "192.0.2.3", type: "text/plain" }));
    expect(res.status).toBe(415);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("send the link to this origin's callback with a same-origin next only", async () => {
    await handleOtp(req("/x", { ...otpBody, next: "//evil.example" }, { ip: "192.0.2.4" }));
    await handleOtp(req("/x", { ...otpBody, create: true }, { ip: "192.0.2.4" }));
    const [first, second] = auth.signInWithOtp.mock.calls.map((c) => c[0] as {
      email: string; options: { emailRedirectTo: string; shouldCreateUser: boolean };
    });
    expect(first.options).toEqual({
      emailRedirectTo: "https://app.example.com/auth/callback?next=%2F", shouldCreateUser: false,
    });
    expect(second.options.emailRedirectTo).toBe("https://app.example.com/auth/callback?next=%2Ftoday");
    expect(second.options.shouldCreateUser).toBe(true);
  });

  it("answer a wrong password or code without echoing what was sent", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials", status: 400 } });
    const res = await handlePassword(req("/x", passwordBody, { ip: "192.0.2.5" }));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain("invalid_credentials");
    expect(text).not.toContain("correct horse");
    expect(res.headers.get("set-cookie")).toBeNull();
    auth.verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid", status: 403 } });
    const code = await handleVerify(req("/x", verifyBody, { ip: "192.0.2.5" }));
    expect(code.status).toBe(400);
    expect((await code.json()).error).toBe("invalid_code");
  });

  it("answer 502 when Supabase Auth cannot be reached", async () => {
    auth.signInWithPassword.mockRejectedValue(new TypeError("fetch failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handlePassword(req("/x", passwordBody, { ip: "192.0.2.6" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("auth_unavailable");
  });
});

describe("otpFailure keeps sign-in from telling known addresses apart", () => {
  it("answers an unknown address like a real send", () => {
    expect(otpFailure(false, { message: "Signups not allowed for otp", status: 422 })).toBeNull();
  });

  it("gives every other sign-in failure, a resend window included, one generic code", () => {
    expect(otpFailure(false, { message: "For security purposes, you can only request this after 40 seconds.", status: 429 }))
      .toBe("send_failed");
    expect(otpFailure(false, { message: "Error sending magic link email", status: 500 })).toBe("send_failed");
  });

  it("lets create mode say to wait", () => {
    expect(otpFailure(true, { message: "email rate limit exceeded", status: 429 })).toBe("auth_rate_limited");
    expect(otpFailure(true, { message: "Signups not allowed for otp", status: 422 })).toBe("send_failed");
  });
});
