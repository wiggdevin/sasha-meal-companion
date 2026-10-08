/**
 * Phase 18 W11 (docs/specs/phase-18-open-world-foods.md §W11, D7), acceptance 2 and 3: a checked
 * (or manual) line boosts exactly inside its time box, with explicit day-before/first/last/
 * day-after boundary cases; an unchecked planner line never boosts.
 */
import { describe, expect, it } from "vitest";
import {
  coverageOf, defaultFocusEnd, FOCUS_DEFAULT_DAYS, FOCUS_MAX_DAYS, isUsedLine, lineActiveOn,
  lineBoxEnd, maxFocusEnd, pantryActiveOn, shoppingFocusActive,
} from "@/lib/shopping/focus";
import type { ShoppingPeriod } from "@/lib/shopping/types";

const period: Pick<ShoppingPeriod, "startDate" | "endDate"> = {
  startDate: "2026-10-01", endDate: "2026-10-05",
};
const checked = { checked: true, origin: "manual" as const };
const checkedPlan = { checked: true, origin: "plan" as const };
const uncheckedPlan = { checked: false, origin: "plan" as const };
const uncheckedManual = { checked: false, origin: "manual" as const };

describe("isUsedLine", () => {
  it("is used when checked, or when manual, but not an unchecked planner line", () => {
    expect(isUsedLine(checkedPlan)).toBe(true);
    expect(isUsedLine(uncheckedManual)).toBe(true);
    expect(isUsedLine(uncheckedPlan)).toBe(false);
  });
});

describe("lineBoxEnd", () => {
  it("is the period end plus 3 days when that stays under the 21-day cap", () => {
    expect(lineBoxEnd(period)).toBe("2026-10-08");
  });
  it("caps at 21 days from the period's own start for a long period", () => {
    expect(lineBoxEnd({ startDate: "2026-10-01", endDate: "2026-10-25" })).toBe("2026-10-22");
  });
});

describe("W11 acceptance 2: a checked line boosts exactly inside its time box", () => {
  it("day before the period start: not active", () => {
    expect(lineActiveOn(checked, period, "2026-09-30")).toBe(false);
  });
  it("first day (the period's own start): active", () => {
    expect(lineActiveOn(checked, period, "2026-10-01")).toBe(true);
  });
  it("last day (end + 3 days): active", () => {
    expect(lineActiveOn(checked, period, "2026-10-08")).toBe(true);
  });
  it("day after the box ends: not active", () => {
    expect(lineActiveOn(checked, period, "2026-10-09")).toBe(false);
  });
  it("a manual (never checked) line follows the same box", () => {
    expect(lineActiveOn(uncheckedManual, period, "2026-10-01")).toBe(true);
    expect(lineActiveOn(uncheckedManual, period, "2026-10-09")).toBe(false);
  });
});

describe("W11 acceptance 3: an unchecked planner line never boosts", () => {
  it("stays inactive on every date in and around its own box", () => {
    for (const date of ["2026-09-30", "2026-10-01", "2026-10-05", "2026-10-08", "2026-10-09"]) {
      expect(lineActiveOn(uncheckedPlan, period, date)).toBe(false);
    }
  });
});

describe("pantryActiveOn: the 14-day pantry time box", () => {
  const item = { confirmedAt: "2026-10-01T09:00:00.000Z" };
  it("day before confirmation: not active", () => {
    expect(pantryActiveOn(item, "2026-09-30")).toBe(false);
  });
  it("the confirmation day itself: active", () => {
    expect(pantryActiveOn(item, "2026-10-01")).toBe(true);
  });
  it("day 14 (the last active day): active", () => {
    expect(pantryActiveOn(item, "2026-10-15")).toBe(true);
  });
  it("day 15: not active", () => {
    expect(pantryActiveOn(item, "2026-10-16")).toBe(false);
  });
});

describe("shoppingFocusActive", () => {
  const now = new Date("2026-10-05T12:00:00.000Z");
  it("is off when null, undefined, unparsable or in the past", () => {
    expect(shoppingFocusActive(null, now)).toBe(false);
    expect(shoppingFocusActive(undefined, now)).toBe(false);
    expect(shoppingFocusActive("not a date", now)).toBe(false);
    expect(shoppingFocusActive("2026-10-05T11:59:59.999Z", now)).toBe(false);
  });
  it("is on for a future timestamp, exactly at the boundary too", () => {
    expect(shoppingFocusActive("2026-10-05T12:00:00.001Z", now)).toBe(true);
    expect(shoppingFocusActive("2026-12-01T00:00:00.000Z", now)).toBe(true);
  });
});

describe("defaultFocusEnd / maxFocusEnd", () => {
  const now = new Date("2026-10-05T00:00:00.000Z");
  it("takes the open period's own end when one is open", () => {
    expect(defaultFocusEnd(now, "2026-10-12")).toBe("2026-10-12T23:59:59.999Z");
  });
  it("falls back to FOCUS_DEFAULT_DAYS out with no period open", () => {
    expect(defaultFocusEnd(now, null))
      .toBe(new Date(now.getTime() + FOCUS_DEFAULT_DAYS * 86_400_000).toISOString());
  });
  it("caps at FOCUS_MAX_DAYS out", () => {
    expect(maxFocusEnd(now)).toBe(new Date(now.getTime() + FOCUS_MAX_DAYS * 86_400_000).toISOString());
  });
});

describe("W11 acceptance 1: coverage is the share of plate calories from list/pantry foods", () => {
  const used = new Set(["chicken breast", "rice"]);
  it("rounds to steps of 0.25", () => {
    expect(coverageOf([{ key: "chicken breast", kcal: 300 }, { key: "broccoli", kcal: 100 }], used))
      .toBe(0.75);
    expect(coverageOf([{ key: "chicken breast", kcal: 250 }, { key: "rice", kcal: 250 }], used))
      .toBe(1);
    expect(coverageOf([{ key: "broccoli", kcal: 100 }], used)).toBe(0);
  });
  it("is 0 for a plate with no positive calories, never a divide by zero", () => {
    expect(coverageOf([], used)).toBe(0);
    expect(coverageOf([{ key: "chicken breast", kcal: 0 }], used)).toBe(0);
  });
});
