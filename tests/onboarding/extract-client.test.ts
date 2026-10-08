// Onboarding v2 P0 (2026-10-07 live QA): the typed client for POST /api/onboarding/extract, run
// end to end against the real route handler with only the session, the admin client and the
// model transport mocked. Proves: the route is registered, rate limited, safety-gated before any
// payload, and that the phone gets imperial echoes of metric facts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { CALL_REGISTRY } from "@/lib/ai/call-registry";
import { POST } from "@/app/api/onboarding/extract/route";
import {
  extractOnboardingFacts, mergeOnboardingFacts, onboardingFactsDisplay,
} from "@/lib/onboarding/extract-client";
import { ONBOARDING_MAX_MODEL_CALLS } from "@/lib/coach/onboarding-call-budget";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/ai/openrouter", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/openrouter")>()), generateOpenRouter: vi.fn() }));

const user = vi.mocked(requireUser);
const model = vi.mocked(generateOpenRouter);
const NOW = new Date("2026-10-07T20:00:00Z");
let n = 0;

/** A fetch that runs the real route handler in-process. */
const routeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
  POST(new Request(new URL(String(input), "https://app.test"), {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), "x-real-ip": "9.9.9.9" },
  })));

beforeEach(() => {
  resetRateLimits();
  n += 1;
  user.mockReset(); model.mockReset(); routeFetch.mockClear();
  user.mockResolvedValue({ userId: `extract-client-u${n}`, client: {} as never });
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_ATTESTED", "1");
  unbindAccount(); bindAccount(TEST_USER);
});
afterEach(() => { vi.unstubAllEnvs(); unbindAccount(); });

const opts = (extra = {}) => ({ now: NOW, online: true, fetchImpl: routeFetch as never, ...extra });

