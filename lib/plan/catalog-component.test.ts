// lib/plan/catalog-component.test.ts
/**
 * Phase C of docs/plans/2026-09-14-slot-item-editing.md.
 *
 * Phase B introduced an editable milk line and exposed the gap: "Something else" offers
 * own foods — proteins, carbs and fats — so there was no whole milk to choose. This is what turns a
 * catalog row into a line on the card.
 *
 * The catalog stores per-100 g amounts under its own nutrient codes (catalog_nutrients): protein,
 * carbohydrate, fat_total, energy_kcal, with energy_kcal_calc as the Atwater-calculated sibling.
 */
import { describe, expect, it } from "vitest";
import { catalogNutritionGaps, completeComponentFromCatalog, componentFromCatalog } from "@/lib/plan/catalog-component";

const wholeMilk = {
  protein: 3.28, carbohydrate: 4.67, fat_total: 3.2, energy_kcal: 61,
};

describe("componentFromCatalog", () => {
  it("scales a per-100 g row to the grams actually eaten", () => {
    const c = componentFromCatalog("Milk, whole", wholeMilk, 244);
    expect(c.name).toBe("Milk, whole");
    expect(c.qty).toBe(244);
    expect(c.unit).toBe("g");
    expect(c.macros).toEqual({ kcal: 149, protein: 8, carbs: 11.4, fat: 7.8 });
  });

  it("is all zeroes for no grams, rather than a line that quietly counts", () => {
    expect(componentFromCatalog("Milk, whole", wholeMilk, 0).macros)
      .toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });

  it("uses the calculated energy when the measured one is missing", () => {
    const c = componentFromCatalog("Something", { protein: 10, carbohydrate: 20, fat_total: 5, energy_kcal_calc: 165 }, 100);
    expect(c.macros.kcal).toBe(165);
  });

  it("falls back to the macros when the row carries no energy at all", () => {
    // 10 * 4 + 20 * 4 + 5 * 9 = 165
    const c = componentFromCatalog("Something", { protein: 10, carbohydrate: 20, fat_total: 5 }, 100);
    expect(c.macros.kcal).toBe(165);
  });

  it("treats a missing or null nutrient as zero, not as NaN on the card", () => {
    const c = componentFromCatalog("Sparse", { protein: null, carbohydrate: 12 }, 100);
    expect(c.macros.protein).toBe(0);
    expect(c.macros.fat).toBe(0);
    expect(c.macros.carbs).toBe(12);
    expect(Number.isFinite(c.macros.kcal)).toBe(true);
  });

  it("refuses a negative gram weight rather than inventing negative calories", () => {
    expect(componentFromCatalog("Milk, whole", wholeMilk, -100).macros)
      .toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });

  it("carries no role of its own — a catalog pick is a free line", () => {
    expect(componentFromCatalog("Milk, whole", wholeMilk, 244).role).toBe("free");
  });
});

describe("completeComponentFromCatalog — unknown stays unknown (audit #20)", () => {
  const sparse = { protein: null, carbohydrate: 12, fat_total: null };

  it("names the unknowns of a sparse row, including the energy it cannot derive", () => {
    expect(catalogNutritionGaps(sparse)).toEqual(["kcal", "protein", "fat"]);
    expect(catalogNutritionGaps(wholeMilk)).toEqual([]);
  });

  it("refuses a sparse row instead of a 48 kcal, 0 g protein line", () => {
    expect(completeComponentFromCatalog("Sparse", sparse, 100)).toBeNull();
  });

  it("refuses a row with measured energy but an unknown macro", () => {
    expect(completeComponentFromCatalog("Sparse", { ...sparse, energy_kcal: 120 }, 100)).toBeNull();
  });

  it("treats a negative nutrient as unknown, not as negative grams", () => {
    expect(catalogNutritionGaps({ ...wholeMilk, fat_total: -3 })).toEqual(["fat"]);
    expect(completeComponentFromCatalog("Broken", { ...wholeMilk, fat_total: -3 }, 100)).toBeNull();
    expect(componentFromCatalog("Broken", { ...wholeMilk, fat_total: -3 }, 100).macros.fat).toBe(0);
  });

  it("keeps a measured zero: a complete row with 0 g fat is a line", () => {
    const c = completeComponentFromCatalog("Skim", { protein: 3.4, carbohydrate: 5, fat_total: 0 }, 100);
    expect(c?.macros).toEqual({ kcal: 34, protein: 3.4, carbs: 5, fat: 0 });
  });

  it("returns the same line as the lenient form for a complete row", () => {
    expect(completeComponentFromCatalog("Milk, whole", wholeMilk, 244))
      .toEqual(componentFromCatalog("Milk, whole", wholeMilk, 244));
  });
});

