import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserClient } from "@supabase/ssr";
import { browserClient, callbackRedirectUrl, safePath } from "./client";

// Spy-through: real client behaviour stays intact, but we can also inspect
// what options browserClient handed to @supabase/ssr.
vi.mock("@supabase/ssr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/ssr")>();
  return { ...actual, createBrowserClient: vi.fn(actual.createBrowserClient) };
});

const mockedCreateBrowserClient = vi.mocked(createBrowserClient);

describe("browserClient", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Without an explicit cookieOptions, @supabase/ssr's own default carries no
  // `secure` key at all, so the session cookie's Set-Cookie never gets a
  // Secure attribute and would still be sent over a plain-HTTP request.
  it("marks the session cookie Secure so it is never sent over plain HTTP", () => {
    browserClient();
    const options = mockedCreateBrowserClient.mock.calls.at(-1)?.[2];
    expect(options?.cookieOptions).toMatchObject({ secure: true, sameSite: "lax" });
  });
});

describe("callbackRedirectUrl", () => {
  it("points the magic link at this origin's callback and carries next", () => {
    expect(callbackRedirectUrl("https://app.test", "/week")).toBe(
      "https://app.test/auth/callback?next=%2Fweek",
    );
  });

  it("drops an off-origin next before it ever reaches the email", () => {
    expect(callbackRedirectUrl("https://app.test", "//evil.test")).toBe(
      "https://app.test/auth/callback?next=%2F",
    );
  });
});

describe("safePath", () => {
  it("keeps an ordinary in-app path", () => {
    expect(safePath("/foods")).toBe("/foods");
    expect(safePath("/settings?tab=body")).toBe("/settings?tab=body");
  });

  it("refuses anything that could leave this origin", () => {
    expect(safePath(null)).toBe("/");
    expect(safePath("")).toBe("/");
    expect(safePath("https://evil.com")).toBe("/");
    expect(safePath("//evil.com")).toBe("/");
    expect(safePath("/\\evil.com")).toBe("/");
  });

  it("refuses control characters, which a browser strips out of a URL", () => {
    // "/\t/evil.com" passes a leading-"//" check, then the browser drops the
    // tab and resolves the rest as the protocol-relative "//evil.com". The
    // sign-in screen hands this value to window.location.replace, so the
    // check has to happen here.
    expect(safePath("/\t/evil.com")).toBe("/");
    expect(safePath("/\n/evil.com")).toBe("/");
    expect(safePath("/\r/evil.com")).toBe("/");
  });
});