describe("extractOnboardingFacts", () => {
  it("registers both provider purposes for the route", () => {
    expect(CALL_REGISTRY["onboarding-extract"]).toMatchObject({ provider: "google" });
    expect(CALL_REGISTRY["onboarding-extract-openrouter"]).toMatchObject({ provider: "openrouter" });
  });

  it("reads the numbers of an imperial opener locally and echoes them in ft/in and lb", async () => {
    model.mockResolvedValue({ confidence: {} } as never);
    const out = await extractOnboardingFacts(
      "I'm a 24 year old female, 5'5, 150 lbs, want to lose fat, desk job, I don't cook much", opts());
    expect(out.status).toBe("ok");
    expect(out.facts.heightCm).toBeCloseTo(165.1, 1);
    expect(out.facts.weightKg).toBeCloseTo(68.04, 1);
    expect(out.facts.goal).toBe("lose_fat");
    expect(out.display).toMatchObject({ height: "5 ft 5 in", heightShort: "5′5″", weight: "150 lb", age: 24 });
    // The model never sees age or sex (privacy rule); whatever it was asked, the numbers are local.
    for (const [arg] of model.mock.calls) expect(JSON.stringify(arg)).not.toMatch(/female|\b24\b/);
  });

  it("calls the route only for what the fast path missed, and the model never replaces a stated number", async () => {
    model.mockResolvedValue({ goal: "gain_muscle", activity: "active", confidence: { goal: 0.95, activity: 0.9 } } as never);
    const out = await extractOnboardingFacts("165 cm and 68 kg, I'm on my feet all day at work and want to get stronger", opts());
    expect(routeFetch).toHaveBeenCalledOnce();
    expect(model).toHaveBeenCalledOnce();
    const payload = JSON.stringify(model.mock.calls[0][0]);
    expect(payload).not.toMatch(/female|\b24\b/);
    expect(out).toMatchObject({ status: "ok", modelCalled: true, callsUsed: 1 });
    expect(out.facts).toMatchObject({ heightCm: 165, weightKg: 68, goal: "gain_muscle", activity: "active" });
    expect(out.display).toMatchObject({ height: "5 ft 5 in", weight: "150 lb" });
  });

  it.each([
    "I'm allergic to peanuts and want to lose fat",
    "Melon makes my mouth tingle, otherwise 5'5 150 lb",
    "I have high blood pressure",
    "eggs upset my stomach",
  ])("keeps allergy and medical text off every path: %s", async (text) => {
    const out = await extractOnboardingFacts(text, opts());
    expect(out.status).toBe("blocked");
    expect(out.facts).toEqual({ confidence: {} });
    expect(routeFetch).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it("server-side, the route refuses blocked text before any payload even if a client skipped the check", async () => {
    const res = await routeFetch("/api/onboarding/extract", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "my doctor says no grapefruit", callsUsedThisSession: 0 }) });
    expect(await res.json()).toEqual({ status: "blocked", reason: "allergy_or_condition" });
    expect(model).not.toHaveBeenCalled();
  });

  it("stops at the session budget without a request", async () => {
    const out = await extractOnboardingFacts("want to get stronger", opts({ callsUsed: ONBOARDING_MAX_MODEL_CALLS }));
    expect(out.status).toBe("budget_exceeded");
    expect(routeFetch).not.toHaveBeenCalled();
  });

  it("the server budget holds even when the client under-reports its count", async () => {
    model.mockResolvedValue({ goal: "maintain", confidence: { goal: 0.9 } } as never);
    const statuses: string[] = [];
    for (let i = 0; i < ONBOARDING_MAX_MODEL_CALLS + 1; i += 1) {
      statuses.push((await extractOnboardingFacts("just want to feel good", opts({ callsUsed: 0 }))).status);
    }
    expect(statuses.slice(0, ONBOARDING_MAX_MODEL_CALLS).every((s) => s === "ok")).toBe(true);
    expect(statuses.at(-1)).toBe("budget_exceeded");
    expect(model).toHaveBeenCalledTimes(ONBOARDING_MAX_MODEL_CALLS);
  });

  it("is rate limited per account: the 11th request in a minute gets the fast path only", async () => {
    model.mockResolvedValue({ goal: "maintain", confidence: { goal: 0.9 } } as never);
    let last;
    for (let i = 0; i < 11; i += 1) last = await routeFetch("/api/onboarding/extract", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", callsUsedThisSession: 0 }) });
    expect(last!.status).toBe(429);
    const out = await extractOnboardingFacts("5'5 and want to get stronger", opts());
    expect(out.status).toBe("budget_exceeded");
    expect(out.facts.heightCm).toBeCloseTo(165.1, 1);
  });

  it("keeps the local reading when offline, on a failure or on a malformed answer", async () => {
    expect((await extractOnboardingFacts("5'5, want to get stronger", opts({ online: false }))).status).toBe("offline");
    model.mockRejectedValue(new Error("refused: nope"));
    const failed = await extractOnboardingFacts("5'5, want to get stronger", opts());
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.facts.heightCm).toBeCloseTo(165.1, 1);
    const garbage = vi.fn(async () => new Response(JSON.stringify({ status: "ok", facts: { goal: 7 } }), { status: 200 }));
    expect((await extractOnboardingFacts("5'5, want to get stronger", opts({ fetchImpl: garbage }))).status).toBe("failed");
  });
});

describe("mergeOnboardingFacts / onboardingFactsDisplay", () => {
  it("keeps the higher confidence per field, the first argument on a tie", () => {
    expect(mergeOnboardingFacts(
      { goal: "maintain", heightCm: 170, confidence: { goal: 0.6, heightCm: 0.9 } },
      { goal: "lose_fat", heightCm: 150, confidence: { goal: 0.9, heightCm: 0.9 } },
    )).toEqual({ goal: "lose_fat", heightCm: 170, confidence: { goal: 0.9, heightCm: 0.9 } });
  });

  it("shows metric only for an account that chose it", () => {
    expect(onboardingFactsDisplay({ heightCm: 165, weightKg: 68 }, { height: "cm", weight: "kg" }, NOW))
      .toEqual({ height: "165 cm", heightShort: "165 cm", weight: "68 kg" });
  });
});
