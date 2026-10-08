/**
 * Phase 18 W11 through the live phone generators (Sol W11 r1 BLOCK 1): the account's held
 * shopping focus (lib/shopping/focus-client.ts) reaches `resolveDay` and the swap sheet through the
 * verified eligible set, for a closed account too (D7: every generator). Off, nothing changes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { StampedEligibleSet } from "@/lib/foods/eligible-client";
import { focusOf, foodRulesKey } from "@/lib/foods/rule-marks";
import { foodRulesEpoch } from "@/lib/foods/rules-epoch";
import { foodKey } from "@/lib/meals/parts";
import { resolveDay } from "@/lib/resolve";
import { forgetShoppingFocus, holdShoppingFocus } from "@/lib/shopping/focus-client";
import { defaultStore } from "@/lib/store";
import { swapAlternatives } from "@/lib/today/swap-alternatives";
import type { Food } from "@/lib/foods";
import type { FoodComponent, SlotId, Store } from "@/lib/types";
import { F } from "@/tests/helpers/meal-foods";

const DATE = "2026-10-04";
const ACCOUNT = "00000000-0000-4000-8000-0000000000c1";
const macros = { kcal: 1800, protein: 120, carbs: 190, fat: 60 };
const FOODS = [F.eggs, F.yogurt, F.oats, F.toast, F.tuna, F.chicken, F.tofu, F.banana, F.rice, F.broccoli, F.oliveOil];

function account(foods: Food[], accountId?: string): { store: Store; eligible: StampedEligibleSet } {
  const store = defaultStore();
  store.foods = Object.fromEntries(foods.map((food) => [food.id, { ...food }]));
  store.settings = { ...store.settings, onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
    ruleReviewReady: true, mealsPerDay: 3, activeTargetProfile: { revision: 1, training: macros, rest: macros,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  const eligible = new StampedEligibleSet(foods.map((food) => food.id), new Map(), foodRulesKey(store.settings),
    foodRulesEpoch(), undefined, Date.now(), accountId);
  return { store, eligible };
}

const anchorOf = (components: FoodComponent[]) => components.find((part) => part.role === "protein")?.name;
const everythingBut = (...names: string[]) => FOODS.map(foodKey).filter((key) => !names.includes(key))
  .map((key) => ({ key, from: DATE, to: DATE }));

afterEach(() => forgetShoppingFocus());

describe("W11: focus reaches resolveDay and the swap sheet", () => {
  it("re-plans the day toward list foods while focus is on, and back when it is off", () => {
    const { store, eligible } = account(FOODS, ACCOUNT);
    const plain = resolveDay(store, DATE, 0, eligible).slots.map((slot) => anchorOf(slot.components));
    const plainKeys = plain.filter((name): name is string => Boolean(name)).map((name) => name.toLowerCase());
    holdShoppingFocus(ACCOUNT, { until: "2099-01-01T00:00:00.000Z", keys: everythingBut(...plainKeys) });
    expect(focusOf(eligible, DATE)).toBeDefined();
    const focused = resolveDay(store, DATE, 0, eligible).slots.map((slot) => anchorOf(slot.components));
    expect(focused.filter(Boolean).length).toBe(plain.filter(Boolean).length);
    for (const name of focused.filter(Boolean)) expect(plainKeys).not.toContain((name as string).toLowerCase());

    holdShoppingFocus(ACCOUNT, { until: null, keys: [] });
    expect(focusOf(eligible, DATE)).toBeUndefined();
    expect(resolveDay(store, DATE, 0, eligible).slots.map((slot) => anchorOf(slot.components))).toEqual(plain);
  });

  it("ranks the swap sheet's generated rows by coverage", () => {
    const { store, eligible } = account(FOODS, ACCOUNT);
    const input = { slot: "meal-2" as SlotId, target: { kcal: 650, protein: 45, carbs: 70, fat: 20 }, foods: store.foods,
      clock: "12:30", date: DATE, eligible };
    const plainFirst = swapAlternatives(input)[0];
    holdShoppingFocus(ACCOUNT, { until: "2099-01-01T00:00:00.000Z",
      keys: everythingBut(foodKey(F.chicken), foodKey(F.tuna)) });
    const first = swapAlternatives(input)[0];
    expect(first).toBeDefined();
    expect(first.name).not.toBe(plainFirst.name);
    expect(first.name.toLowerCase()).not.toContain("chicken");
    expect(first.name.toLowerCase()).not.toContain("tuna");
  });

  it("a focus held for another account, or a set with no account, changes nothing", () => {
    holdShoppingFocus("someone-else", { until: "2099-01-01T00:00:00.000Z", keys: everythingBut() });
    const mine = account(FOODS, ACCOUNT);
    const anonymous = account(FOODS);
    expect(focusOf(mine.eligible, DATE)).toBeUndefined();
    expect(focusOf(anonymous.eligible, DATE)).toBeUndefined();
  });
});
