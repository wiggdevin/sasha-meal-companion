import { describe, expect, it } from "vitest";
import { adjustCalories, macroKcal, roundToServing, scaleComponents, scaleProteinComponents } from "./scaling";
import type { FoodComponent, Macros } from "./types";

const trainingBaseline: Macros = { kcal: 2200, protein: 135, carbs: 200, fat: 95 };
const restBaseline: Macros = { kcal: 1750, protein: 135, carbs: 110, fat: 85 };

describe("adjustCalories — protein never scales with calories (PRD §7.5)", () => {
  it("protein stays fixed when kcal is raised by 200", () => {
    const result = adjustCalories(trainingBaseline, 2400, "training");
    expect(result.macros.protein).toBe(135);
  });

  it("protein stays fixed when kcal is lowered by 200", () => {
    const result = adjustCalories(trainingBaseline, 2000, "training");
    expect(result.macros.protein).toBe(135);
  });

  it("protein is NEVER reduced by any scaling operation, at any input", () => {
    const wideSweep = [-5000, -1000, 0, 1, 500, 1000, 1950, 2200, 2500, 5000, 10000];
    for (const targetKcal of wideSweep) {
      const training = adjustCalories(trainingBaseline, targetKcal, "training");
      const rest = adjustCalories(restBaseline, targetKcal, "rest");
      expect(training.macros.protein).toBe(135);
      expect(rest.macros.protein).toBe(135);
    }
  });
});

describe("adjustCalories — carbs absorb an increase first, fat takes the overflow past +75g", () => {
  it("+100 kcal (well under the 300 kcal / 75g carb cap) is carbs-only", () => {
    const result = adjustCalories(trainingBaseline, 2300, "training");
    expect(result.macros.carbs).toBe(225); // 200 + 100/4
    expect(result.macros.fat).toBe(95); // untouched
    expect(result.clamped).toBe(false);
  });

  it("exactly +300 kcal (the 75g carb cap) still lands entirely in carbs", () => {
    const result = adjustCalories(trainingBaseline, 2500, "training");
    expect(result.macros.carbs).toBe(275); // 200 + 75
    expect(result.macros.fat).toBe(95);
  });

  it("+400 kcal spills 100 kcal of overflow into fat past the carb cap", () => {
    const result = adjustCalories(trainingBaseline, 2600, "training");
    expect(result.macros.carbs).toBe(275); // capped at +75g
    expect(result.macros.fat).toBe(106); // 95 + round(100/9)
  });
});

describe("adjustCalories — floors clamp correctly and the clamped flag is set", () => {
  it("training floors: carbs to 100g, fat to 50g, clamped true, message present", () => {
    const result = adjustCalories(trainingBaseline, 400, "training");
    expect(result.macros.carbs).toBe(100);
    expect(result.macros.fat).toBe(50);
    expect(result.macros.protein).toBe(135);
    expect(result.clamped).toBe(true);
    expect(result.message).toBeTruthy();
  });

  it("rest floors: carbs to 80g, fat to 50g, clamped true", () => {
    const result = adjustCalories(restBaseline, 300, "rest");
    expect(result.macros.carbs).toBe(80);
    expect(result.macros.fat).toBe(50);
    expect(result.clamped).toBe(true);
  });

  it("a reduction that stays within the carb floor is not clamped", () => {
    // 200g carbs -> floor is 100g, so removing up to 400 kcal is carbs-only.
    const result = adjustCalories(trainingBaseline, 1900, "training");
    expect(result.clamped).toBe(false);
    expect(result.macros.carbs).toBe(125); // 200 - 300/4
    expect(result.macros.fat).toBe(95);
  });

  it("a reduction that exhausts carbs but not fat is not clamped", () => {
    // Removing 500 kcal: 400 kcal from carbs (to the 100g floor), 100 from fat.
    const result = adjustCalories(trainingBaseline, 1700, "training");
    expect(result.clamped).toBe(false);
    expect(result.macros.carbs).toBe(100);
    expect(result.macros.fat).toBe(84); // 95 - round(100/9) = 95 - 11
  });

  it("no change requested is a no-op, not a clamp", () => {
    const result = adjustCalories(trainingBaseline, 2200, "training");
    expect(result).toEqual({ macros: trainingBaseline, clamped: false });
  });
});

describe("macroKcal", () => {
  it("uses standard Atwater factors: 4/4/9", () => {
    expect(macroKcal({ protein: 10, carbs: 10, fat: 10 })).toBe(40 + 40 + 90);
  });
});

