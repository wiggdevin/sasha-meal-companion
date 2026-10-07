import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));

vi.mock("@/lib/ai/typesafe", () => ({
  choice: (instructions: string, criteria: Record<string, string>) => ({
    type: "choice", instructions, criteria,
  }),
  noul: (instructions: string, criteria?: Record<string, string>) => ({
    type: "noul", instructions, ...(criteria ? { criteria } : {}),
  }),
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    systemOneMock(p.state, p.questions, { ...o, purpose: p.purpose }),
}));

import {
  classifyIntent,
  extractNumbers,
  hintLine,
  isFastPathEligible,
  minArgumentConfidence,
} from "@/lib/coach/intent";

type IntentName =
  | "shift_schedule" | "log_food" | "plan_meal" | "suggest_options" | "add_to_eats" | "add_to_avoid"
  | "remove_from_eats" | "remove_from_avoid" | "log_water" | "log_weight"
  | "update_profile" | "set_targets" | "show_chart" | "question" | "other";

function answers(
  intent: IntentName,
  confidence = 0.96,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent: { type: "choice", choice: intent, probabilities: { [intent]: confidence }, confidence },
    direction: { type: "choice", choice: "later", probabilities: { later: 0.98 }, confidence: 0.98 },
    scope: { type: "choice", choice: "remaining", probabilities: { remaining: 0.94 }, confidence: 0.94 },
    suggest_kind: { type: "choice", choice: "meal", probabilities: { meal: 0.9 }, confidence: 0.9 },
    suggest_count: { type: "choice", choice: "3", probabilities: { "3": 0.9 }, confidence: 0.9 },
    suggest_slot: { type: "choice", choice: "none", probabilities: { none: 0.99 }, confidence: 0.99 },
    fit_remaining: { type: "noul", noul: 0.1 },
    mentions_specific_foods: { type: "noul", noul: 0.1 },
    mentions_size: { type: "noul", noul: 0.1 },
    time_amount_stated: { type: "noul", noul: 0.99 },
    water_amount_stated: { type: "noul", noul: 0.99 },
    weight_stated: { type: "noul", noul: 0.99 },
    ...overrides,
  };
}

const context = { now: "2026-09-19T10:00:00-06:00", userId: "u1" };

