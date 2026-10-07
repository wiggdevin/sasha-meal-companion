// Phase 17 O4 (acceptance 10): the period planner places meal coverage by each slot's real clock,
// not by a fixed breakfast = meal-1 mapping, and prefers recipes whose meal type fits the slot.
import { describe, expect, it } from "vitest";
import {
  confirmFallbacks, describeFallbacks, parseCoverage, placeCoverage, scheduleMealCount, slotClocksFor,
  type CoverageLabel, type PlanSchedule,
} from "@/lib/shopping/coverage";
import { planShoppingPeriod } from "@/lib/shopping/planner";
import { ingredient, recipe } from "../recipes/fixture";
import { identity, identityFor, period } from "./fixture";

const labels = (...words: string[]) => words.map((word) => parseCoverage(word)!) as CoverageLabel[];
const standard: PlanSchedule = { mealCount: 3, slotTimes: {}, shiftMinutes: 0 };
/** A late riser: meal-1 at 10:30 is lunch, meal-2 at 15:30 a snack, meal-3 at 19:00 dinner. */
const lateRiser: PlanSchedule = { mealCount: 3,
  slotTimes: { "meal-1": "10:30", "meal-2": "15:30", "meal-3": "19:00" }, shiftMinutes: 0 };

describe("coverage by the slot's clock", () => {
  it("reads the schedule, the shift and a date's own time edit", () => {
    expect(slotClocksFor(standard).map((row) => [row.slotId, row.time, row.occasion])).toEqual([
      ["meal-1", "08:00", "breakfast"], ["meal-2", "12:30", "lunch"], ["meal-3", "18:30", "dinner"]]);
    expect(slotClocksFor({ ...standard, shiftMinutes: 150 })[0]).toMatchObject({ time: "10:30", occasion: "lunch" });
    expect(slotClocksFor(standard, { "meal-1": { time: "11:00" } })[0])
      .toMatchObject({ time: "11:00", occasion: "lunch" });
    expect(slotClocksFor(standard, { "meal-1": { time: "late" } })[0]).toMatchObject({ time: "08:00" });
  });

  it("puts lunch in meal-1 when meal-1 is at 10:30", () => {
    const placed = placeCoverage(labels("lunch", "dinner"), "2026-10-01", slotClocksFor(lateRiser));
    expect(placed.slots.map((row) => [row.slotId, row.occasion])).toEqual([["meal-1", "lunch"], ["meal-3", "dinner"]]);
    expect(placed.fallbacks).toEqual([]);
  });

  it("falls back explicitly when no slot is at that meal's time", () => {
    const placed = placeCoverage(labels("breakfast", "dinner"), "2026-10-01", slotClocksFor(lateRiser));
    // No breakfast-time slot: the old fixed slot (meal-1, here a lunch) is used, and said so.
    expect(placed.slots.map((row) => row.slotId)).toEqual(["meal-1", "meal-3"]);
    expect(placed.fallbacks).toEqual([{ localDate: "2026-10-01", occasion: "breakfast", slotId: "meal-1" }]);
    const none = placeCoverage(labels("snack"), "2026-10-01", slotClocksFor(standard));
    expect(none).toEqual({ slots: [], fallbacks: [{ localDate: "2026-10-01", occasion: "snack", slotId: null }] });
    expect(describeFallbacks([...placed.fallbacks, { localDate: "2026-10-02", occasion: "breakfast", slotId: "meal-1" },
      ...none.fallbacks])).toEqual([
      "No meal in your schedule falls at breakfast time on 2026-10-01, 2026-10-02; breakfast is planned in Meal 1 instead.",
      "Snack is not planned on 2026-10-01: no free meal in your schedule falls at snack time.",
    ]);
  });

  it("assigns slots one to one: a fallback never takes a slot another meal word matched", () => {
    // Review round 1 BLOCK 1: lunch matches meal-1 (10:30), so breakfast may not fall back onto it.
    const placed = placeCoverage(labels("breakfast", "lunch"), "2026-10-01", slotClocksFor(lateRiser));
    expect(placed.slots.map((row) => [row.slotId, row.occasion])).toEqual([["meal-1", "lunch"]]);
    expect(placed.fallbacks).toEqual([{ localDate: "2026-10-01", occasion: "breakfast", slotId: null }]);
    expect(describeFallbacks(placed.fallbacks)).toEqual([
      "Breakfast is not planned on 2026-10-01: no free meal in your schedule falls at breakfast time."]);
    // Order of the words does not matter.
    expect(placeCoverage(labels("lunch", "breakfast"), "2026-10-01", slotClocksFor(lateRiser))).toEqual(placed);
    // A named slot that IS the meal covers the word: one meal, no fallback.
    expect(placeCoverage(labels("meal-1", "breakfast"), "2026-10-01", slotClocksFor(standard)))
      .toMatchObject({ slots: [{ slotId: "meal-1" }], fallbacks: [] });
    // A named slot is never taken by a fallback either.
    const named = placeCoverage(labels("meal-1", "breakfast"), "2026-10-01", slotClocksFor(lateRiser));
    expect(named.slots.map((row) => row.slotId)).toEqual(["meal-1"]);
    expect(named.fallbacks).toEqual([{ localDate: "2026-10-01", occasion: "breakfast", slotId: null }]);
  });

  it("names a fallback as planned only once a recipe fills its slot (review round 2 WARN 3)", () => {
    const fallbacks = [{ localDate: "2026-10-01", occasion: "breakfast" as const, slotId: "meal-1" },
      { localDate: "2026-10-02", occasion: "breakfast" as const, slotId: "meal-1" }];
    const confirmed = confirmFallbacks(fallbacks, new Set(["2026-10-01:meal-1"]));
    expect(describeFallbacks(confirmed)).toEqual([
      "No meal in your schedule falls at breakfast time on 2026-10-01; breakfast is planned in Meal 1 instead.",
      "Breakfast is not planned on 2026-10-02: no free meal in your schedule falls at breakfast time."]);
  });

  it("picks the slot nearest the meal's usual time when two share an occasion", () => {
    const six: PlanSchedule = { mealCount: 6, slotTimes: {}, shiftMinutes: 0 };
    // 07:00 and 09:30 are both breakfast; 17:00 and 19:30 both dinner.
    const placed = placeCoverage(labels("breakfast", "dinner"), "2026-10-01", slotClocksFor(six));
    expect(placed.slots.map((row) => row.slotId)).toEqual(["meal-1", "meal-6"]);
  });

  it("keeps slot ids, rejects unknown words, and counts meals as Today does", () => {
    expect(parseCoverage("Meal-2")).toEqual({ kind: "slot", slotId: "meal-2" });
    expect(parseCoverage("brunch")).toBeNull();
    expect(scheduleMealCount(5, 1500)).toBe(5);
    expect(scheduleMealCount(null, 2400)).toBe(4);
    expect(scheduleMealCount(null, null)).toBe(3);
  });
});

