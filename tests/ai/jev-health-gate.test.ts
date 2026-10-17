/**
 * OD12 (docs/decisions/2026-10-12-owner-decisions.md): with `JEV_HEALTH_GATE=1`, health-bearing Jev
 * payloads never leave. The gate is off by default (in-house testing keeps Jev on every path). Free
 * text counts as health-bearing unless the W5b local check clears it; a coach reply always does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminClientMock } = vi.hoisted(() => ({ adminClientMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", () => ({ adminClient: adminClientMock }));

import { withJevBudget } from "@/lib/ai/request-budget";
import {
  intentPayload, jevCarriesHealth, prefsPayload, rolePayload, suggestPayload, verifyPayload,
} from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";
import { spendAdmin } from "./spend-admin";

const verify = (reply: string) => verifyPayload({ reply, actions: [], toolNames: [] });
const intent = (message: string) => intentPayload({ message, now: "2026-10-17T08:00:00Z", numbers: [] });
const suggest = (wish: string | null) => suggestPayload({
  slot: { id: "m1", label: "Meal 1" },
  wish,
  candidates: [{ index: 0, foods: [{ name: "Oats", grams: 60 }],
    macros: { kcal: 230, protein: 8, carbs: 40, fat: 4 } }],
}, "meal");

describe("which Jev payloads are health-bearing", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a coach reply is always health-bearing", () => {
    expect(jevCarriesHealth(verify("Logged your lunch."))).toBe(true);
  });

  it("a message the local check clears is not; one it keeps is", () => {
    expect(jevCarriesHealth(intent("i love spicy food"))).toBe(false);
    expect(jevCarriesHealth(intent("my doctor says no salt for my kidneys"))).toBe(true);
    expect(jevCarriesHealth(prefsPayload({ text: "i love korean food" }))).toBe(false);
    expect(jevCarriesHealth(prefsPayload({ text: "dairy makes me bloated" }))).toBe(true);
  });

  it("food-only payloads are not health-bearing", () => {
    expect(jevCarriesHealth(rolePayload({
      food: { name: "Greek yogurt", description: null, prepState: null },
      nutrientBuckets: { protein: "dense", carb: "low", fat: "low" },
    }))).toBe(false);
  });

  it("a value no builder minted counts as health-bearing", () => {
    expect(jevCarriesHealth({ purpose: "coach-verify", state: {}, questions: {} })).toBe(true);
  });

  it("an uncleared wish is sent and marked while the gate is off, dropped while it is on", () => {
    const sent = suggest("something low sodium for my blood pressure");
    expect(sent.state.wish).toBe("something low sodium for my blood pressure");
    expect(jevCarriesHealth(sent)).toBe(true);

    vi.stubEnv("JEV_HEALTH_GATE", "1");
    const dropped = suggest("something low sodium for my blood pressure");
    expect(dropped.state.wish).toBeNull();
    expect(jevCarriesHealth(dropped)).toBe(false);

    const kept = suggest("i love spicy food");
    expect(kept.state.wish).toBe("i love spicy food");
    expect(jevCarriesHealth(kept)).toBe(false);
  });
});

describe("the TypeSafe adapter and the health gate", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const answer = () => new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: { claims_unlisted_action: { type: "noul", noul: 0.1 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
    vi.stubGlobal("fetch", vi.fn(async () => answer()));
    adminClientMock.mockReset();
    adminClientMock.mockReturnValue(spendAdmin([]));
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it("sends a health-bearing payload while the gate is off (the default)", async () => {
    await expect(withJevBudget(() => systemOne(verify("Logged your lunch."), { userId: "user-1" })))
      .resolves.toEqual({ claims_unlisted_action: { type: "noul", noul: 0.1 } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends nothing and returns null while JEV_HEALTH_GATE is 1", async () => {
    vi.stubEnv("JEV_HEALTH_GATE", "1");
    await expect(withJevBudget(() => systemOne(verify("Logged your lunch."), { userId: "user-1" })))
      .resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[typesafe] health-bearing payload: JEV_HEALTH_GATE is on");
  });

  it("still sends a payload with no health text while the gate is on", async () => {
    vi.stubEnv("JEV_HEALTH_GATE", "1");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 2 },
      answers: { which_intent: { type: "choice", choice: "other", probabilities: {}, confidence: 0.5 } },
    }), { status: 200 }));
    await withJevBudget(() => systemOne(intent("i love spicy food"), { userId: "user-1" }));
    expect(fetch).toHaveBeenCalledOnce();
  });
});