describe("scaleComponents — only carb/fat components move", () => {
  const proteinComponent: FoodComponent = {
    name: "Chicken breast",
    qty: 6,
    unit: "oz",
    role: "protein",
    macros: { kcal: 280, protein: 45, carbs: 0, fat: 6 },
  };
  const freeComponent: FoodComponent = {
    name: "Salt",
    qty: 1,
    unit: "tsp",
    role: "free",
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  };
  const carbComponent: FoodComponent = {
    name: "White rice, cooked",
    qty: 1,
    unit: "cup",
    role: "carb",
    macros: { kcal: 205, protein: 4, carbs: 45, fat: 0 },
  };
  const fatComponent: FoodComponent = {
    name: "Avocado mayo",
    qty: 2,
    unit: "tbsp",
    role: "fat",
    macros: { kcal: 180, protein: 0, carbs: 0, fat: 20 },
  };

  it("leaves protein components byte-identical", () => {
    const [scaledProtein] = scaleComponents([proteinComponent], 1.5);
    expect(scaledProtein.qty).toBe(proteinComponent.qty);
    expect(scaledProtein.unit).toBe(proteinComponent.unit);
    expect(scaledProtein.macros).toEqual(proteinComponent.macros);
  });

  it("leaves free components untouched too", () => {
    const [scaledFree] = scaleComponents([freeComponent], 2);
    expect(scaledFree.qty).toBe(freeComponent.qty);
    expect(scaledFree.macros).toEqual(freeComponent.macros);
  });

  it("never mutates the input array's objects (immutability)", () => {
    const input = [proteinComponent, carbComponent];
    const snapshotBefore = JSON.parse(JSON.stringify(input));
    scaleComponents(input, 1.5);
    expect(input).toEqual(snapshotBefore);
  });

  it("scales a carb component's qty and macros, rounding cups to the nearest 1/4", () => {
    const [scaled] = scaleComponents([carbComponent], 1.5); // 1 cup * 1.5 = 1.5 cups exactly
    expect(scaled.qty).toBe(1.5);
    expect(scaled.macros.carbs).toBe(Math.round(45 * 1.5));
  });

  it("rounds a fat component's tbsp to the nearest half", () => {
    // 2 tbsp * 1.3 = 2.6 -> rounds to 2.5
    const [scaled] = scaleComponents([fatComponent], 1.3);
    expect(scaled.qty).toBe(2.5);
  });

  it("rounds whole/pouch/can components to a whole number, minimum 1", () => {
    const pouch: FoodComponent = {
      name: "Fruit pouch",
      qty: 2,
      unit: "pouch",
      role: "carb",
      macros: { kcal: 160, protein: 2, carbs: 36, fat: 0 },
    };
    const shrunk = scaleComponents([pouch], 0.1); // would be 0.2 pouches — floors at 1
    expect(shrunk[0].qty).toBe(1);

    const grown = scaleComponents([pouch], 1.6); // 3.2 -> rounds to 3
    expect(grown[0].qty).toBe(3);
  });

  it("never lets a small oz/cup/tbsp/tsp component vanish (audit N1)", () => {
    const oil: FoodComponent = { name: "Olive oil", qty: 0.4, unit: "oz", role: "fat",
      macros: { kcal: 108, protein: 0, carbs: 0, fat: 12 } };
    // 0.4 oz * 0.5 = 0.2 oz used to round to 0 oz with 0 kcal. The step floor would lift it to
    // 0.5 oz — more than before a scale-DOWN — so it stays at 0.4 oz with its own macros.
    const [kept] = scaleComponents([oil], 0.5);
    expect(kept.qty).toBe(0.4);
    expect(kept.macros).toEqual(oil.macros);
    // 0.6 oz * 0.5 = 0.3 oz floors at one half-ounce step, still below the original.
    const [floored] = scaleComponents([{ ...oil, qty: 0.6 }], 0.5);
    expect(floored.qty).toBe(0.5);
    expect(floored.macros.fat).toBeGreaterThan(0);
    expect(floored.macros.fat).toBeLessThanOrEqual(oil.macros.fat);
  });

  it("never shrinks a portion on a scale-up, and keeps a zero row at zero", () => {
    const rice: FoodComponent = { name: "Rice", qty: 1, unit: "whole", role: "carb",
      macros: { kcal: 200, protein: 4, carbs: 44, fat: 0 } };
    // 1 × 1.4 = 1.4 rounds to 1 — not below the original on the way up.
    expect(scaleComponents([rice], 1.4)[0].qty).toBe(1);
    expect(scaleComponents([rice], 1.6)[0].qty).toBe(2);
    const zero = { ...rice, qty: 0, macros: { kcal: 10, protein: 0, carbs: 2, fat: 0 } };
    const [scaled] = scaleComponents([zero], 2);
    expect(scaled.qty).toBe(0);
    expect(scaled.macros.kcal).toBe(0);
  });

  it("a mixed meal only moves the carb/fat components, leaving totals traceable", () => {
    const meal = [proteinComponent, carbComponent, fatComponent, freeComponent];
    const scaled = scaleComponents(meal, 1.5);
    expect(scaled[0].qty).toBe(proteinComponent.qty); // chicken untouched
    expect(scaled[1].qty).toBeGreaterThan(carbComponent.qty); // rice grew
    expect(scaled[2].qty).toBeGreaterThan(fatComponent.qty); // mayo grew
    expect(scaled[3].qty).toBe(freeComponent.qty); // salt untouched
  });
});

