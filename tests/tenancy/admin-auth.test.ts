/**
 * Spec 3.5 (Phase 9 slice 3), the development sign-in route: it holds the admin client to mint a
 * magic link, so it must sign in only the configured development account, never an account a
 * request names, and must not exist in production. The route runs for real against the local
 * database; the session it sets is decoded to see whose it is.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HAS_BRANCH, ensureUser, type TestUser } from "../helpers/supabase";
import { pointRequestClientAtBranch } from "../log/fixtures";
import { assertLocalTargets } from "./target-guard";

const { GET: devSignIn } = await import("@/app/api/dev/sign-in/route");

/** The user id in the session cookie a response sets (the canary is whose account it is). */
function sessionUser(res: Response): string | null {
  const cookies = res.headers.getSetCookie().filter((c) => c.includes("-auth-token"))
    .map((c) => decodeURIComponent(c.split(";")[0].split("=").slice(1).join("=")))
    .sort().join("");
  if (!cookies.startsWith("base64-")) return null;
  const session = JSON.parse(Buffer.from(cookies.slice(7), "base64url").toString("utf8")) as
    { user?: { id?: string } };
  return session.user?.id ?? null;
}

describe.skipIf(!HAS_BRANCH)("development sign-in signs in only the configured account", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    assertLocalTargets();
    pointRequestClientAtBranch();
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a request naming B (canary) still gets A's session when A is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("DEV_SIGN_IN_EMAIL", a.email);
    const canary = encodeURIComponent(b.email);
    const res = await devSignIn(new Request(
      `https://app.test/api/dev/sign-in?email=${canary}&user=${b.id}`));
    expect(res.status).toBe(303);
    expect(sessionUser(res)).toBe(a.id);
  });

  it("does not exist in production or on Vercel", async () => {
    vi.stubEnv("DEV_SIGN_IN_EMAIL", a.email);
    for (const env of [{ NODE_ENV: "production" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" }]) {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("VERCEL_ENV", "");
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const res = await devSignIn(new Request("https://app.test/api/dev/sign-in"));
      expect(res.status).toBe(404);
      expect(sessionUser(res)).toBeNull();
    }
  });
});
