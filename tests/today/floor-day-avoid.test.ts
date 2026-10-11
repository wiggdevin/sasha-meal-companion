/**
 * W021 (audit 2026-10-10, backlog B105 and B221): two safety verdicts, closed with tests as proof.
 *
 * B105, Floor Day: the phase-9 tenancy plan feared that Floor Day's slot-keyed meals bypass the
 * Avoid check. Today the Floor Day flag ("Quick meals") never substitutes the fixed
 * `FLOOR_DAY_MEALS` template: `resolveDay` builds every layout slot from the account's admitted
 * foods, and a slot-keyed meal saved on that day is a saved line, judged against the CURRENT rules
 * like any other (the saved-content rule, lib/foods/rule-marks.ts).
 *
 * B221 F1: a low-FODMAP account's food with no stored policy category reads `unknown` for onion,
 * garlic and beans (so the food is `unverified`), never `absent` on the strength of its name.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveDay } from "@/lib/resolve";
import { defaultSettings, defaultStore } from "@/lib/store";
import { FLOOR_DAY_MEALS } from "@/lib/meals";
import { StampedEligibleSet } from "@/lib/foods/eligible-client";
import { foodRulesEpoch, resetFoodRulesMemoryForTests } from "@/lib/foods/rules-epoch";
import { foodRulesKey } from "@/lib/foods/rule-marks";
import { EMPTY_PROFILE, evaluatePolicy, type PolicyEvidence } from "@/lib/policy/constraints";
import { preferenceMarks } from "@/lib/policy/preference-marks";
import type { Food } from "@/lib/foods";
import type { FoodComponent, RuleMark, Store, StoredDay } from "@/lib/types";
import { F } from "@/tests/helpers/meal-foods";

const DAY = "2026-10-06";
const MACROS = { kcal: 1800, protein: 120, carbs: 190, fat: 60 };

const food = (id: string, name: string, status: Food["status"] = "eats"): Food => ({
  id, name, role: "protein", unit: "whole", perUnit: { protein: 6, carbs: 0, fat: 5 },
  status, updatedAt: "2026-10-01",
});

const line = (name: string): FoodComponent => ({ name, qty: 4, unit: "whole", role: "protein",
  macros: { kcal: 280, protein: 24, carbs: 0, fat: 20 } });

function storeWith(day: Partial<StoredDay>, foods: Food[]): Store {
  return { version: 1, firstOpenedAt: "2026-08-01T12:00:00.000Z", settings: defaultSettings(),
    days: { [DAY]: { date: DAY, ...day } },
    foods: Object.fromEntries(foods.map((entry) => [entry.id, entry])) };
}

/** The Floor Day template's own meal for Meal 1, saved under that slot on a Floor Day. */
const floorMeal = FLOOR_DAY_MEALS.find((entry) => entry.slot === "meal-1")!;
const floorDaySaved = (components: FoodComponent[]): Partial<StoredDay> => ({
  floorDay: true,
  itemOverrides: { "meal-1": { baseMealId: floorMeal.id, title: floorMeal.name, components } },
});

const stamped = (ids: string[], marks: [string, RuleMark][] = []) =>
  new StampedEligibleSet(ids, new Map(marks), foodRulesKey(defaultSettings()), foodRulesEpoch());

const slotOf = (store: Store, slot: string, eligible?: ReadonlySet<string>) =>
  resolveDay(store, DAY, 0, eligible).slots.find((entry) => entry.slot === slot);