// ---------------------------------------------------------------------------
// Ramp vs calorie-pin: two different things that both move protein.
// Conflating them produced a real bug — meals showed 135 g against a week-1
// target of 115 g. These tests keep the two paths separated.
// ---------------------------------------------------------------------------
describe("scaleProteinComponents — the RAMP path", () => {
  const comps: FoodComponent[] = [
    { name: "Chicken breast", qty: 6, unit: "oz", role: "protein",
      macros: { kcal: 280, protein: 54, carbs: 0, fat: 6 } },
    { name: "White rice", qty: 1, unit: "cup", role: "carb",
      macros: { kcal: 205, protein: 0, carbs: 45, fat: 0 } },
    { name: "Olive oil", qty: 1, unit: "tbsp", role: "fat",
      macros: { kcal: 119, protein: 0, carbs: 0, fat: 14 } },
  ];

  it("scales protein DOWN for an earlier ramp week (135 -> 115)", () => {
    const out = scaleProteinComponents(comps, 115 / 135);
    expect(out[0].qty).toBeLessThan(6);
    expect(out[0].macros.protein).toBeLessThan(54);
  });

  it("leaves carb and fat components untouched", () => {
    const out = scaleProteinComponents(comps, 115 / 135);
    expect(out[1]).toEqual(comps[1]);
    expect(out[2]).toEqual(comps[2]);
  });

  it("is a no-op at full ramp (ratio 1)", () => {
    const out = scaleProteinComponents(comps, 1);
    expect(out[0].qty).toBe(6);
    expect(out[0].macros.protein).toBe(54);
  });

  it("scaleComponents still refuses to touch protein — the CALORIE-PIN path", () => {
    const out = scaleComponents(comps, 1.5);
    expect(out[0].qty).toBe(6);
    expect(out[0].macros.protein).toBe(54);
  });
});

describe("roundToServing — zero stays zero, positive never rounds to zero (audit N1/N5)", () => {
  it("floors a positive demand at each unit's smallest step", () => {
    expect(roundToServing(0.2, "oz")).toBe(0.5);
    expect(roundToServing(0.1, "cup")).toBe(0.25);
    expect(roundToServing(0.2, "tbsp")).toBe(0.5);
    expect(roundToServing(0.01, "tsp")).toBe(0.5);
    expect(roundToServing(0.3, "whole")).toBe(1);
    expect(roundToServing(0.4, "g")).toBe(1);
    expect(roundToServing(0.4, "ml")).toBe(1);
  });

  it("keeps zero (and nothing) at zero for every unit", () => {
    for (const unit of ["oz", "cup", "tbsp", "tsp", "whole", "pouch", "can", "g", "ml"] as const) {
      expect(roundToServing(0, unit)).toBe(0);
      expect(roundToServing(-1, unit)).toBe(0);
      expect(roundToServing(Number.NaN, unit)).toBe(0);
    }
  });

  it("rounds ordinary amounts as before", () => {
    expect(roundToServing(2.6, "tbsp")).toBe(2.5);
    expect(roundToServing(1.4, "cup")).toBe(1.5);
    expect(roundToServing(3.2, "can")).toBe(3);
    expect(roundToServing(140.4, "g")).toBe(140);
  });
});
