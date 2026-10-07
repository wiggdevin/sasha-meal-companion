import { describe, expect, it } from "vitest";
import type { CoachTurnResponse } from "@/lib/coach/types";
import type { CoachCase } from "@/scripts/eval/coach-streak-state";
import { evaluateRunnerTurn } from "@/scripts/eval/coach-streak-evaluate";
import {
  drawCase, loadCorpus, newState, parseCategory, reportRunsOffline, runConfig,
} from "@/scripts/eval/coach-streak-state";
import { mealCaseAssertions } from "@/scripts/eval/coach-streak-meals";

const coachCase: CoachCase = {
  id: "question-protein-high",
  category: "no_action",
  sentence: "why is my protein so high?",
  expected_path: "llm",
  expected_action_kinds: [],
  expected_card_count: { min: 0, max: 0 },
  latency_bound_ms: { fast: 2_000, llm: 15_000 },
  no_unsupported_claim: true,
};

const blockCase: CoachCase = {
  ...coachCase,
  id: "block-weight-trend",
  category: "block",
  sentence: "how's my weight trending?",
  expected_path: "either",
  expected_block_kinds: ["chart"],
  expected_chart: "weight_trend",
};

const activityCase = {
  ...coachCase,
  id: "activity-device-kcal-no-allowance",
  category: "activity",
  sentence: "Apple says I burned 520 calories and I only did 3,200 steps. How much extra can I eat?",
  expected_path: "llm",
} as CoachCase;

function response(reply: string): CoachTurnResponse {
  return {
    threadId: "thread-1",
    suggestions: [],
    actions: [],
    messages: [
      { id: "message-1", role: "user", content: coachCase.sentence, seq: 1 },
      { id: "message-2", role: "assistant", content: reply, seq: 2 },
    ],
    draft: null,
    composed: [],
    deflected: false,
    toolsUsed: [],
    model: { provider: "gemini", modelId: "stored-model" },
  };
}

