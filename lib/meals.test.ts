import { describe, expect, it } from "vitest";
import { getMealOptions, FLOOR_DAY_MEALS } from "./meals";
import { SLOT_ORDER } from "./plan-legacy";
import type { DayType, FoodComponent, Meal, SlotId } from "./types";

const DAY_TYPES: DayType[] = ["training-10", "training-7-fasted", "rest"];

/** Fixed rituals, not rotations — PRD says these stay single-option. */
const FIXED_SLOTS: SlotId[] = ["coffee", "hot-chocolate"];

const VALID_ROLES: FoodComponent["role"][] = ["protein", "carb", "fat", "free"];

function allMeals(): Meal[] {
  const meals: Meal[] = [];
  for (const dayType of DAY_TYPES) {
    for (const slot of SLOT_ORDER[dayType]) {
      meals.push(...getMealOptions(dayType, slot));
    }
  }
  meals.push(...FLOOR_DAY_MEALS);
  return meals;
}

/**
 * Recursively collect every string value reachable from an object, tagged
 * with a dotted path — so the apple check below can scan name/id/slot/tags/
 * component fields uniformly instead of hardcoding `component.name`.
 */
function collectStrings(value: unknown, path = ""): { path: string; value: string }[] {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => collectStrings(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      collectStrings(v, path ? `${path}.${k}` : k)
    );
  }
  return [];
}

/**
 * Dairy terms that would actually violate the no-dairy constraint. "milk" and
 * "butter" alone are too broad — oat milk, almond milk and almond butter are
 * all explicitly approved — so those two are only flagged when they are NOT
 * part of one of those approved phrases.
 */
function containsDairyTerm(name: string): boolean {
  const lower = name.toLowerCase();
  const rawDairyWords = [
    "cheese",
    "yogurt",
    "yoghurt",
    "parmesan",
    "mozzarella",
    "ricotta",
    "dairy",
    "cream",
    "buttermilk",
    "ghee",
    "whey",
    "casein",
    "kefir",
    "quark",
    "feta",
    "brie",
    "gouda",
    "gruyere",
    "cheddar",
    "provolone",
  ];
  if (rawDairyWords.some((w) => lower.includes(w))) return true;
  if (/\bmilk\b/.test(lower) && !/(oat|almond) milk/.test(lower)) return true;
  // \b prevents "butternut" (butter + nut fused, no word boundary) from false-positiving.
  if (/\bbutter\b/.test(lower) && !/almond butter/.test(lower)) return true;
  return false;
}

function containsGlutenTerm(name: string): boolean {
  const lower = name.toLowerCase();
  const glutenWords = [
    "wheat",
    "gluten",
    "barley",
    "rye",
    "bread",
    "pasta",
    "cracker",
    "flour",
    "seitan",
    "couscous",
    "malt",
    "orzo",
    "farro",
  ];
  return glutenWords.some((w) => lower.includes(w));
}

/** ~8% relative tolerance, with a small absolute floor for tiny targets. */
function withinTolerance(value: number, target: number, pct = 0.08, floor = 2): boolean {
  const allowed = Math.max(Math.abs(target) * pct, floor);
  return Math.abs(value - target) <= allowed;
}

describe("meal library — PRD acceptance criterion 11", () => {
  it("no meal or component field anywhere contains apple (deep scan, case-insensitive)", () => {
    for (const meal of allMeals()) {
      for (const { path, value } of collectStrings(meal)) {
        expect(value.toLowerCase(), `${meal.id} -> ${path} = "${value}"`).not.toContain("apple");
      }
    }
  });
});

