/**
 * A061 (owner decision 2026-10-11, "build quick plates"): a date marked "Quick meals" generates
 * quick plates. Each slot takes a plate ready in 15 minutes (lib/plan/prep-minutes.ts) when one
 * fits it; otherwise the day keeps the plate it had. Ranking only: no food enters or leaves the
 * pool, protein never softens, and a date without the mark is byte-identical to main's day.
 */
import { describe, expect, it } from "vitest";
import { planDay, type DaySlot, type QuickRanking } from "@/lib/meals/day";
import { planMealsForDay } from "@/lib/foods/layout-plan";
import { rankPlates } from "@/lib/meals/plate";
import { plateMinutes, QUICK_MINUTES } from "@/lib/plan/prep-minutes";
import type { Food } from "@/lib/foods";
import type { Plate } from "@/lib/meals/plate";
import { BREAKFAST, eats, F, MAIN } from "@/tests/helpers/meal-foods";

const QUICK: QuickRanking = { maxMinutes: QUICK_MINUTES, minutesOf: plateMinutes };
const minutes = (plate: Plate) => plateMinutes(plate.rows.map((row) => row.food));
const quickFit = (plate: Plate) => plate.fits && minutes(plate) <= QUICK_MINUTES;
const quickDay = (date: string, slots: DaySlot[], foods: Record<string, Food>) =>
  planDay(date, slots, foods, undefined, undefined, undefined, undefined, undefined, undefined, QUICK);

const SLOTS: DaySlot[] = [
  { id: "meal-1", target: BREAKFAST, clock: "07:30" },
  { id: "meal-2", target: MAIN, clock: "12:30" },
  { id: "meal-3", target: MAIN, clock: "19:00" },
];
const MIXED = eats(F.eggs, F.yogurt, F.oats, F.toast, F.tuna, F.chicken, F.tofu, F.banana, F.rice,
  F.broccoli, F.oliveOil, F.bread, F.tomato, F.lentils);
const DATES = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));

describe("A061: a Quick meals date generates quick plates", () => {
  it("swaps a slow plate for a quick one that fits", () => {
    let swapped = 0;
    for (const date of DATES) {
      const plain = planDay(date, SLOTS, MIXED);
      const quick = quickDay(date, SLOTS, MIXED);
      expect(quick.plates.map(({ slot }) => slot)).toEqual(plain.plates.map(({ slot }) => slot));
      quick.plates.forEach(({ plate }, i) => {
        if (!quickFit(plain.plates[i].plate) && quickFit(plate)) swapped += 1;
      });
      const count = (plates: typeof plain.plates) => plates.filter(({ plate }) => quickFit(plate)).length;
      expect(count(quick.plates)).toBeGreaterThanOrEqual(count(plain.plates));
    }
    expect(swapped).toBeGreaterThan(0);
  });

  it("takes a fitting quick plate in every slot that has one", () => {
    for (const date of DATES) {
      const quick = quickDay(date, SLOTS, MIXED);
      for (const { slot, plate } of quick.plates) {
        const row = SLOTS.find((entry) => entry.id === slot) as DaySlot;
        const anyQuick = rankPlates({ date, slot, occasion: plate.occasion, target: row.target,
          foods: Object.values(MIXED) }).plates.some(quickFit);
        if (anyQuick) expect(quickFit(plate), `${date} ${slot}`).toBe(true);
      }
    }
  });

  it("never softens protein: a slot that fit before still fits", () => {
    for (const date of DATES) {
      const plain = planDay(date, SLOTS, MIXED);
      const quick = quickDay(date, SLOTS, MIXED);
      plain.plates.forEach(({ plate }, i) => {
        if (plate.fits) expect(quick.plates[i].plate.fits, `${date} ${plate.name}`).toBe(true);
        const target = SLOTS[i].target;
        if (plate.macros.protein >= target.protein * 0.9) {
          expect(quick.plates[i].plate.macros.protein).toBeGreaterThanOrEqual(target.protein * 0.9);
        }
      });
    }
  });

  it("keeps the normal plate when no quick plate fits (no empty slot)", () => {
    const slow = eats(F.chicken, F.lentils, F.rice, F.broccoli, F.oliveOil);
    for (const date of DATES.slice(0, 7)) {
      const plain = planDay(date, SLOTS.slice(1), slow);
      expect(plain.plates.some(({ plate }) => quickFit(plate))).toBe(false);
      expect(JSON.stringify(quickDay(date, SLOTS.slice(1), slow))).toBe(JSON.stringify(plain));
    }
  });

  it("only re-orders the pool: every food on a quick day is one the plain pool offered", () => {
    const pool = new Set(Object.keys(MIXED));
    for (const date of DATES) {
      for (const { plate } of quickDay(date, SLOTS, MIXED).plates) {
        for (const row of plate.rows) expect(pool.has(row.food.id)).toBe(true);
      }
    }
  });

  it("is byte-identical without the mark", () => {
    for (const date of DATES.slice(0, 5)) {
      const plain = JSON.stringify(planDay(date, SLOTS, MIXED));
      expect(JSON.stringify(planDay(date, SLOTS, MIXED, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined))).toBe(plain);
      expect(JSON.stringify(planMealsForDay(date, SLOTS, MIXED, undefined, undefined, undefined, undefined, null,
        false))).toBe(JSON.stringify(planMealsForDay(date, SLOTS, MIXED)));
    }
  });

  it("planMealsForDay passes the mark through and keeps the two days apart in its memo", () => {
    const changed = DATES.find((date) => JSON.stringify(planDay(date, SLOTS, MIXED))
      !== JSON.stringify(quickDay(date, SLOTS, MIXED))) as string;
    expect(changed).toBeDefined();
    const plain = planMealsForDay(changed, SLOTS, MIXED);
    const quick = planMealsForDay(changed, SLOTS, MIXED, undefined, undefined, undefined, undefined, null, true);
    expect(quick.meals.map(({ meal }) => meal.name)).not.toEqual(plain.meals.map(({ meal }) => meal.name));
    expect(quick.meals.map(({ meal }) => meal.name))
      .toEqual(quickDay(changed, SLOTS, MIXED).plates.map(({ plate }) => plate.name));
    expect(planMealsForDay(changed, SLOTS, MIXED)).toEqual(plain);
  });
});
