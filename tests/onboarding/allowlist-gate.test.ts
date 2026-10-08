// Onboarding v2: the allowlist gate (lib/coach/onboarding-allowlist.ts) in front of the one
// bounded extraction call, end to end on the phone (extractOnboardingFacts through the real route
// handler, only the session and the model transport mocked) and on the server alone
// (runOnboardingExtraction, as a client that skipped every check would reach it).
//
// Three final Sol reviews each found a medicine the deny lists missed (aspirin, amoxicillin). The
// gate inverts the rule: a model reads only text whose every word is a reviewed onboarding word.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { POST } from "@/app/api/onboarding/extract/route";
import { extractOnboardingFacts } from "@/lib/onboarding/extract-client";
import { runOnboardingExtraction } from "@/lib/server/onboarding-extract";
import {
  ONBOARDING_WORDS, onboardingAllowlistVerdict, onboardingMayReachModel,
} from "@/lib/coach/onboarding-allowlist";
import { namesMedicine, onboardingSafetyCheck, US_MEDICINE_NAMES } from "@/lib/coach/onboarding-safety";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS, REDTEAM_CORPUS } from "@/tests/fixtures/taste-safety-corpus";
import {
  DUAL_MEANING, MEDICINE_AND_CONDITION, NORMAL_OPENERS, SOL_REVIEW_MEDICINE,
} from "@/tests/onboarding/allowlist-corpus";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/ai/openrouter", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/openrouter")>()), generateOpenRouter: vi.fn() }));

const user = vi.mocked(requireUser);
const model = vi.mocked(generateOpenRouter);
const NOW = new Date("2026-10-08T15:00:00Z");
let n = 0;

const routeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
  POST(new Request(new URL(String(input), "https://app.test"), {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), "x-real-ip": "9.9.9.9" },
  })));

beforeEach(() => {
  resetRateLimits();
  n += 1;
  user.mockReset(); model.mockReset(); routeFetch.mockClear();
  user.mockResolvedValue({ userId: `allowlist-gate-u${n}`, client: {} as never });
  model.mockResolvedValue({ confidence: {} } as never);
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_ATTESTED", "1");
  unbindAccount(); bindAccount(TEST_USER);
});
afterEach(() => { vi.unstubAllEnvs(); unbindAccount(); });

const opts = { now: NOW, online: true, fetchImpl: routeFetch as never };

/**
 * W5b "rules" sentences that are plain goal statements, not health text: the taste box keeps them
 * local because "weight" is a rule word THERE; here they are exactly what the opener exists to read.
 * Reviewed 2026-10-08. This list may only shrink.
 */
const REVIEWED_GOAL_STATEMENTS = ["I'm trying to lose weight", "I'm bulking"];

const W5B = [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS].map((c) => c.text);
const KEEP_LOCAL = [...W5B, ...REDTEAM_CORPUS, ...SOL_REVIEW_MEDICINE, ...MEDICINE_AND_CONDITION, ...DUAL_MEANING]
  .filter((text) => !REVIEWED_GOAL_STATEMENTS.includes(text));