describe("meal library — data integrity", () => {
  it("every meal's macros equal the sum of its components (types.ts contract)", () => {
    for (const meal of allMeals()) {
      const summed = meal.components.reduce(
        (acc, c) => ({
          protein: acc.protein + c.macros.protein,
          carbs: acc.carbs + c.macros.carbs,
          fat: acc.fat + c.macros.fat,
        }),
        { protein: 0, carbs: 0, fat: 0 }
      );
      expect(meal.macros.protein).toBe(summed.protein);
      expect(meal.macros.carbs).toBe(summed.carbs);
      expect(meal.macros.fat).toBe(summed.fat);
    }
  });

  it("every slot in SLOT_ORDER has at least one meal for its day type", () => {
    for (const dayType of DAY_TYPES) {
      for (const slot of SLOT_ORDER[dayType]) {
        expect(getMealOptions(dayType, slot).length).toBeGreaterThan(0);
      }
    }
  });

  it("every rotating slot has at least 5 options — the repetition-over-2-months fix", () => {
    for (const dayType of DAY_TYPES) {
      for (const slot of SLOT_ORDER[dayType]) {
        if (FIXED_SLOTS.includes(slot)) continue; // coffee/hot-chocolate stay single-option rituals
        expect(
          getMealOptions(dayType, slot).length,
          `${dayType} / ${slot}`
        ).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("every component carries a valid role", () => {
    for (const meal of allMeals()) {
      for (const component of meal.components) {
        expect(VALID_ROLES, `${meal.id} -> ${component.name}`).toContain(component.role);
      }
    }
  });

  it("no component name contains a gluten or dairy term", () => {
    for (const meal of allMeals()) {
      for (const component of meal.components) {
        expect(containsDairyTerm(component.name), `${meal.id} -> "${component.name}"`).toBe(false);
        expect(containsGlutenTerm(component.name), `${meal.id} -> "${component.name}"`).toBe(false);
      }
    }
  });

  it("containsDairyTerm/containsGlutenTerm catch the same terms bannedReason blocks (no blind spot)", () => {
    for (const dairy of ["Buttermilk", "Buttermilk pancakes", "Ghee", "Whey protein", "Casein"]) {
      expect(containsDairyTerm(dairy), dairy).toBe(true);
    }
    for (const gluten of ["Malt", "Malted hot chocolate", "Couscous", "Couscous salad"]) {
      expect(containsGlutenTerm(gluten), gluten).toBe(true);
    }
  });

  it("PRD §7.3 — every rotation option in a slot hits the same target macros", () => {
    for (const dayType of DAY_TYPES) {
      for (const slot of SLOT_ORDER[dayType]) {
        const options = getMealOptions(dayType, slot);
        const [first, ...rest] = options;
        for (const option of rest) {
          expect(option.macros.protein).toBe(first.macros.protein);
          expect(option.macros.carbs).toBe(first.macros.carbs);
          expect(option.macros.fat).toBe(first.macros.fat);
        }
      }
    }
  });

  it("every meal option is within ~8% (or a small absolute floor) of its slot's target macros", () => {
    for (const dayType of DAY_TYPES) {
      for (const slot of SLOT_ORDER[dayType]) {
        const options = getMealOptions(dayType, slot);
        const [target] = options;
        for (const option of options) {
          expect(
            withinTolerance(option.macros.protein, target.macros.protein),
            `${option.id} protein ${option.macros.protein} vs target ${target.macros.protein}`
          ).toBe(true);
          expect(
            withinTolerance(option.macros.carbs, target.macros.carbs),
            `${option.id} carbs ${option.macros.carbs} vs target ${target.macros.carbs}`
          ).toBe(true);
          expect(
            withinTolerance(option.macros.fat, target.macros.fat),
            `${option.id} fat ${option.macros.fat} vs target ${target.macros.fat}`
          ).toBe(true);
        }
      }
    }
  });

  it("full-target day totals (protein/carbs/fat) match targets.md §5 exactly", () => {
    const total = (dayType: DayType, slots: string[]) =>
      slots.reduce(
        (acc, slot) => {
          const [m] = getMealOptions(dayType, slot as never);
          return {
            protein: acc.protein + m.macros.protein,
            carbs: acc.carbs + m.macros.carbs,
            fat: acc.fat + m.macros.fat,
          };
        },
        { protein: 0, carbs: 0, fat: 0 }
      );

    expect(total("training-10", ["coffee", "pouches-pre", "meal-1", "meal-2", "meal-3"])).toEqual(
      { protein: 135, carbs: 200, fat: 95 }
    );
    expect(
      total("training-7-fasted", ["coffee", "post-refuel", "meal-1", "meal-2", "meal-3"])
    ).toEqual({ protein: 135, carbs: 200, fat: 95 });
    expect(
      total("rest", ["coffee", "meal-1", "meal-2", "meal-3", "hot-chocolate"])
    ).toEqual({ protein: 135, carbs: 110, fat: 85 });
  });

  it("Floor Day: three meals, one per real-food slot, tagged floor-day", () => {
    expect(FLOOR_DAY_MEALS.length).toBe(3);
    expect(new Set(FLOOR_DAY_MEALS.map((m) => m.slot))).toEqual(
      new Set(["meal-1", "meal-2", "meal-3"])
    );
    for (const m of FLOOR_DAY_MEALS) expect(m.tags).toContain("floor-day");
  });

  it("Floor Day core total is ~1,330 kcal / 106 g protein (PRD §7.2)", () => {
    const kcal = FLOOR_DAY_MEALS.reduce((s, m) => s + m.macros.kcal, 0);
    const protein = FLOOR_DAY_MEALS.reduce((s, m) => s + m.macros.protein, 0);
    expect(kcal).toBe(1330);
    expect(protein).toBe(106);
  });
});