const candidate = (partial: Parameters<typeof recipe>[0]) =>
  ({ ...recipe(partial), eligibility: { status: "eligible" as const, reasons: [] } });
const oats = candidate({ recipeId: "oats", revisionId: "oats-v1", name: "Overnight oats",
  dishTags: ["oats", "breakfast"], ingredients: [ingredient({ seq: 1, name: "oats" })] });
const steak = candidate({ recipeId: "steak", revisionId: "steak-v1", name: "Steak bowl",
  dishTags: ["beef", "lunch"], ingredients: [ingredient({ seq: 1, name: "beef" })] });

describe("the planner prefers the slot's meal type", () => {
  const plan = (occasion: "breakfast" | "lunch", candidates = [oats, steak]) => planShoppingPeriod({
    period: period({ endDate: "2026-10-01" }), basket: [], pins: [], aggregate: { identityFor },
    slots: [{ localDate: "2026-10-01", slotId: "meal-1", targetKcal: null, occasion }], candidates });

  it("puts a breakfast recipe in a breakfast slot and a lunch recipe in a lunch slot", () => {
    expect(plan("breakfast").choices[0].recipe.name).toBe("Overnight oats");
    // meal-1 at 10:30 is lunch: the same slot id now gets the lunch recipe.
    expect(plan("lunch").choices[0].recipe.name).toBe("Steak bowl");
  });

  it("still fills the slot when no recipe fits its meal, and says so (no new prohibition)", () => {
    const result = plan("breakfast", [steak]);
    expect(result.choices[0].recipe.name).toBe("Steak bowl");
    expect(result.unfilledSlots).toEqual([]);
    expect(result.compromise).toContain("No breakfast recipe fit Meal 1 on 2026-10-01; it gets Steak bowl instead.");
  });

  it("says nothing about a missing breakfast when one was feasible but lost on pins and basket", () => {
    // Review round 1 WARN 3.
    const result = planShoppingPeriod({ period: period({ endDate: "2026-10-01" }),
      basket: [identity("beef")], pins: [identity("beef")], aggregate: { identityFor },
      slots: [{ localDate: "2026-10-01", slotId: "meal-1", targetKcal: null, occasion: "breakfast" }],
      candidates: [oats, steak] });
    expect(result.choices[0].recipe.name).toBe("Steak bowl");
    expect(result.compromise.some((line) => line.startsWith("No breakfast recipe"))).toBe(false);
  });
});
