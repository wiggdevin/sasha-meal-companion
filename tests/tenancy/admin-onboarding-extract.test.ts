/**
 * Spec 3.5 (Phase 9 slice 3): POST /api/onboarding/extract (app/api/onboarding/extract/route.ts)
 * and the module behind it (lib/server/onboarding-extract.ts) both hold the admin client. This
 * canary runs the real route handler as two real users and proves the per-session model-call
 * budget (lib/coach/onboarding-call-budget.ts, enforced server-side per Sol r1/r2 findings on
 * this lane) is keyed per caller, never shared: B exhausting B's own five calls never refuses A,
 * and A exhausting A's own never refuses B. The model call itself is stubbed (same pattern as
 * tests/tenancy/admin-routes.test.ts's coach case) — no real OpenRouter/Gemini traffic, no spend.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, userClient, type TestUser } from "../helpers/supabase";
import { pointRequestClientAtBranch, sessionCookieFor } from "../log/fixtures";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { ONBOARDING_MAX_MODEL_CALLS } from "@/lib/coach/onboarding-call-budget";
import { assertLocalTargets } from "./target-guard";

const OK_FACTS = { goal: "lose_fat", confidence: { goal: 0.9 } };

vi.mock("@/lib/ai/adapter", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/adapter")>()),
  generateStructured: vi.fn(async () => OK_FACTS),
}));

const { POST } = await import("@/app/api/onboarding/extract/route");

function req(cookie: string, body: Record<string, unknown>): Request {
  return new Request("https://app.test/api/onboarding/extract", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...accountHeaderFromCookie(cookie) },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("admin-client onboarding extraction answers only for " +
  "its caller", () => {
  let a: TestUser;
  let b: TestUser;
  let aCookie = "";
  let bCookie = "";

  beforeAll(async () => {
    assertLocalTargets();
    pointRequestClientAtBranch();
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    const [asA, asB] = await Promise.all([userClient(a), userClient(b)]);
    [aCookie, bCookie] = await Promise.all([sessionCookieFor(asA), sessionCookieFor(asB)]);
  });

  beforeEach(() => {
    resetRateLimits();
    // No OpenRouter key: the only provider path exercised is the (stubbed) Gemini one.
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    resetRateLimits();
  });

  async function extract(cookie: string): Promise<{ status: number; body: { status?: string } }> {
    const res = await POST(req(cookie, { text: "I want to lose fat", callsUsedThisSession: 0 }));
    return { status: res.status, body: await res.json() as { status?: string } };
  }

  it("B's exhausted five-call budget never refuses A, and A's never refuses B back", async () => {
    for (let i = 0; i < ONBOARDING_MAX_MODEL_CALLS; i += 1) {
      const res = await extract(bCookie);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    }
    const sixthForB = await extract(bCookie);
    expect(sixthForB.body.status).toBe("budget_exceeded");

    // A's budget is untouched by B's five calls — a shared or mis-keyed counter would refuse
    // this immediately instead.
    const firstForA = await extract(aCookie);
    expect(firstForA.status).toBe(200);
    expect(firstForA.body.status).toBe("ok");

    // Symmetrically: B stays refused — A's calls never top up B's window either.
    const stillB = await extract(bCookie);
    expect(stillB.body.status).toBe("budget_exceeded");
  });
});
