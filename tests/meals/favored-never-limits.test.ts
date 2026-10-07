/**
 * Phase 18 §9 rule: Favored favors and never limits, in an open food world (W8 acceptance 4), and
 * any date renders a complete day for an open account with no Favored foods, through `resolveDay`
 * itself (the phone's Today path) with an open verified set.
 */
import { describe, expect, it } from "vitest";
import type { Food } from "@/lib/foods";
import { StampedEligibleSet } from "@/lib/foods/eligible-client";
import { planMealsForDay, type LayoutSlot } from "@/lib/foods/layout-plan";
import { foodRulesKey } from "@/lib/foods/rule-marks";
import { foodRulesEpoch } from "@/lib/foods/rules-epoch";
import { livePool, type OpenWorldInputs } from "@/lib/meals/open-world";
import { resolveDay } from "@/lib/resolve";
import { defaultSettings } from "@/lib/store";
import type { Store } from "@/lib/types";
import { device, inputsFor, openSnapshot, overTheWire, ownFood, type OwnFood } from "@/tests/helpers/open-snapshot";

const START = Date.parse("2026-10-06T00:00:00Z");
const dates = (n: number) => Array.from({ length: n }, (_, i) => new Date(START + i * 86_400_000).toISOString().slice(0, 10));
const FOUR: LayoutSlot[] = ["08:00", "12:30", "15:30", "19:00"].map((clock, i) => ({
  id: `meal-${i + 1}` as LayoutSlot["id"], clock, target: { kcal: 500, protein: 35, carbs: 52.5, fat: 16.7 } }));

const CHICKEN = ownFood("11111111-1111-4111-8111-111111111111", "Chicken breast, grilled", "protein", [31, 0, 3.6]);
const YOGURT = ownFood("22222222-2222-4222-8222-222222222222", "Greek yogurt, plain, nonfat", "protein", [10, 3.6, 0.4]);
const TOFU = ownFood("33333333-3333-4333-8333-333333333333", "Tofu, firm", "protein", [17, 3, 9]);

function poolIdsOf(open: OpenWorldInputs, meals: ReturnType<typeof planMealsForDay>["meals"]): string[] {
  const byName = new Map(Object.entries(open.foods).map(([id, food]) => [food.name, id]));
  return meals.flatMap(({ meal }) => meal.components.map((part) => byName.get(part.name) ?? `?${part.name}`));
}

describe("W8 acceptance 4: Favored favors and never limits", () => {
  it("3 Favored proteins over 4 slots and 14 dates: every slot fills and at least one uses a food that is not Favored", () => {
    const favored: OwnFood[] = [CHICKEN, YOGURT, TOFU];
    const open = inputsFor(overTheWire(openSnapshot({ favored })), favored);
    const local = device(favored).foods;
    const favoredIds = new Set(favored.map((row) => row.food.id));
    let nonFavored = 0;
    let favoredUsed = 0;
    for (const date of dates(14)) {
      const plan = planMealsForDay(date, FOUR, livePool(open, local), undefined, open.evidence, open);
      expect([date, plan.shortages]).toEqual([date, []]);
      expect(plan.meals).toHaveLength(4);
      const ids = poolIdsOf(open, plan.meals);
      nonFavored += ids.filter((id) => !favoredIds.has(id)).length;
      favoredUsed += ids.filter((id) => favoredIds.has(id)).length;
    }
    expect(nonFavored).toBeGreaterThan(0);
    expect(favoredUsed).toBeGreaterThan(0);
  });
});

describe("any date renders a complete day: an open account with no Favored foods (resolveDay)", () => {
  const targets = { revision: 3, training: { kcal: 2100, protein: 140, carbs: 220, fat: 70 },
    rest: { kcal: 2000, protein: 140, carbs: 200, fat: 67 }, pins: { trainingKcal: null, restKcal: null, proteinG: null } };
  const store = (foods: Record<string, Food> = {}): Store => ({ version: 1, firstOpenedAt: "2026-09-20T12:00:00Z",
    settings: { ...defaultSettings(), trainingWeekdays: [1], activeTargetProfile: targets, ruleReviewReady: true },
    days: {}, foods });

  it("fills every slot on 30 dates from the admitted universe; the same store closed gets nothing", () => {
    const value = store();
    const open = inputsFor(overTheWire(openSnapshot()));
    const set = new StampedEligibleSet(Object.keys(open.foods), new Map(), foodRulesKey(value.settings),
      foodRulesEpoch(), open.evidence, Date.now(), undefined, new Map(), open);
    const closed = new StampedEligibleSet([], new Map(), foodRulesKey(value.settings), foodRulesEpoch(), undefined);
    for (const date of dates(30)) {
      const day = resolveDay(value, date, 0, set);
      expect(day.slots.length).toBeGreaterThan(0);
      expect([date, day.slots.filter((slot) => slot.meal === null).map((slot) => slot.slot)]).toEqual([date, []]);
      expect(day.slots.every((slot) => (slot.componentRuleMarks ?? []).every((mark) => mark === null))).toBe(true);
      expect(resolveDay(value, date, 0, closed).slots.every((slot) => slot.meal === null)).toBe(true);
    }
  });

  it("a saved line naming an admitted universe food exactly is clear; a near name stays unchecked", () => {
    const value = store();
    const open = inputsFor(overTheWire(openSnapshot()));
    const set = new StampedEligibleSet(Object.keys(open.foods), new Map(), foodRulesKey(value.settings),
      foodRulesEpoch(), open.evidence, Date.now(), undefined, new Map(), open);
    const admitted = Object.values(open.foods)[0];
    const line = (name: string) => ({ name, qty: 100, unit: "g" as const, role: "protein" as const,
      macros: { kcal: 150, protein: 20, carbs: 0, fat: 5 } });
    value.days["2026-10-06"] = { date: "2026-10-06", itemOverrides: { "meal-1": { baseMealId: null, title: "Mine",
      components: [line(admitted.name), line(`${admitted.name.split(",")[0]}, breaded and fried`)] } } };
    const slot = resolveDay(value, "2026-10-06", 0, set).slots.find((row) => row.slot === "meal-1")!;
    expect(slot.componentRuleMarks?.[0]).toBeNull();
    expect(slot.componentRuleMarks?.[1]?.verdict).toBe("unknown");
  });

  it("a revoked open set generates nothing", () => {
    const value = store();
    const open = inputsFor(overTheWire(openSnapshot()));
    const set = new StampedEligibleSet(Object.keys(open.foods), new Map(), foodRulesKey(value.settings),
      foodRulesEpoch() - 1, open.evidence, Date.now(), undefined, new Map(), open);
    expect(resolveDay(value, "2026-10-06", 0, set).slots.every((slot) => slot.meal === null)).toBe(true);
  });
});