describe("a stored zero energy (Grok round 2, WARN 4)", () => {
  it("is a measurement: trace macros under a rounded 0 do not rewrite it upward", () => {
    const noodles = { protein: 0.2, carbohydrate: 3, fat_total: 0, energy_kcal: 0 };
    expect(completeComponentFromCatalog("Shirataki", noodles, 100)?.macros.kcal).toBe(0);
    expect(componentFromCatalog("Shirataki", noodles, 100).macros.kcal).toBe(0);
  });

  it("is not discarded because an unknown macro was read as zero", () => {
    expect(catalogNutritionGaps({ protein: null, carbohydrate: 12, fat_total: 1, energy_kcal: 0 }))
      .toEqual(["protein"]);
  });

  it("stays a real zero for water", () => {
    const water = { protein: 0, carbohydrate: 0, fat_total: 0, energy_kcal: 0 };
    expect(completeComponentFromCatalog("Water", water, 250)?.macros).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });

  it("treats a negative energy field as missing for that field only (Grok round 6)", () => {
    const macros = { protein: 10, carbohydrate: 20, fat_total: 5 };
    // A good measurement beside a broken calculated value: the measurement.
    expect(completeComponentFromCatalog("M", { ...macros, energy_kcal: 165, energy_kcal_calc: -1 }, 100)
      ?.macros.kcal).toBe(165);
    // A broken measurement beside a good calculated value: the calculated one.
    expect(completeComponentFromCatalog("C", { ...macros, energy_kcal: -40, energy_kcal_calc: 160 }, 100)
      ?.macros.kcal).toBe(160);
    // No valid energy, all three macros: Atwater.
    expect(completeComponentFromCatalog("A", { ...macros, energy_kcal: -40 }, 100)?.macros.kcal).toBe(165);
    expect(completeComponentFromCatalog("N", { ...macros, energy_kcal: Number.NaN }, 100)?.macros.kcal).toBe(165);
    // No valid energy and a macro missing: unknown, refused.
    expect(catalogNutritionGaps({ protein: 10, carbohydrate: 20, fat_total: null, energy_kcal: -40 }))
      .toEqual(["kcal", "fat"]);
  });

  it("falls to the calculated energy, then Atwater, only when the measured value is absent", () => {
    expect(componentFromCatalog("Calc", { protein: 10, carbohydrate: 20, fat_total: 5, energy_kcal_calc: 160 }, 100)
      .macros.kcal).toBe(160);
    expect(componentFromCatalog("Atwater", { protein: 10, carbohydrate: 20, fat_total: 5, energy_kcal: null }, 100)
      .macros.kcal).toBe(165);
  });
});

describe("the lenient form stays out of lib/ and app/ writers (Grok round 5, WARN 5)", () => {
  it("is imported only by the UI files that preview or hand-edit a line", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(__dirname, "..", "..");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
    const users = ["app", "components", "lib"].flatMap((dir) => walk(join(root, dir)))
      // [^}] spans lines, so a multi-line import is caught too.
      .filter((path) => /import\s+(?:type\s+)?\{[^}]*\bcomponentFromCatalog\b[^}]*\}/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path)).sort();
    // EditSlotSheet writes a slot line, so it takes the complete form (UI lane, 2026-10-05).
    expect(users).toEqual(["components/CoachActionCard.tsx", "components/SlotCardDetail.tsx"]);
  });
});

describe("the fence regex", () => {
  it("catches a multi-line import", () => {
    const re = /import\s+(?:type\s+)?\{[^}]*\bcomponentFromCatalog\b[^}]*\}/;
    expect(re.test('import {\n  completeComponentFromCatalog,\n  componentFromCatalog,\n} from "x";')).toBe(true);
    expect(re.test('import { completeComponentFromCatalog } from "x";')).toBe(false);
  });
});