/** An onboarded account with a target revision and admitted foods (eggs on Avoid). */
function readyStore(): { store: Store; eligible: Set<string> } {
  const store = defaultStore();
  const foods = [{ ...F.eggs, status: "avoid" as const }, F.yogurt, F.oats, F.toast, F.tuna, F.banana,
    F.rice, F.broccoli, F.oliveOil];
  store.foods = Object.fromEntries(foods.map((entry) => [entry.id, entry]));
  store.settings = { ...store.settings, onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
    ruleReviewReady: true, mealsPerDay: 3, activeTargetProfile: { revision: 1, training: MACROS,
      rest: MACROS, pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  const eligible = new Set(foods.filter((entry) => entry.status === "eats").map((entry) => entry.id));
  return { store, eligible };
}

afterEach(() => resetFoodRulesMemoryForTests());

describe("Floor Day honours Avoid (B105)", () => {
  it("marks an Avoid food in a Floor Day slot-keyed meal as blocked, and keeps the line", () => {
    const store = storeWith(floorDaySaved([line("Eggs")]), [food("eggs", "Eggs", "avoid")]);
    // The set still lists the food: it was verified before the Avoid mark.
    const resolved = slotOf(store, "meal-1", stamped(["eggs"]));
    expect(resolveDay(store, DAY, 0, stamped(["eggs"])).isFloorDay).toBe(true);
    expect(resolved?.components.map((part) => part.name)).toEqual(["Eggs"]);
    expect(resolved?.ruleMark).toEqual({ verdict: "blocked", reason: "Eggs is on your Avoid list." });
    expect(resolved?.componentRuleMarks).toEqual([resolved?.ruleMark]);
  });

  it("marks a Floor Day line the server now excludes, and one no verified food backs", () => {
    const allergy: RuleMark = { verdict: "blocked", reason: "has egg, which your rules exclude." };
    const store = storeWith(floorDaySaved([line("Eggs"), line("Banana")]), [food("eggs", "Eggs")]);
    const marks = slotOf(store, "meal-1", stamped([], [["eggs", allergy]]))?.componentRuleMarks;
    expect(marks?.[0]).toEqual({ verdict: "blocked", reason: "Eggs has egg, which your rules exclude." });
    expect(marks?.[1]).toMatchObject({ verdict: "unknown" });
  });

  it("never substitutes the fixed Floor Day template: the day is the account's own plates", () => {
    const { store, eligible } = readyStore();
    const usual = resolveDay(store, DAY, 0, eligible);
    store.days[DAY] = { date: DAY, floorDay: true };
    const floor = resolveDay(store, DAY, 0, eligible);
    expect(floor.isFloorDay).toBe(true);
    expect(floor.slots.filter((slot) => slot.meal !== null).length).toBeGreaterThan(0);
    const templateIds = new Set(FLOOR_DAY_MEALS.map((entry) => entry.id));
    for (const slot of floor.slots) {
      expect(slot.meal?.tags ?? []).not.toContain("floor-day");
      expect(templateIds.has(slot.meal?.id ?? "")).toBe(false);
      // The Avoid food never reaches a generated plate, Floor Day or not.
      expect(slot.components.map((part) => part.name)).not.toContain(F.eggs.name);
    }
    expect(floor.slots).toEqual(usual.slots);
  });

  it("does not render a Floor Day template id stored as a meal-slot swap", () => {
    const { store, eligible } = readyStore();
    store.days[DAY] = { date: DAY, floorDay: true, swaps: { "meal-1": floorMeal.id } };
    const slot = slotOf(store, "meal-1", eligible);
    // A generated plate stands in the slot, so the negative checks below test a real meal.
    expect(slot?.meal).toBeTruthy();
    expect(slot?.meal?.id).not.toBe(floorMeal.id);
    expect(slot?.meal?.tags ?? []).not.toContain("floor-day");
    expect(slot?.components.map((part) => part.name)).not.toContain(F.eggs.name);
  });
});

describe("low FODMAP on an uncategorised food (B221 F1)", () => {
  const evidence = { foodRefId: null, allergenTags: [], foodName: "Meatballs", category: null,
    onEatsList: true, onAvoidList: false } satisfies PolicyEvidence;

  it("reads onion/garlic and beans as unknown, never absent", () => {
    const marks = preferenceMarks(["low_fodmap"], new Set(), evidence);
    expect(marks).toEqual([
      { facet: "onion_garlic", source: "category", outcome: "unknown" },
      { facet: "beans", source: "category", outcome: "unknown" },
    ]);
  });

  it("leaves the food unverified, while a stored clean category clears it", () => {
    const rules = { ...EMPTY_PROFILE };
    expect(evaluatePolicy(rules, { ...evidence, preferenceFlags: ["low_fodmap"] }).verdict)
      .toBe("unverified");
    expect(evaluatePolicy(rules, { ...evidence, category: [], preferenceFlags: ["low_fodmap"] }).verdict)
      .toBe("allowed");
    expect(evaluatePolicy(rules, { ...evidence, category: ["beans"], preferenceFlags: ["low_fodmap"] }))
      .toMatchObject({ verdict: "blocked" });
  });
});
