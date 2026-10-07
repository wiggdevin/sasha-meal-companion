import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import {
  applyCookies,
  cookieJar,
  createRequestClient,
  parseCookieHeader,
  recordCookies,
  serializeCookie,
} from "./server";

// Spy-through: real cookie/client behaviour stays intact for the other tests
// in this file, but we can also inspect what options createRequestClient
// handed to @supabase/ssr.
vi.mock("@supabase/ssr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/ssr")>();
  return { ...actual, createServerClient: vi.fn(actual.createServerClient) };
});

const mockedCreateServerClient = vi.mocked(createServerClient);

describe("parseCookieHeader", () => {
  it("splits a Cookie header and decodes values", () => {
    expect(parseCookieHeader("sb-x=1; sb-y=two%20three")).toEqual([
      { name: "sb-x", value: "1" },
      { name: "sb-y", value: "two three" },
    ]);
  });

  it("is empty when there is no header", () => {
    expect(parseCookieHeader(null)).toEqual([]);
  });

  it("keeps the raw value instead of throwing on malformed percent-encoding", () => {
    // A bare "%" is invalid percent-encoding and the fully attacker-controlled
    // Cookie header can carry it from any non-browser client (e.g. curl).
    expect(parseCookieHeader("sb-x=%")).toEqual([{ name: "sb-x", value: "%" }]);
  });
});

describe("serializeCookie", () => {
  it("writes a Set-Cookie line with the options the client asked for", () => {
    const line = serializeCookie({
      name: "sb-auth",
      value: "a b",
      options: { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 3600 },
    });
    expect(line).toBe("sb-auth=a%20b; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax");
    expect(serializeCookie({ name: "a", value: "b" })).toBe("a=b; Path=/");
  });
});

describe("the per-request cookie jar", () => {
  it("copies recorded cookies onto a response, and nothing when empty", () => {
    const req = new Request("https://app.test/");
    expect(cookieJar(req)).toEqual([]);
    expect(applyCookies(req, new Response(null, { status: 200 })).headers.get("set-cookie")).toBeNull();
    recordCookies(req, [{ name: "sb-auth", value: "tok", options: { path: "/" } }]);
    const res = applyCookies(req, new Response(null, { status: 302 }));
    expect(res.headers.get("set-cookie")).toBe("sb-auth=tok; Path=/");
  });

  it("also copies the no-cache headers @supabase/ssr passes alongside a cookie write", () => {
    // Responses that set auth cookies must not be cached by a CDN or reverse
    // proxy, or one user's session cookie can be served to a different user.
    const req = new Request("https://app.test/");
    recordCookies(
      req,
      [{ name: "sb-auth", value: "tok", options: { path: "/" } }],
      { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0", Pragma: "no-cache" },
    );
    const res = applyCookies(req, new Response(null, { status: 302 }));
    expect(res.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    expect(res.headers.get("pragma")).toBe("no-cache");
  });
});

describe("createRequestClient", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Spec acceptance criterion 3: no route handler holds a module-level client.
  it("returns a distinct client for every request", () => {
    const a = createRequestClient(new Request("https://app.test/a"));
    const b = createRequestClient(new Request("https://app.test/b"));
    expect(a).not.toBe(b);
    expect(a.auth).not.toBe(b.auth);
  });

  it("refuses to build without the publishable key", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect(() => createRequestClient(new Request("https://app.test/"))).toThrow(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/,
    );
  });

  // Without an explicit cookieOptions, @supabase/ssr's own default carries no
  // `secure` key at all, so the session cookie's Set-Cookie never gets a
  // Secure attribute and would still be sent over a plain-HTTP request.
  it("marks the session cookie Secure so it is never sent over plain HTTP", () => {
    createRequestClient(new Request("https://app.test/"));
    const options = mockedCreateServerClient.mock.calls.at(-1)?.[2];
    expect(options?.cookieOptions).toMatchObject({ secure: true, sameSite: "lax" });
  });
});