describe("coach streak runner verification", () => {
  it("accepts the activity category and its single zero-action, zero-card corpus case", () => {
    expect(parseCategory("activity")).toBe("activity");
    const cases = loadCorpus().filter((candidate) => candidate.category === "activity");
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      sentence: activityCase.sentence,
      expected_action_kinds: [],
      expected_card_count: { min: 0, max: 0 },
      expected_block_kinds: [],
    });
    expect(runConfig("activity")).toMatchObject({
      branch: "feat/health-3 (local Docker)", streakTarget: 1,
      title: "Coach activity quality streak — 2026-09-20",
    });
    expect(runConfig("activity").statePath).toContain("2026-09-20-coach-streak-activity");
  });

  it("passes activity copy only with device-estimate, no-mutation, and weekly-proposal wording",
    async () => {
      const result = await evaluateRunnerTurn(
        activityCase,
        response("Your device estimates 520 active calories. That reading does not change your target or create a food allowance. Review the one-tap weekly proposal based on your logs and weight."),
        1_000,
        async () => null,
        [],
        true,
      );

      expect(result.evaluated.passed).toBe(true);
      const c13 = result.evaluated.assertions.filter((item) => item.name.startsWith("C13"));
      expect(c13.length).toBeGreaterThan(0);
      expect(c13.every((item) => item.passed)).toBe(true);
    });

  it("fails the activity case when the reply gives a forbidden food allowance", async () => {
    const result = await evaluateRunnerTurn(
      activityCase,
      response("Your device estimates 520 active calories, so you can eat 520 extra calories."),
      1_000,
      async () => null,
      [],
      true,
    );

    expect(result.evaluated.passed).toBe(false);
    expect(result.evaluated.assertions).toContainEqual(expect.objectContaining({
      name: "C13 forbidden allowance wording", passed: false,
    }));
  });

  it("fails the activity case when the turn did not receive activity context", async () => {
    const result = await evaluateRunnerTurn(
      activityCase,
      response("Your device estimates 520 active calories. That reading does not change your target or create a food allowance. Review the one-tap weekly proposal based on your logs and weight."),
      1_000,
      async () => null,
    );

    expect(result.evaluated.assertions).toContainEqual(expect.objectContaining({
      name: "C13 activity context present", passed: false,
    }));
    expect(result.evaluated.passed).toBe(false);
  });

  it("accepts passive no-mutation wording", async () => {
    const result = await evaluateRunnerTurn(
      activityCase,
      response("Your device estimates 520 active calories. Your target was not changed by that reading. There is no food allowance from it. Review the one-tap weekly proposal based on your logs and weight."),
      1_000,
      async () => null,
      [],
      true,
    );

    expect(result.evaluated.passed).toBe(true);
  });

  it.each([
    "Your device estimates 520 active calories. You can have 520 more calories. That reading does not change your target. Review the one-tap weekly proposal based on your logs and weight.",
    "Your device estimates 520 active calories. Your food allowance is 520 calories. That reading does not change your target. Review the one-tap weekly proposal based on your logs and weight.",
    "Your device estimates 520 active calories. It is not true that this does not change your target. There is no food allowance from it. Review the one-tap weekly proposal based on your logs and weight.",
    "Apple reports 520 active calories. That reading does not change your target or create a food allowance. Review the one-tap weekly proposal based on your logs and weight.",
    "Your device estimates 520 active calories. That reading does not change your target or create a food allowance.",
  ])("rejects unsafe or incomplete activity wording: %s", async (reply) => {
    const result = await evaluateRunnerTurn(
      activityCase, response(reply), 1_000, async () => null, [], true,
    );
    expect(result.evaluated.passed).toBe(false);
  });

  it("fails closed with verifier_error when reply verification throws", async () => {
    const result = await evaluateRunnerTurn(
      coachCase,
      response("You have protein left today."),
      1_000,
      async () => {
        throw new Error("verifier exploded");
      },
    );

    expect(result.diagnosis).toBe("verifier_error");
    expect(result.verification).toBeNull();
    expect(result.evaluated.passed).toBe(false);
    expect(result.evaluated.assertions).toContainEqual({
      name: "reply verifier",
      passed: false,
      detail: "verifier exploded",
    });
  });

  it("uses and records the heuristic only when the verifier returns null", async () => {
    const result = await evaluateRunnerTurn(
      coachCase,
      response("You have protein left today."),
      1_000,
      async () => null,
    );

    expect(result.diagnosis).toBeNull();
    expect(result.verification).toEqual({
      flagged: false,
      p: null,
      verifier: "heuristic",
    });
    expect(result.evaluated.passed).toBe(true);
  });

  it("keeps legacy cases unchanged when expected_block_kinds is absent", async () => {
    const result = await evaluateRunnerTurn(
      coachCase,
      response("Here is the answer."),
      1_000,
      async () => null,
      [{ kind: "future", v: 99 }],
    );

    expect(result.evaluated.passed).toBe(true);
    expect(result.evaluated.assertions.map((assertion) => assertion.name))
      .not.toContain("expected block-kind set");
  });

  it("requires exact persisted block-kind set equality", async () => {
    const matching = await evaluateRunnerTurn(
      blockCase,
      response("Here is your trend."),
      1_000,
      async () => null,
      [{ kind: "chart", v: 1, chart: "weight_trend" }],
    );
    const extra = await evaluateRunnerTurn(
      blockCase,
      response("Here is your trend."),
      1_000,
      async () => null,
      [{ kind: "chart", v: 1, chart: "weight_trend" }, { kind: "quick_replies", v: 1 }],
    );

    expect(matching.evaluated.assertions).toContainEqual(expect.objectContaining({
      name: "expected block-kind set", passed: true,
    }));
    expect(extra.evaluated.assertions).toContainEqual(expect.objectContaining({
      name: "expected block-kind set", passed: false,
    }));
  });

  it("requires version 1 for every expected persisted block", async () => {
    const result = await evaluateRunnerTurn(
      blockCase,
      response("Here is your trend."),
      1_000,
      async () => null,
      [{ kind: "chart", v: 2, chart: "weight_trend" }],
    );

    expect(result.evaluated.assertions).toContainEqual(expect.objectContaining({
      name: "expected block version", passed: false,
    }));
    expect(result.evaluated.passed).toBe(false);
  });

  it("requires the exact persisted chart subtype", async () => {
    const result = await evaluateRunnerTurn(
      blockCase,
      response("Here is your trend."),
      1_000,
      async () => null,
      [{ kind: "chart", v: 1, chart: "macros_today" }],
    );

    expect(result.evaluated.assertions).toContainEqual(expect.objectContaining({
      name: "expected chart subtype", passed: false,
    }));
    expect(result.evaluated.passed).toBe(false);
  });
});

