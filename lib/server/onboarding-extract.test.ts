/**
 * BRIEF.md §6 Lane 1 acceptance:
 *   - "integration test confirming the extraction prompt payload contains no flagged medical
 *     text when W5b matches" — here, the local safety guard's equivalent: a blocked utterance
 *     never reaches either provider's builder, so no payload is ever built, let alone sent.
 *   - "total model calls per session ≤5 in a dry run."
 *   - routes through "whatever provider is healthy": asks OpenRouter first, falls back to
 *     Gemini only on a provider failure, and never on a schema rejection or a refusal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runOnboardingExtraction, worthGeminiFallback,
} from "@/lib/server/onboarding-extract";
import { ProviderHttpError, SchemaRejection } from "@/lib/ai/adapter";
import { extractFastPath, redactAgeAndSex } from "@/lib/coach/onboarding-fast-path";
import { onboardingFactsSchema, onboardingModelFactsSchema } from "@/lib/coach/ui-blocks";
import { ONBOARDING_MAX_MODEL_CALLS } from "@/lib/coach/onboarding-call-budget";

const NOW = new Date("2026-10-06T12:00:00Z");

// The server-side budget (lib/server/onboarding-extract.ts) is enforced through the shared rate
// limiter, keyed per user, in-process for a test run (lib/server/ratelimit.ts's `memory` store
// under NODE_ENV=test) — a fixed userId would let one test's calls count against another's
// budget. Each test gets its own user id instead, so the budget tests below are the only ones
// that ever approach ONBOARDING_MAX_MODEL_CALLS.
let nextUserId = 0;
function ctx(): { userId: string; admin: never } {
  nextUserId += 1;
  return { userId: `onboarding-extract-test-u${nextUserId}`, admin: {} as never };
}

const OK_FACTS = onboardingFactsSchema.parse({ goal: "lose_fat", confidence: { goal: 0.9 } });

function readyOpenRouter(): void {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_ATTESTED", "1");
}
function readyGemini(): void {
  vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
  vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runOnboardingExtraction — the local safety guard blocks before any payload is built", () => {
  const MEDICAL_AND_BODY_STAT_TEXTS = [
    "I was diagnosed with Crohn's and I'm 34, 5'10, 165 lbs",
    "my doctor put me on mesalamine, I want to lose fat",
    "I'm allergic to peanuts, 28 years old, trying to build muscle",
    "I get rectal bleeding sometimes, otherwise 180 cm 80 kg",
    // Onboarding v2 G14: medicine names the first word list missed.
    "I'm on Ozempic and want to lose 30 lb, 41, 5'7\", 210 lb",
    "started Wegovy last month, female, 38, 190 pounds",
    "Mounjaro has me eating less, I want to keep my weight",
    "on semaglutide, trying to build muscle",
    "my weight loss shots make me less hungry",
  ];

  it.each(MEDICAL_AND_BODY_STAT_TEXTS)(
    "never calls either provider for: %s",
    async (text) => {
      const generateStructured = vi.fn();
      const generateOpenRouter = vi.fn();
      readyOpenRouter();
      readyGemini();
      const outcome = await runOnboardingExtraction(text, NOW,
        { ...ctx(), callsUsedThisSession: 0 }, { generateStructured: generateStructured as never, generateOpenRouter: generateOpenRouter as never });
      expect(outcome.status).toBe("blocked");
      expect(generateStructured).not.toHaveBeenCalled();
      expect(generateOpenRouter).not.toHaveBeenCalled();
    },
  );

  it("still runs the guard even when the caller forgot to check first (defense in depth)", async () => {
    const generateOpenRouter = vi.fn();
    const outcome = await runOnboardingExtraction(
      "my gastroenterologist said my colitis is flaring", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateOpenRouter: generateOpenRouter as never },
    );
    expect(outcome).toEqual({ status: "blocked", reason: "allergy_or_condition" });
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });

  it("clears ordinary body-stat and goal text with no health language at all", async () => {
    const generateOpenRouter = vi.fn(async () => OK_FACTS);
    readyOpenRouter();
    const outcome = await runOnboardingExtraction(
      "I'm 34, 5'10, 165 lbs, want to lose some fat", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateOpenRouter: generateOpenRouter as never },
    );
    expect(outcome).toEqual({ status: "ok", facts: OK_FACTS, provider: "openrouter" });
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    // The height/weight/goal content survives (not a health-language send), but the age is
    // gone — the standing privacy rule redacts it before any payload is built, regardless of
    // whether the text is otherwise perfectly safe to send (lib/coach/onboarding-fast-path.ts
    // redactAgeAndSex; see the dedicated "no demographics" describe block below for the rule's
    // own coverage).
    const call = generateOpenRouter.mock.calls[0] as unknown as [{ payload: { text: string } }];
    expect(call[0].payload.text).toContain("5'10, 165 lbs, want to lose some fat");
    expect(call[0].payload.text).not.toContain("34");
  });
});

describe("runOnboardingExtraction — no demographic field ever reaches a payload " +
  "(coordinator ruling, tests/ai/no-demographics-payload.test.ts)", () => {
  it("redacts age and sex from the text before building either provider's payload, while the " +
    "fast path (run separately, on the ORIGINAL text) still fills both", () => {
    const text = "I'm a 34 year old woman who wants to lose fat";
    const redacted = redactAgeAndSex(text);
    expect(redacted).not.toMatch(/\b34\b/);
    expect(redacted).not.toMatch(/\bwoman\b/);
    expect(redacted).toContain("wants to lose fat");

    const fastPath = extractFastPath(text, NOW);
    expect(fastPath.sex).toBe("female");
    expect(fastPath.birthYear).toBe(1992);
  });

  it("the text actually sent to OpenRouter carries no age or sex content", async () => {
    readyOpenRouter();
    const generateOpenRouter = vi.fn(async () => OK_FACTS);
    await runOnboardingExtraction("I'm a 34 year old woman who wants to lose fat", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateOpenRouter: generateOpenRouter as never });
    const call = generateOpenRouter.mock.calls[0] as unknown as [{ payload: { text: string } }];
    expect(call[0].payload.text).not.toMatch(/\b34\b/);
    expect(call[0].payload.text).not.toMatch(/\bwoman\b/);
    expect(call[0].payload.text).toContain("wants to lose fat");
  });

  it("the text actually sent to Gemini (the fallback leg) carries no age or sex content either", async () => {
    readyOpenRouter();
    readyGemini();
    const generateOpenRouter = vi.fn(async () => { throw new ProviderHttpError(503, "no capacity"); });
    const generateStructured = vi.fn(async () => OK_FACTS);
    await runOnboardingExtraction("I'm a 34 year old woman who wants to lose fat", NOW,
      { ...ctx(), callsUsedThisSession: 0 },
      { generateStructured: generateStructured as never, generateOpenRouter: generateOpenRouter as never });
    const call = generateStructured.mock.calls[0] as unknown as [{ payload: { parts: { text: string }[] } }];
    const sent = call[0].payload.parts.map((part) => part.text).join("\n");
    expect(sent).not.toMatch(/\b34\b/);
    expect(sent).not.toMatch(/\bwoman\b/);
    expect(sent).toContain("wants to lose fat");
  });

  it("the model's reply schema has no place for sex or birth year to land, even if asked", () => {
    const result = onboardingModelFactsSchema.safeParse({
      goal: "lose_fat", sex: "female", confidence: { goal: 0.9 },
    } as never);
    expect(result.success).toBe(false);
  });

  it("drops a demographic-shaped dietFlags entry a hallucinated reply still produced, and its " +
    "now-orphaned confidence entry with it", async () => {
    readyOpenRouter();
    const leaky = onboardingModelFactsSchema.parse({
      goal: "lose_fat", dietFlags: ["vegetarian", "34"],
      confidence: { goal: 0.9, dietFlags: 0.8 },
    });
    const generateOpenRouter = vi.fn(async () => leaky);
    const outcome = await runOnboardingExtraction("I want to lose fat, vegetarian", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateOpenRouter: generateOpenRouter as never });
    expect(outcome).toEqual({
      status: "ok",
      // "vegetarian" survives, so the list and its confidence entry both stay — only the
      // leaky "34" entry itself is dropped.
      facts: { goal: "lose_fat", dietFlags: ["vegetarian"], confidence: { goal: 0.9, dietFlags: 0.8 } },
      provider: "openrouter",
    });
  });

  it("drops dietFlags AND its confidence entry together when every flag was leaky", async () => {
    readyOpenRouter();
    const leaky = onboardingModelFactsSchema.parse({
      goal: "lose_fat", dietFlags: ["34", "woman"], confidence: { goal: 0.9, dietFlags: 0.8 },
    });
    const generateOpenRouter = vi.fn(async () => leaky);
    const outcome = await runOnboardingExtraction("I want to lose fat", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateOpenRouter: generateOpenRouter as never });
    expect(outcome).toEqual({
      status: "ok", facts: { goal: "lose_fat", confidence: { goal: 0.9 } }, provider: "openrouter",
    });
  });
});

describe("runOnboardingExtraction — provider selection asks whichever is healthy", () => {
  it("asks OpenRouter first when it is configured and attested", async () => {
    readyOpenRouter();
    const generateStructured = vi.fn();
    const generateOpenRouter = vi.fn(async () => OK_FACTS);
    const outcome = await runOnboardingExtraction("I want to lose fat", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateStructured: generateStructured as never, generateOpenRouter: generateOpenRouter as never });
    expect(outcome).toEqual({ status: "ok", facts: OK_FACTS, provider: "openrouter" });
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("falls back to Gemini on an OpenRouter provider failure (capacity, timeout, network)", async () => {
    readyOpenRouter();
    readyGemini();
    const generateOpenRouter = vi.fn(async () => { throw new ProviderHttpError(503, "no capacity"); });
    const generateStructured = vi.fn(async () => OK_FACTS);
    const outcome = await runOnboardingExtraction("I want to lose fat", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateStructured: generateStructured as never, generateOpenRouter: generateOpenRouter as never });
    expect(outcome).toEqual({ status: "ok", facts: OK_FACTS, provider: "google" });
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("charges the budget twice for one request that falls back (Sol r2 BLOCK)", async () => {
    readyOpenRouter();
    readyGemini();
    const user = ctx();
    const generateOpenRouter = vi.fn(async () => { throw new ProviderHttpError(503, "no capacity"); });
    const generateStructured = vi.fn(async () => OK_FACTS);
    const deps = { generateStructured: generateStructured as never, generateOpenRouter: generateOpenRouter as never };
    const outcomes: string[] = [];
    // Each request below is a fallback (OpenRouter always fails with a capacity error), so each
    // spends 2 of the 5 slots: 3 requests would need 6, one more than the budget allows.
    for (let i = 0; i < 3; i += 1) {
      const outcome = await runOnboardingExtraction("I want to lose fat", NOW,
        { ...user, callsUsedThisSession: 0 }, deps);
      outcomes.push(outcome.status);
    }
    expect(outcomes).toEqual(["ok", "ok", "budget_exceeded"]);
    // The 3rd request's OpenRouter attempt still happens (slot 5 of 5 is still available); only
    // its Gemini fallback attempt is refused (that would be slot 6).
    expect(generateOpenRouter).toHaveBeenCalledTimes(3);
    expect(generateStructured).toHaveBeenCalledTimes(2);
  });

  it("never falls back on a schema rejection — that is ours, not the provider's", async () => {
    readyOpenRouter();
    const generateOpenRouter = vi.fn(async () => { throw new SchemaRejection("bad shape"); });
    const generateStructured = vi.fn(async () => OK_FACTS);
    const outcome = await runOnboardingExtraction("I want to lose fat", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateStructured: generateStructured as never, generateOpenRouter: generateOpenRouter as never });
    expect(outcome).toEqual({ status: "failed" });
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("goes straight to Gemini when OpenRouter is not configured at all", async () => {
    readyGemini();
    const generateStructured = vi.fn(async () => OK_FACTS);
    const generateOpenRouter = vi.fn();
    const outcome = await runOnboardingExtraction("I want to lose fat", NOW,
      { ...ctx(), callsUsedThisSession: 0 }, { generateStructured: generateStructured as never, generateOpenRouter: generateOpenRouter as never });
    expect(outcome).toEqual({ status: "ok", facts: OK_FACTS, provider: "google" });
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });
});

describe("worthGeminiFallback", () => {
  it("is worth it for a provider failure", () => {
    expect(worthGeminiFallback(new ProviderHttpError(503, "x"))).toBe(true);
    expect(worthGeminiFallback(new TypeError("fetch failed"))).toBe(true);
  });

  it("is never worth it for our own failures", () => {
    expect(worthGeminiFallback(new SchemaRejection("x"))).toBe(false);
    expect(worthGeminiFallback(new Error("refused: not registered"))).toBe(false);
  });
});

describe("runOnboardingExtraction — the ≤5 calls per session budget (dry run)", () => {
  it("refuses the 6th call outright, with no I/O at all, having made exactly 5", async () => {
    readyOpenRouter();
    const generateOpenRouter = vi.fn(async () => OK_FACTS);
    const user = ctx();
    const outcomes: string[] = [];
    // The server re-counts independently of whatever the client reports (Sol r1 BLOCK 2): every
    // call below claims `callsUsedThisSession: 0`, exactly what a client that always lies (or
    // simply forgot) would send, and the server still cuts it off at the 6th.
    for (let i = 0; i < ONBOARDING_MAX_MODEL_CALLS + 1; i += 1) {
      const outcome = await runOnboardingExtraction("I want to lose fat", NOW,
        { ...user, callsUsedThisSession: 0 }, { generateOpenRouter: generateOpenRouter as never });
      outcomes.push(outcome.status);
    }
    expect(outcomes).toEqual(["ok", "ok", "ok", "ok", "ok", "budget_exceeded"]);
    expect(generateOpenRouter).toHaveBeenCalledTimes(ONBOARDING_MAX_MODEL_CALLS);
  });
});
