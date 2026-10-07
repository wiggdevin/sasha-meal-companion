/**
 * Spec 3.5 (Phase 9 slice 3), the Eats facet warm route: it holds the admin client only to pass
 * it on to `warmEatsFacets`, charged to the caller `requireUser` resolves — never the body, never
 * a header a caller could spoof past the account-mismatch check. The deferred warm itself runs
 * through Next's `after()`, which this file no-ops exactly as tests/tenancy/admin-barcode.test.ts
 * does, so what is left to prove here is the route's own identity boundary: A's call answers under
 * A's own account, never B's, is rejected without a matching session, and the two callers' rate
 * limits cannot bleed into each other.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAS_BRANCH, HAS_DB, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { pointRequestClientAtBranch, sessionCookieFor } from "../log/fixtures";
import { purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => undefined,
}));

const { POST: warmPOST } = await import("@/app/api/foods/facets/warm/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

function req(cookie: string, account?: string): Request {
  const headers: Record<string, string> = { ...accountHeaderFromCookie(cookie) };
  if (account !== undefined) headers["x-smc-account"] = account;
  return new Request("https://app.test/api/foods/facets/warm",
    { method: "POST", headers: { cookie, ...headers } });
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("the Eats facet warm route answers only for its caller",
  () => {
    let a: TestUser;
    let b: TestUser;
    let aCookie = "";
    let bCookie = "";

    beforeAll(async () => {
      assertLocalTargets();
      pointRequestClientAtBranch();
      [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
      await purge([a.id, b.id]);
      [aCookie, bCookie] = await Promise.all([a, b].map(async (u) =>
        sessionCookieFor(await userClient(u))));
    });

    beforeEach(() => resetRateLimits());

    afterAll(async () => {
      vi.unstubAllGlobals();
      await purge([a.id, b.id]);
    });

    it("answers 202 with an empty body under the caller's own account", async () => {
      const res = await warmPOST(req(aCookie));
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    });

    it("401s with no session, and 409s on a mismatched x-smc-account header", async () => {
      const noSession = await warmPOST(new Request("https://app.test/api/foods/facets/warm",
        { method: "POST" }));
      expect(noSession.status).toBe(401);

      // A's own cookie, but the header says it is acting as B — the same canary-of-identity check
      // tests/tenancy/admin-routes.test.ts applies to every other account-data route.
      const spoofed = await warmPOST(req(aCookie, b.id));
      expect(spoofed.status).toBe(409);
    });

    it("rate-limits each caller on their own budget: A's cap never spends B's", async () => {
      for (let i = 0; i < 6; i += 1) expect((await warmPOST(req(aCookie))).status).toBe(202);
      expect((await warmPOST(req(aCookie))).status).toBe(429);
      // B has made no calls yet; A's exhausted cap must not be visible on B's own key.
      expect((await warmPOST(req(bCookie))).status).toBe(202);
    });
  });