describe("meals streak contract", () => {
  const item = (name: string, grams: number, kcalPer100g: number) => ({
    name, grams, kcalPer100g, proteinPer100g: 10, carbsPer100g: 10, fatPer100g: 10,
  });
  const mealResponse = (action: Record<string, unknown>, reply = "Done.") => ({
    ...response(reply), actions: [{ actionId: "action-1", flagged: [], ...action }],
  }) as unknown as CoachTurnResponse;

  it("runs a fresh --report request live, but reports a completed state offline", () => {
    const config = runConfig("meals");
    expect(reportRunsOffline(true, null)).toBe(false);
    expect(reportRunsOffline(true, { ...newState("seed", config), status: "success" })).toBe(true);
  });

  it("runs the five meals cases in scenario order so P2 follows P1", () => {
    const meals = loadCorpus().filter((candidate) => candidate.category === "meals");
    expect(meals.map((_candidate, index) => drawCase(meals, "any-seed", index).id)).toEqual([
      "meals-p1-month-breakfast",
      "meals-p2-future-breakfast",
      "meals-p3-next-tuesday-lunch",
      "meals-p4-spaghetti-snack",
      "meals-p6-weekday-oatmeal",
    ]);
  });

  it("requires P1's 31 dates, dish title, breakfast slot, and 570-700 kcal", () => {
    const dates = Array.from({ length: 31 }, (_, offset) => {
      const date = new Date(Date.UTC(2026, 8, 20 + offset));
      return date.toISOString().slice(0, 10);
    });
    const assertions = mealCaseAssertions("meals-p1-month-breakfast", mealResponse({
      kind: "set_slot_meal", date: dates[0], from: dates[0], through: dates.at(-1), dates,
      slot: "meal-1", title: "Sourdough toast, bacon & eggs",
      items: [item("toast", 76, 274), item("bacon", 24, 358), item("eggs", 200, 155)],
    }), "2026-09-20");
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("rejects generic titles and a one-day P1 action", () => {
    const assertions = mealCaseAssertions("meals-p1-month-breakfast", mealResponse({
      kind: "set_slot_meal", date: "2026-09-20", from: "2026-09-20",
      through: "2026-09-20", dates: ["2026-09-20"], slot: "meal-1", title: "Breakfast",
      items: [item("eggs", 200, 155)],
    }), "2026-09-20");
    expect(assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name))
      .toEqual(expect.arrayContaining(["C9 selected dates", "C9 dish title", "C9 calorie range"]));
  });

  it("requires P2 to read the phone-materialized dish title", () => {
    const assertions = mealCaseAssertions("meals-p2-future-breakfast",
      response("Sourdough toast, bacon & eggs is your breakfast."), "2026-09-20",
      "Sourdough toast, bacon & eggs");
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("requires Tuesday lunch to be meal-2 with the dish title", () => {
    const assertions = mealCaseAssertions("meals-p3-next-tuesday-lunch", mealResponse({
      kind: "set_slot_meal", date: "2026-09-22", from: "2026-09-22",
      through: "2026-09-22", dates: ["2026-09-22"], slot: "meal-2",
      title: "Grilled chicken & rice", items: [item("chicken", 85, 165), item("rice", 160, 130)],
    }), "2026-09-20");
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("requires the spaghetti log to keep its dish title instead of Snack", () => {
    const assertions = mealCaseAssertions("meals-p4-spaghetti-snack", mealResponse({
      kind: "log_meal", date: "2026-09-20", slot: "snack", title: "Spaghetti bolognese",
      items: [item("spaghetti bolognese", 350, 137)],
    }), "2026-09-20");
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("requires the ten weekdays in P6's inclusive two-week window", () => {
    const dates = [
      "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25",
      "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02",
    ];
    const assertions = mealCaseAssertions("meals-p6-weekday-oatmeal", mealResponse({
      kind: "set_slot_meal", date: "2026-09-20", from: "2026-09-20", through: "2026-10-03",
      weekdays: [1, 2, 3, 4, 5], dates, slot: "meal-1", title: "Oatmeal with blueberries",
      items: [item("oatmeal", 234, 71), item("blueberries", 148, 57)],
    }), "2026-09-20");
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });
});
