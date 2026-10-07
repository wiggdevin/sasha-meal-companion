/**
 * Spec 3.5 (Phase 9 slice 3), the barcode route: it writes the shared catalog through the admin
 * client (catalog-writer) and answers with a policy verdict from the caller's own rules. The route
 * runs for real against the local database with the Open Food Facts API stubbed. B scans first
 * (writing the catalog row) and puts the food on B's avoid list with a canary note; A then scans
 * the same barcode: A must get the shared product, with A's own verdict, never B's rules, and
 * every row B owns must be unchanged.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { pointRequestClientAtBranch, sessionCookieFor } from "../log/fixtures";
import { accountSnapshot, purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => undefined,
}));

const { POST: barcodePOST } = await import("@/app/api/foods/barcode/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

const CANARY = `canary-${crypto.randomUUID()}`;
// A valid EAN-13 (check digit 3) that no real product uses in the local database.
const GTIN = "4006381333931";
const REAL_FETCH = globalThis.fetch;

function scan(cookie: string): Request {
  return new Request("https://app.test/api/foods/barcode", { method: "POST",
    headers: { "content-type": "application/json", cookie, "x-real-ip": "10.0.0.5",
      ...accountHeaderFromCookie(cookie) },
    body: JSON.stringify({ gtin: GTIN }) });
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("the barcode route answers with the caller's rules only",
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
      vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("openfoodfacts.org")) {
          return new Response(JSON.stringify({ status: 1, product: {
            product_name: "Tenancy Oat Bar", brands: "Tenancy", ingredients_text: "oats, honey",
            allergens_tags: [], nutriments: { "energy-kcal_100g": 400, proteins_100g: 10 } } }),
          { status: 200 });
        }
        if (url.includes("api.nal.usda.gov")) return new Response("{}", { status: 404 });
        return REAL_FETCH(input, init);
      }) as typeof fetch);
    });

    beforeEach(() => {
      resetRateLimits();
      vi.stubEnv("NEXT_PUBLIC_FEATURE_SCAN", "1");
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await purge([a.id, b.id]);
    });

    it("A's scan of the product B avoids shows A's verdict, not B's", async () => {
      const forB = await barcodePOST(scan(bCookie));
      expect(forB.status).toBe(200);
      const bMatch = (await forB.json() as { match: { foodRefId: string } }).match;
      const cleared = await adminClient().from("constraint_profiles").delete().eq("user_id", b.id);
      expect(cleared.error).toBeNull();
      const rules = await adminClient().from("constraint_profiles").insert({ user_id: b.id,
        notes: CANARY, avoid_food_ref_ids: [bMatch.foodRefId] });
      expect(rules.error).toBeNull();

      const again = await (await barcodePOST(scan(bCookie))).json() as
        { match: { policy: { verdict: string } } };
      expect(again.match.policy.verdict).toBe("blocked");   // control: B's rule applies to B

      const before = accountSnapshot(b.id);
      const forA = await barcodePOST(scan(aCookie));
      expect(forA.status).toBe(200);
      const aText = await forA.text();
      const aMatch = (JSON.parse(aText) as { match: { foodRefId: string;
        policy: { verdict: string } } }).match;
      expect(aMatch.foodRefId).toBe(bMatch.foodRefId);   // the catalog row is shared
      expect(aMatch.policy.verdict).not.toBe("blocked");
      expect(aText).not.toContain(CANARY);
      expect(accountSnapshot(b.id)).toEqual(before);
    });
  });
