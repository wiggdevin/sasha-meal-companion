/**
 * 2026-10-03: Jev saw only "Meal 1", so scallops with a banana at 7:30 am could not read as odd,
 * and ranking was macro closeness alone. The slot label now carries the meal type and clock, the
 * question asks about the time of day, and pairing fit weighs into the rank.
 */
import { describe, expect, it } from "vitest";
import type { ComposedMeal } from "@/lib/coach/compose";
import { questionsFor } from "@/lib/coach/suggest-questions";
import { rankCandidates, rankingState, suggestionRank, timedLabel } from "@/lib/coach/suggest-rank";

const meal = (over: Partial<ComposedMeal>): ComposedMeal => ({
  wish: "x", slot: "meal-1", items: [], totals: { kcal: 400, protein: 30, carbs: 40, fat: 12 },
  target: { kcal: 400, protein: 30, carbs: 40, fat: 12 }, flagged: [], fitsTarget: true, ...over,
});

describe("time-aware ranking", () => {
  it("labels the slot with its meal type and clock time", () => {
    const state = rankingState({ kind: "meal", slot: "meal-1" },
      [{ meal: meal({ mealType: "breakfast", mealClock: "07:30" }), fit: 0.9, index: 0 }], undefined);
    expect(state.slot.label).toBe("Meal 1 — breakfast at 07:30");
    expect(timedLabel("Meal 2", { mealType: "other", mealClock: null })).toBe("Meal 2");
  });

  it("asks Jev about the time of day", () => {
    const question = JSON.stringify(questionsFor("meal", 1));
    expect(question).toMatch(/time of day/);
  });

  it("weighs pairing fit, not only macro closeness", () => {
    expect(suggestionRank(0.9, undefined, 1)).toBeCloseTo(0.9);
    expect(suggestionRank(0.9, undefined, 0)).toBeCloseTo(0.54);
    const odd = { meal: meal({ pairing: 0.3 }), fit: 0.95, index: 0, pairing: 0.3 };
    const usual = { meal: meal({ pairing: 1 }), fit: 0.85, index: 1, pairing: 1 };
    expect(rankCandidates([odd, usual], null, "meal")[0].candidate).toBe(usual);
  });
});