describe("intent pre-pass", () => {
  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    systemOneMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps a command with a second clause off Jev (Phase 18 W5b whole-message grammar)", async () => {
    systemOneMock.mockResolvedValue(answers("shift_schedule"));
    expect(await classifyIntent("I woke up late, can you move all my meals by 30 minutes?", context)).toBeNull();
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("classifies the schedule command into a complete fast-path schedule shift", async () => {
    systemOneMock.mockResolvedValue(answers("shift_schedule"));

    const result = await classifyIntent("move all my meals by 30 minutes", context);

    expect(result).toMatchObject({
      intent: "shift_schedule",
      confidence: 0.96,
      args: { minutes: 30, direction: "later", scope: "remaining" },
      argConfidence: { minutes: 1, direction: 0.98, scope: 0.94 },
    });
    expect(minArgumentConfidence(result!)).toBe(0.94);
    expect(isFastPathEligible(result!)).toBe(true);
    expect(systemOneMock).toHaveBeenCalledOnce();
    expect(systemOneMock.mock.calls[0][0]).not.toHaveProperty("userId");
    expect(systemOneMock.mock.calls[0][2]).toEqual({
      purpose: "coach-intent", userId: "u1", deadlineMs: 3_000,
    });
  });

  it("classifies generic suggestions as complete mechanical work", async () => {
    systemOneMock.mockResolvedValue(answers("suggest_options", 0.97, {
      suggest_count: { type: "choice", choice: "5", probabilities: { "5": 0.99 }, confidence: 0.99 },
      mentions_specific_foods: { type: "noul", noul: 0.03 },
      mentions_size: { type: "noul", noul: 0.04 },
    }));

    const result = await classifyIntent("make me 5 suggestions from my eats list", context);

    expect(result).toMatchObject({
      intent: "suggest_options",
      args: { kind: "meal", count: 5, fitRemaining: false },
    });
    expect(result?.args).not.toHaveProperty("slot");
    expect(isFastPathEligible(result!)).toBe(true);
  });

  it("carries an explicitly named suggestion slot", async () => {
    systemOneMock.mockResolvedValue(answers("suggest_options", 0.97, {
      suggest_slot: {
        type: "choice", choice: "meal-2", probabilities: { "meal-2": 0.99 }, confidence: 0.99,
      },
      mentions_specific_foods: { type: "noul", noul: 0.02 },
      mentions_size: { type: "noul", noul: 0.02 },
    }));

    const result = await classifyIntent("suggest three options for meal 2", context);

    expect(result?.args).toEqual({
      kind: "meal", count: 3, fitRemaining: false, slot: "meal-2",
    });
    expect(isFastPathEligible(result!)).toBe(true);
  });

  it.each(["meal-4", "meal-5", "meal-6"] as const)(
    "offers and accepts %s for an explicitly named meal suggestion", async (slot) => {
      systemOneMock.mockResolvedValue(answers("suggest_options", 0.97, {
        suggest_slot: { type: "choice", choice: slot,
          probabilities: { [slot]: 0.99 }, confidence: 0.99 },
      }));

      const result = await classifyIntent(`suggest options for ${slot}`, context);

      expect(systemOneMock.mock.calls[0][1].suggest_slot.criteria).toHaveProperty(slot);
      expect(result?.args).toMatchObject({ kind: "meal", slot });
      expect(isFastPathEligible(result!)).toBe(true);
    },
  );

  it("drops a suggested slot when the sentence did not name it", async () => {
    systemOneMock.mockResolvedValue(answers("suggest_options", 0.97, {
      suggest_slot: {
        type: "choice", choice: "meal-2", probabilities: { "meal-2": 0.99 }, confidence: 0.99,
      },
    }));

    const result = await classifyIntent("make me three suggestions from my Eats list", context);

    expect(result?.args).toEqual({ kind: "meal", count: 3, fitRemaining: false });
  });

  it("keeps a named-food suggestion out of the mechanical fast path", async () => {
    systemOneMock.mockResolvedValue(answers("suggest_options", 0.97, {
      mentions_specific_foods: { type: "noul", noul: 0.99 },
      mentions_size: { type: "noul", noul: 0.02 },
      fit_remaining: { type: "noul", noul: 0.98 },
    }));

    const result = await classifyIntent("a chicken wrap that fits my macros", context);

    expect(isFastPathEligible(result!)).toBe(false);
  });

  it("lets a named recipe dish use the shared deterministic search", async () => {
    systemOneMock.mockResolvedValue(answers("suggest_options", 0.97, {
      suggest_kind: { type: "choice", choice: "recipe", confidence: 0.98 },
      mentions_specific_foods: { type: "noul", noul: 0.99 },
      mentions_size: { type: "noul", noul: 0.01 },
    }));
    const result = await classifyIntent("find a chicken stew recipe", context);
    expect(result?.args).toMatchObject({ kind: "recipe" });
    expect(isFastPathEligible(result!, "find a chicken stew recipe")).toBe(true);
  });

  it.each([
    "set two slices of toast, bacon and eggs as my breakfast for the next month",
    "change next Tuesday's lunch to grilled chicken and rice",
    "set my breakfast to oatmeal with blueberries every weekday for the next two weeks",
  ])("routes a planned meal through plan_meal with no fast path: %s", async (message) => {
    systemOneMock.mockResolvedValue(answers("plan_meal", 0.99));

    const result = await classifyIntent(message, context);

    expect(result).toMatchObject({ intent: "plan_meal", args: {} });
    expect(isFastPathEligible(result!, message)).toBe(false);
    expect(hintLine(result!)).toContain("Likely intent: plan_meal (0.99)");
    expect(systemOneMock.mock.calls.at(-1)?.[1].intent.criteria.plan_meal)
      .toMatch(/set|planned/i);
  });

  it.each([
    ["shift_schedule", "move my meals by 30 minutes", "time_amount_stated", { minutes: 30 }],
    ["log_water", "log 2 cups of water", "water_amount_stated", { ml: 480 }],
    ["log_weight", "I weigh 128 lb", "weight_stated", { kg: 58.06 }],
  ] as const)("trusts one code-extracted amount for %s even when its noul says unstated",
    async (intent, message, statedKey, expected) => {
      systemOneMock.mockResolvedValue(answers(intent, 0.97, {
        [statedKey]: { type: "noul", noul: 0.02 },
      }));

      const result = await classifyIntent(message, context);

      expect(result?.args).toMatchObject(expected);
      expect(isFastPathEligible(result!)).toBe(true);
    });

  it("normalizes a written hour to 60 minutes", async () => {
    systemOneMock.mockResolvedValue(answers("shift_schedule", 0.97, {
      scope: { type: "choice", choice: "all", probabilities: { all: 0.97 }, confidence: 0.97 },
    }));

    const result = await classifyIntent("push everything back an hour", context);

    expect(result?.args).toEqual({ minutes: 60, direction: "later", scope: "all" });
  });

  it("marks a schedule shift without a number as incomplete", async () => {
    systemOneMock.mockResolvedValue(answers("shift_schedule", 0.98, {
      time_amount_stated: { type: "noul", noul: 0.05 },
    }));

    const result = await classifyIntent("move my meals later", context);

    expect(result?.args).toEqual({
      direction: "later",
      scope: "remaining",
      missing: ["minutes"],
    });
    expect(isFastPathEligible(result!)).toBe(false);
  });

  it("keeps a low-confidence mechanical intent as a prompt hint, not a fast path", async () => {
    systemOneMock.mockResolvedValue(answers("shift_schedule", 0.6));

    const result = await classifyIntent("move my meals later by 30 minutes", context);

    expect(isFastPathEligible(result!)).toBe(false);
    expect(hintLine(result!)).toContain("Likely intent: shift_schedule (0.60)");
    expect(hintLine(result!)).toContain("minutes=30");
  });

  it.each([
    ["show my weight trend", "weight_trend"],
    ["how am I doing this week", "kcal_week"],
  ] as const)("fast-paths the explicit chart request: %s", async (message, chart) => {
    systemOneMock.mockResolvedValue(answers("show_chart", 0.90));

    const result = await classifyIntent(message, context);

    expect(result).toMatchObject({
      intent: "show_chart", args: { chart }, argConfidence: { chart: 1 },
    });
    expect(isFastPathEligible(result!, message)).toBe(true);
    expect(hintLine(result!)).toContain("Likely intent: show_chart (0.90)");
  });

  it("requires 0.95 confidence for a mutating fast path", async () => {
    systemOneMock.mockResolvedValue(answers("shift_schedule", 0.94));

    const result = await classifyIntent("move my meals later by 30 minutes", context);

    expect(isFastPathEligible(result!)).toBe(false);
  });

  it("requires every Jev-selected action argument to reach 0.90", async () => {
    systemOneMock.mockResolvedValue(answers("shift_schedule", 0.96, {
      scope: {
        type: "choice", choice: "remaining", probabilities: { remaining: 0.85 }, confidence: 0.85,
      },
    }));

    const result = await classifyIntent("move my meals later by 30 minutes", context);

    expect(result?.argConfidence).toMatchObject({ minutes: 1, direction: 0.98, scope: 0.85 });
    expect(isFastPathEligible(result!)).toBe(false);
  });

  it("allows a 0.91 complete suggestion through its lower-risk fast path", async () => {
    systemOneMock.mockResolvedValue(answers("suggest_options", 0.91));

    const result = await classifyIntent("suggest three meal options", context);

    expect(isFastPathEligible(result!)).toBe(true);
  });

  it("requires 0.90 certainty that a generic suggestion has no named-food wish", async () => {
    systemOneMock.mockResolvedValue(answers("suggest_options", 0.91, {
      mentions_specific_foods: { type: "noul", noul: 0.15 },
    }));

    const result = await classifyIntent("suggest three meal options", context);

    expect(result?.argConfidence).toMatchObject({ mentionsSpecificFoods: 0.85 });
    expect(isFastPathEligible(result!)).toBe(false);
  });

  it("uses the grounded food mention only for an add-to-avoid winner", async () => {
    systemOneMock.mockResolvedValue(answers("add_to_avoid"));

    const result = await classifyIntent("add watermelon to my avoid list", {
      ...context,
      foodsMentioned: ["watermelon"],
    });

    expect(result?.args).toEqual({ name: "watermelon" });
    expect(isFastPathEligible(result!)).toBe(true);
  });

  it("converts cups to millilitres for a water winner", async () => {
    systemOneMock.mockResolvedValue(answers("log_water"));

    const result = await classifyIntent("log 2 cups of water", context);

    expect(result?.args).toEqual({ ml: 480 });
  });

  it("converts pounds to kilograms for a weight winner", async () => {
    systemOneMock.mockResolvedValue(answers("log_weight"));

    const result = await classifyIntent("I weigh 128 lb today", context);

    expect(result?.args).toEqual({ kg: 58.06 });
  });

  it("returns null when SystemOne is unavailable", async () => {
    systemOneMock.mockResolvedValue(null);

    await expect(classifyIntent("move my meals by 30 minutes", context)).resolves.toBeNull();
  });

  it.each([
    [0.7, false, ["ml"]],
    [0.95, true, undefined],
  ] as const)("uses %.2f Choice confidence for a number selected from several candidates",
    async (whichConfidence, eligible, missing) => {
      systemOneMock.mockResolvedValue(answers("log_water", 0.97, {
        which_number: {
          type: "choice",
          choice: "2 cups",
          probabilities: { "2 cups": whichConfidence, "30 min": 0.01, none: 0.01 },
          confidence: whichConfidence,
        },
      }));

      const result = await classifyIntent("In 30 min, log 2 cups of water", context);

      expect(result?.args).toMatchObject({ ml: 480 });
      expect(result?.args.missing).toEqual(missing);
      expect(result?.argConfidence.ml).toBe(whichConfidence);
      expect(isFastPathEligible(result!)).toBe(eligible);
      const [, questionMap] = systemOneMock.mock.calls[0];
      expect(questionMap.which_number.criteria).toEqual({
        "30 min": "The amount written as '30 min'.",
        "2 cups": "The amount written as '2 cups'.",
        none: "None of these numbers supplies the winning intent's amount.",
      });
    });

  it("keeps one numeric candidate deterministic", async () => {
    systemOneMock.mockResolvedValue(answers("log_water", 0.97));

    const result = await classifyIntent("log 2 cups of water", context);

    expect(result?.args).toEqual({ ml: 480 });
    expect(result?.argConfidence.ml).toBe(1);
    expect(isFastPathEligible(result!)).toBe(true);
  });
});

describe("extractNumbers", () => {
  it.each([
    ["wait 30 minutes", [{ value: 30, unit: "min", raw: "30 minutes" }]],
    ["push it 2 h", [{ value: 2, unit: "hour", raw: "2 h" }]],
    ["an hour later", [{ value: 1, unit: "hour", raw: "an hour" }]],
    ["half an hour later", [{ value: 30, unit: "min", raw: "half an hour" }]],
    ["drink a cup", [{ value: 1, unit: "cup", raw: "a cup" }]],
    ["drink 250 ml", [{ value: 250, unit: "ml", raw: "250 ml" }]],
    ["drink 12 oz", [{ value: 12, unit: "oz", raw: "12 oz" }]],
    ["I weigh 58 kg", [{ value: 58, unit: "kg", raw: "58 kg" }]],
    ["I weigh 128 lb", [{ value: 128, unit: "lb", raw: "128 lb" }]],
    ["make 5 suggestions", [{ value: 5, unit: null, raw: "5" }]],
  ] as const)("normalizes units in %s", (message, expected) => {
    expect(extractNumbers(message)).toEqual(expected);
  });
});