describe("the onboarding vocabulary", () => {
  it("holds plain lowercase words only", () => {
    for (const word of ONBOARDING_WORDS) expect(word, word).toMatch(/^[a-z][a-z'-]*$/);
  });

  it("holds no word the deny layer reads as health, medicine or symptom text", () => {
    const flagged = [...ONBOARDING_WORDS].filter((word) => onboardingSafetyCheck(word).blocked
      || onboardingSafetyCheck(`i ${word}`).blocked || namesMedicine(word));
    expect(flagged).toEqual([]);
  });

  it.each(["fit", "myself", "fast", "stone", "cycle", "back", "mass", "skip", "labor", "take", "taking", "took", "feel", "tired", "energy", "health", "pill", "doctor", "diet",
    "vegan", "keto", "thing", "stuff", "because", "since", "avoid", "can't", "allergic", "pain"])(
    "never holds %s", (word) => {
      expect(ONBOARDING_WORDS.has(word)).toBe(false);
    });

  it("holds no medicine name on the U.S. list", () => {
    expect(US_MEDICINE_NAMES.filter((name) => name.split(" ").every((w) => ONBOARDING_WORDS.has(w))))
      .toEqual([]);
  });
});

describe("the allowlist verdict", () => {
  it.each([
    ["I take aspirin daily", "unknown_word"],
    ["I want to lose weight 🙂", "characters"],
    ["should I lose weight?", "shape"],
    ["I don't eat after 7", "shape"],
    ["lunch makes me want to sleep", "shape"],
    ["lose weight ".repeat(40), "too_long"],
    ["   ", "empty"],
  ])("keeps %s local (%s)", (text, reason) => {
    expect(onboardingAllowlistVerdict(text)).toEqual({ send: false, reason });
  });

  it.each(DUAL_MEANING)("keeps a dual-meaning sentence local: %s", (text) => {
    expect(onboardingMayReachModel(text)).toBe(false);
  });

  it("reads the goal and measure uses of those words", () => {
    for (const text of ["I want to get fit", "stay fit and lose 10 lb", "5 foot 6", "6 feet tall",
      "on my feet all day", "lose body fat"]) {
      expect(onboardingMayReachModel(text), text).toBe(true);
    }
  });

  it("reads foot and inch marks, glued units and clock times", () => {
    for (const text of ["5'6\"", "5’6”, 170lbs", "178cm 72kg", "first meal at 7:30am", "34 y.o.", "meal-prep twice a week"]) {
      expect(onboardingMayReachModel(text), text).toBe(true);
    }
  });
});

describe("zero model calls for medicine, condition, allergy and symptom text", () => {
  it(`the phone sends none of ${KEEP_LOCAL.length} keep-local sentences to a model`, async () => {
    expect(KEEP_LOCAL.length).toBeGreaterThan(650);
    expect(MEDICINE_AND_CONDITION.length).toBeGreaterThanOrEqual(30);
    const reached: string[] = [];
    for (const text of KEEP_LOCAL) {
      routeFetch.mockClear(); model.mockClear();
      const out = await extractOnboardingFacts(text, opts);
      if (out.modelCalled || routeFetch.mock.calls.length > 0 || model.mock.calls.length > 0) reached.push(text);
    }
    expect(reached).toEqual([]);
  });

  it("the server, asked directly, builds no payload for any of them", async () => {
    const generateStructured = vi.fn();
    const openRouter = vi.fn();
    const sent: string[] = [];
    for (const text of KEEP_LOCAL) {
      const outcome = await runOnboardingExtraction(text.slice(0, 2_000), NOW,
        { userId: "allowlist-gate-server", admin: {} as never, callsUsedThisSession: 0 },
        { generateStructured: generateStructured as never, generateOpenRouter: openRouter as never });
      if (outcome.status !== "blocked" && outcome.status !== "not_sent") sent.push(text);
    }
    expect(sent).toEqual([]);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(openRouter).not.toHaveBeenCalled();
  });

  it("the server answers not_sent for unknown words even when the deny layer passes them", async () => {
    const openRouter = vi.fn();
    const outcome = await runOnboardingExtraction("I'm on zorbatrex and want to lose weight", NOW,
      { userId: "allowlist-gate-server-2", admin: {} as never, callsUsedThisSession: 0 },
      { generateOpenRouter: openRouter as never });
    expect(onboardingSafetyCheck("I'm on zorbatrex and want to lose weight").blocked).toBe(false);
    expect(outcome).toEqual({ status: "not_sent" });
    expect(openRouter).not.toHaveBeenCalled();
  });

  it("only the reviewed goal statements in the W5b corpus pass both gates (ratchet)", () => {
    const passing = W5B.filter((text) => !onboardingSafetyCheck(text).blocked && onboardingMayReachModel(text));
    expect(passing).toEqual(REVIEWED_GOAL_STATEMENTS);
  });

  it("keeps the fast path's local reading when the text stays local", async () => {
    const out = await extractOnboardingFacts("I'm 5'6, 170 lb, on zorbatrex, want to lose weight", opts);
    expect(out).toMatchObject({ status: "local_only", modelCalled: false, callsUsed: 0 });
    expect(out.facts.goal).toBe("lose_fat");
    expect(out.facts.weightKg).toBeCloseTo(77.1, 1);
    expect(routeFetch).not.toHaveBeenCalled();
  });
});

describe("ordinary openers", () => {
  it.each(NORMAL_OPENERS)("%s passes the gate", (text) => {
    expect(onboardingSafetyCheck(text)).toEqual({ blocked: false });
    expect(onboardingAllowlistVerdict(text)).toEqual({ send: true });
  });

  it("every one is read: locally in full, or the model is asked for the rest", async () => {
    const tally = { local: 0, model: 0, unread: 0 };
    for (const text of NORMAL_OPENERS) {
      resetRateLimits();
      user.mockResolvedValue({ userId: `allowlist-gate-opener-${n}-${tally.local + tally.model + tally.unread}`, client: {} as never });
      const out = await extractOnboardingFacts(text, opts);
      if (out.modelCalled) tally.model += 1;
      else if (out.status === "ok") tally.local += 1;
      else tally.unread += 1;
    }
    // Measured 2026-10-08: 0 read in full locally, 20 of 20 ask the model for activity or cooking.
    expect(tally).toEqual({ local: 0, model: NORMAL_OPENERS.length, unread: 0 });
    expect(tally.unread).toBe(0);
    expect(tally.local + tally.model).toBe(NORMAL_OPENERS.length);
  });
});
