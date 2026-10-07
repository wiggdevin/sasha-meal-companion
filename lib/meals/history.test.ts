import { describe, expect, it } from "vitest";
import { BREAKFAST, eats, F } from "@/tests/helpers/meal-foods";
import { affinity, pairScore, PAIR_FLOOR } from "./affinity";
import { historyScores, historyWindowStart, type HistoryLog } from "./history";
import { rankPlates } from "./plate";
import type { MealEvidence } from "./snapshot";

const TODAY = "2026-10-04";
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const tunaAt = (...ages: number[]): HistoryLog[] =>
  ages.map((age) => ({ food: "tuna", occasion: "breakfast", localDate: daysAgo(age) }));
const evidenceFrom = (scores: ReturnType<typeof historyScores>): MealEvidence => ({
  accountId: "a", computedAt: `${TODAY}T08:00:00.000Z`,
  // Keyed by the food's name key, as mealEvidence projects it.
  history: Object.fromEntries(Object.entries(scores).map(([id, row]) => [id === "tuna" ? "tuna, canned in water" : id, row])),
});

describe("history scores (D1)", () => {
  it("counts a food for an occasion only after 3 distinct days in 90", () => {
    expect(historyScores(tunaAt(1, 2), TODAY)).toEqual({});
    // Two logs on one day are one day.
    expect(historyScores([...tunaAt(1, 2), ...tunaAt(2)], TODAY)).toEqual({});
    expect(historyScores(tunaAt(1, 2, 3), TODAY).tuna?.breakfast).toBeGreaterThan(0.85);
  });

  it("reads a bounded 90-day window, today inclusive", () => {
    expect(historyWindowStart(TODAY)).toBe(daysAgo(89));
    expect(historyScores(tunaAt(1, 2, 90), TODAY)).toEqual({});
    expect(historyScores(tunaAt(1, 2, 89), TODAY).tuna?.breakfast).toBeDefined();
    // A future-dated row is not history.
    expect(historyScores([...tunaAt(1, 2), { food: "tuna", occasion: "breakfast", localDate: "2026-10-09" }], TODAY))
      .toEqual({});
  });

  it("weighs recent days above old ones, and more days above fewer", () => {
    const recent = historyScores(tunaAt(1, 2, 3), TODAY).tuna?.breakfast ?? 0;
    const old = historyScores(tunaAt(80, 81, 82), TODAY).tuna?.breakfast ?? 0;
    const daily = historyScores(tunaAt(...Array.from({ length: 30 }, (_, i) => i)), TODAY).tuna?.breakfast ?? 0;
    expect(recent).toBeGreaterThan(old);
    expect(daily).toBeGreaterThan(recent);
    expect(daily).toBeLessThanOrEqual(1);
    expect(old).toBeGreaterThanOrEqual(0.75);
  });

  it("keeps occasions apart: tuna at lunch says nothing about breakfast", () => {
    const logs: HistoryLog[] = [1, 2, 3].map((age) => ({ food: "tuna", occasion: "lunch", localDate: daysAgo(age) }));
    expect(historyScores(logs, TODAY)).toEqual({ tuna: { lunch: expect.any(Number) } });
  });
});

describe("acceptance 1: history supports an anchor, pairing still picks the side", () => {
  const ACCOUNT = eats(F.eggs, F.yogurt, F.toast, F.tuna, F.banana, F.oliveOil);
  const input = { date: TODAY, slot: "meal-1", occasion: "breakfast" as const, target: BREAKFAST, foods: ACCOUNT };
  const anchorOf = (plate: { rows: { part: string; food: { id: string } }[] }) =>
    plate.rows.find((row) => row.part === "anchor")?.food.id;

  it("without tuna-at-breakfast history, eggs or yogurt anchor 07:30 above tuna", () => {
    const { plates } = rankPlates(input);
    expect(["eggs", "yogurt"]).toContain(anchorOf(plates[0]));
    expect(affinity(F.tuna, "breakfast").source).toBe("curated");
    // Two days are not history: nothing changes.
    const two = evidenceFrom(historyScores(tunaAt(1, 2), TODAY));
    expect(affinity(F.tuna, "breakfast", false, two)).toEqual(affinity(F.tuna, "breakfast"));
  });

  it("with 3 days of tuna at breakfast, tuna may anchor breakfast, with a paired side and never banana", () => {
    const evidence = evidenceFrom(historyScores(tunaAt(1, 3, 5), TODAY));
    const aff = affinity(F.tuna, "breakfast", false, evidence);
    expect(aff.source).toBe("history");
    expect(aff.score).toBeGreaterThan(affinity(F.tuna, "breakfast").score);
    // History never lowers a usual food, and never applies to an untimed slot.
    expect(affinity(F.eggs, "breakfast", false, evidence)).toEqual(affinity(F.eggs, "breakfast"));
    expect(affinity(F.tuna, "breakfast", true, evidence)).toEqual(affinity(F.tuna, "breakfast", true));

    const { plates } = rankPlates({ ...input, evidence });
    const tuna = plates.filter((plate) => anchorOf(plate) === "tuna");
    expect(tuna.length).toBeGreaterThan(0);
    expect(tuna[0].affinity.source).toBe("history");
    // Ranked among the usual breakfast anchors now, not below them.
    expect(tuna[0].score).toBeGreaterThan(rankPlates(input).plates.find((plate) => anchorOf(plate) === "tuna")?.score ?? 0);
    // Pairing is unchanged by history: tuna has no fruit, so banana stays below the floor.
    expect(pairScore(F.tuna, F.banana, "fruit", "breakfast", "breakfast").score).toBeLessThan(PAIR_FLOOR);
    for (const plate of tuna) expect(plate.rows.map((row) => row.food.id)).not.toContain("banana");
    expect(tuna[0].rows.map((row) => row.food.id)).toContain("toast");
  });

  it("with only tuna and banana in Eats, history still never makes a tuna-and-banana plate", () => {
    const evidence = evidenceFrom(historyScores(tunaAt(1, 3, 5), TODAY));
    const { plates, shortage } = rankPlates({ ...input, foods: eats(F.tuna, F.banana), evidence });
    expect(plates.filter((plate) => plate.rows.some((row) => row.food.id === "banana")
      && anchorOf(plate) === "tuna")).toEqual([]);
    expect(shortage?.missing).toContain("starch");
  });
});
