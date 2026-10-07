/**
 * Phase 19 §6.2 / R2: the copy table, tested directly against its already-decided numbers and
 * cards — no fixtures, no resolveDay, so a wording change here never needs a day to prove it.
 * DRAFT pending the D6 clinical review (see lib/rebalance/copy.ts).
 */
import { describe, expect, it } from "vitest";
import { copyFor } from "./copy";
import type { RebalancePanelCard, RebalancePanelNumbers } from "./panel";

const NUMBERS: RebalancePanelNumbers = {
  targetKcal: 2000, recordedKcal: 0, leftKcal: null, plannedKcal: null,
  intake: { status: "incomplete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false },
  proteinTargetG: null, proteinConsumedG: null,
};

const card = (slot: string, status: "missed" | "remaining", label = "Lunch"): RebalancePanelCard =>
  ({ slot: slot as RebalancePanelCard["slot"], label, time: "12:30", kcal: 600, status, highlight: false });

describe("copyFor", () => {
  it("no_target: a bare headline, no sub", () => {
    expect(copyFor("no_target", NUMBERS, [])).toEqual({ headline: "Set up your targets", sub: [] });
  });

  it("incomplete_intake: only the applicable lines, singular", () => {
    const copy = copyFor("incomplete_intake", { ...NUMBERS, recordedKcal: 300,
      intake: { status: "incomplete", estimatedSlots: 1, unknownSlots: 1, unknownItems: 1, unknownEntries: 0, partial: true } },
    []);
    expect(copy.headline).toBe("Intake is not fully known");
    expect(copy.sub).toEqual([
      "At least 300 kcal accounted for",
      "1 eaten meal is an estimate",
      "1 eaten meal has no calorie record",
      "1 logged food has no calorie value",
      "A recipe is only partly measured",
    ]);
  });

  it("incomplete_intake: plural at n = 2, and omits a line at 0", () => {
    const copy = copyFor("incomplete_intake", { ...NUMBERS, recordedKcal: 0,
      intake: { status: "incomplete", estimatedSlots: 2, unknownSlots: 2, unknownItems: 1, unknownEntries: 1, partial: false } },
    []);
    expect(copy.sub).toEqual([
      "2 eaten meals are an estimate",
      "2 eaten meals have no calorie record",
      "2 logged foods have no calorie value",
    ]);
  });

  it("incomplete_intake: nothing recorded and nothing unknown gives no sub lines", () => {
    expect(copyFor("incomplete_intake", NUMBERS, []).sub).toEqual([]);
  });

  it("on_track: the left figure", () => {
    const copy = copyFor("on_track", { ...NUMBERS, leftKcal: 400,
      intake: { ...NUMBERS.intake, status: "complete" } }, []);
    expect(copy).toEqual({ headline: "On track", sub: ["400 kcal left"] });
  });

  it("under: names the missed card when one exists, else no sub", () => {
    const withMissed = copyFor("under", { ...NUMBERS, leftKcal: 300 },
      [card("meal-2", "missed", "Lunch"), card("meal-3", "remaining", "Dinner")]);
    expect(withMissed).toEqual({ headline: "300 kcal left today", sub: ["Lunch went by"] });
    const withoutMissed = copyFor("under", { ...NUMBERS, leftKcal: 300 }, [card("meal-3", "remaining", "Dinner")]);
    expect(withoutMissed).toEqual({ headline: "300 kcal left today", sub: [] });
  });

  it("over: the plan's figure above target", () => {
    const copy = copyFor("over", { ...NUMBERS, plannedKcal: 2250 }, []);
    expect(copy).toEqual({ headline: "Your plan comes to 250 kcal over",
      sub: ["You can open a meal below to clear or change it"] });
  });

  it("spent: the recorded figure above target", () => {
    const copy = copyFor("spent", { ...NUMBERS, recordedKcal: 2140 }, []);
    expect(copy).toEqual({ headline: "140 kcal past today's target", sub: ["Tomorrow starts fresh"] });
  });

  it("no_action: a fixed line, never a figure", () => {
    expect(copyFor("no_action", NUMBERS, [])).toEqual({
      headline: "Nothing left to change today", sub: ["Tomorrow starts fresh"],
    });
  });

  it("never says fix or make up for (R11)", () => {
    const states = ["no_target", "incomplete_intake", "on_track", "under", "over", "spent", "no_action"] as const;
    for (const state of states) {
      const copy = copyFor(state, { ...NUMBERS, leftKcal: 100, plannedKcal: 2100, recordedKcal: 2100 },
        [card("meal-2", "missed")]);
      const body = `${copy.headline} ${copy.sub.join(" ")}`.toLowerCase();
      expect(body).not.toMatch(/\bfix\b/);
      expect(body).not.toMatch(/make up for/);
    }
  });
});
