/**
 * Calculation audit #21, the UI half on Today: a day that holds a partly measured recipe serving
 * says "at least" of what was eaten and "at most" of what is left, everywhere it counts the day —
 * the Day card's live widget, the overview and its detail, the macro rings, the nutrients card and
 * the week. A whole day reads exactly as before. The words come from one helper
 * (lib/nutrition-display.ts), so the surfaces cannot drift apart.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompactPanel, FullPanel, panelSpoken } from "@/components/today/LiveWidgetPanels";
import DayNutrients from "@/components/DayNutrients";
import HealthOrbitDetail from "@/components/HealthOrbitDetail";
import MacroRings from "@/components/MacroRings";
import { MacroFigure, MacroLine } from "@/components/nutrition/MacroText";
import {
  NUTRITION_UNCHECKED_COPY, PARTIAL_DAY_LINE, balanceBound, boundLabel, boundWords,
  commitNutritionUnchecked, eatenBound, proteinShortGrams, servingBound, withBound,
} from "@/lib/nutrition-display";
import { orbitNodes } from "@/lib/today/health-orbit";
import NutritionGallery from "@/app/design/NutritionGallery";
import type { NutrientValue } from "@/lib/nutrients/snapshot";
import type { LoggedFood, Macros, ResolvedDay } from "@/lib/types";

const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
const consumed: Macros = { kcal: 760, protein: 40, carbs: 80, fat: 30 };
const over: Macros = { kcal: 2120, protein: 160, carbs: 80, fat: 30 };
/** Visible text only: the screen-reader copies removed, tags stripped, spaces collapsed. */
const visible = (markup: string) => markup.replace(/<span class="sr-only">.*?<\/span>/g, "")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the shared wording", () => {
  it("names each bound once", () => {
    expect(boundWords("exact")).toBe("");
    expect(boundWords("at-least")).toBe("at least");
    expect(boundWords("at-most")).toBe("at most");
    expect(boundLabel("at-least")).toBe("At least");
    expect(withBound("420 kcal", "at-least")).toBe("at least 420 kcal");
    expect(withBound("420 kcal", "exact")).toBe("420 kcal");
  });

  it("bounds eaten from below, what is left from above, and an overshoot from below", () => {
    expect(eatenBound(false)).toBe("exact");
    expect(eatenBound(true)).toBe("at-least");
    expect(balanceBound(false, false)).toBe("exact");
    expect(balanceBound(true, false)).toBe("at-most");
    expect(balanceBound(true, true)).toBe("at-least");
    expect(servingBound(true)).toBe("exact");
    expect(servingBound(false)).toBe("at-least");
  });

  it("calls a protein gap a shortfall only when it is below zero and rounds to a gram", () => {
    expect(proteinShortGrams(-12.4)).toBe(12);
    expect(proteinShortGrams(0)).toBeNull();
    expect(proteinShortGrams(5)).toBeNull();
    expect(proteinShortGrams(null)).toBeNull();
    expect(proteinShortGrams(undefined)).toBeNull();
    expect(proteinShortGrams(-0.3)).toBeNull();
    expect(proteinShortGrams(Number.NaN)).toBeNull();
  });

  it("reads nutrition_unchecked only from an ok answer", () => {
    const ok = { status: "ok", entry_id: "e", rev: 1, items: [], totals: {} } as never;
    expect(commitNutritionUnchecked({ ...(ok as object), nutrition_unchecked: true } as never)).toBe(true);
    expect(commitNutritionUnchecked(ok)).toBe(false);
    expect(commitNutritionUnchecked({ status: "queued" })).toBe(false);
    expect(commitNutritionUnchecked(null)).toBe(false);
    expect(NUTRITION_UNCHECKED_COPY).toBe("Saved. Nutrition not fully checked.");
  });

  it("puts the words before the figure in MacroFigure and MacroLine, and never before an unknown", () => {
    expect(visible(renderToStaticMarkup(<MacroFigure macro="kcal" value={420} bound="at-least" />)))
      .toBe("at least 420 kcal");
    expect(renderToStaticMarkup(<MacroFigure macro="kcal" value={null} bound="at-least" />))
      .not.toContain("at least");
    const line = visible(renderToStaticMarkup(<MacroLine bound="at-most"
      values={{ kcal: 1240, protein: 40, carbs: null, fat: null }} only={["kcal", "protein"]} />));
    expect(line.startsWith("at most 1,240 kcal")).toBe(true);
    expect(line.match(/at most/g)).toHaveLength(1);
  });
});

describe("the Day card's live widget", () => {
  const data = (day: Macros, partial: boolean) => ({ targets, consumed: day, partial });
  it("says at most N kcal left on a partly measured day, and the plain figure otherwise", () => {
    const partial = renderToStaticMarkup(<CompactPanel panel="kcalLeft" data={data(consumed, true)} />);
    expect(visible(partial)).toContain("at most 1,240 kcal left");
    expect(panelSpoken("kcalLeft", data(consumed, true))).toBe("at most 1,240 kcal left of 2,000");
    const whole = renderToStaticMarkup(<CompactPanel panel="kcalLeft" data={data(consumed, false)} />);
    expect(visible(whole)).toContain("1,240 kcal left");
    expect(whole).not.toMatch(/at most|at least/);
  });

  it("says at least N kcal over once a partly measured day passes the target", () => {
    const markup = renderToStaticMarkup(<CompactPanel panel="kcalLeft" data={data(over, true)} />);
    expect(visible(markup)).toContain("at least 120 kcal over");
  });

  it("gives each macro its bound in words, beside its figure", () => {
    const spoken = panelSpoken("macros", data(over, true));
    // Protein is over (at least), carbs and fat are left (at most).
    expect(spoken).toContain("at least 10 grams protein over");
    expect(spoken).toContain("at most 120 grams carbs left");
    const markup = renderToStaticMarkup(<FullPanel panel="macros" data={data(over, true)} />);
    // Each ring holds the grams; under it, the macro and its bound in words.
    expect(visible(markup)).toMatch(/10g PRO at least over/);
    expect(visible(markup)).toMatch(/120g CAR at most left/);
  });
});

describe("the overview", () => {
  const nodes = (partial: boolean, eaten = consumed) =>
    orbitNodes({ targets, consumed: eaten, water: undefined, body: undefined, partial });

  it("labels every nutrient node 'At least' on a partly measured day, and speaks it in full", () => {
    const [calories, carbs] = nodes(true);
    expect(calories.label).toBe("At least");
    expect(calories.amount).toBe("760 kcal");
    expect(calories.spoken).toBe("Calories eaten: at least 760 of 2,000 kcal");
    expect(carbs.label).toBe("At least");
    expect(carbs.spoken).toContain("at least 80 of 200 g");
    expect(nodes(false)[0].label).toBe("Eaten");
    expect(nodes(false)[0].spoken).not.toContain("at least");
  });

  it("keeps over in words and the bound visible on an over node (review: Sol)", () => {
    const [calories, carbs, protein] = nodes(true, over);
    expect(calories.label).toBe("At least, over");
    expect(calories.bound).toBe(true);
    expect(calories.spoken).toContain("at least 120 kcal over");
    expect(protein.label).toBe("At least, over");
    expect(carbs.label).toBe("At least");
    expect(nodes(false, over)[0].label).toBe("Eaten over");
    expect(nodes(false, over)[0].bound).toBeFalsy();
  });

  it("shows a visible at least on the protein, carbs and fat nodes (review: Sol)", () => {
    const [, carbs, protein, fat] = nodes(true);
    for (const node of [carbs, protein, fat]) {
      expect(node.label).toBe("At least");
      expect(node.bound).toBe(true);
    }
    expect(nodes(false).slice(1, 4).map((node) => node.label)).toEqual(["Carbs", "Protein", "Fat"]);
  });

  it("draws the bounded wells in the design gallery's overview", () => {
    const markup = renderToStaticMarkup(<NutritionGallery />);
    expect(markup).toContain("Overview · partly measured day");
    // The overview's wells (2026-10-05): eaten and an overshoot "at least", in words before the figure.
    expect(markup).toContain("at least 1,951 kcal eaten of 1,891");
    expect(markup).toContain("at least 60 kcal over");
  });

  it("says at least eaten and at most left in the chosen metric's detail", () => {
    const [calories] = nodes(true);
    const partial = renderToStaticMarkup(<HealthOrbitDetail id="d" node={calories} targets={targets}
      consumed={consumed} partial />);
    expect(partial).toContain("At least eaten");
    expect(partial).toContain("At most 1,240 kcal left");
    const passed = renderToStaticMarkup(<HealthOrbitDetail id="d" node={nodes(true, over)[0]} targets={targets}
      consumed={over} partial />);
    expect(passed).toContain("At least 120 kcal over target");
    const whole = renderToStaticMarkup(<HealthOrbitDetail id="d" node={nodes(false)[0]} targets={targets}
      consumed={consumed} />);
    expect(whole).toContain("Eaten");
    expect(whole).toContain("1,240 kcal left");
    expect(whole).not.toMatch(/At least|At most/);
  });
});

describe("the macro rings", () => {
  it("says still to eat at most on a partly measured day, and an overshoot at least", () => {
    expect(visible(renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} partial />)))
      .toContain("Still to eat at most 1,240 kcal");
    expect(renderToStaticMarkup(<MacroRings targets={targets} consumed={over} partial />))
      .toContain("Calories at least 120 kcal over");
    const whole = renderToStaticMarkup(<MacroRings targets={targets} consumed={consumed} />);
    expect(whole).not.toMatch(/at most|at least/);
  });
});

describe("the nutrients card", () => {
  const value: NutrientValue = { amount: 12, unit: "g", basis: "per_100g", source: "catalog",
    source_version: "1", revision_id: 1 };
  const day = (partial: boolean): ResolvedDay => ({
    date: "2026-10-05", dayType: "rest", isFloorDay: false, targets: null, slots: [], waterCups: 0,
    consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    extras: [{ id: "e1", foodId: "recipe", name: "Stew", portionLabel: "serving", qty: 1, grams: 300,
      macros: { kcal: 300, protein: 20, carbs: 30, fat: 10 }, at: "2026-10-05T12:00:00.000Z",
      ...(partial ? { nutritionPartial: true } : {}),
      items: [{ id: "i1", seq: 1, food_ref_id: "r1", grams: 300, qty: 1, unit: "portion",
        snapshot: { fiber_total: value } }],
    }] as unknown as LoggedFood[],
  });

  const fibreDay = (grams: number, partial: boolean): ResolvedDay => {
    const base = day(partial);
    const [entry] = base.extras;
    const items = (entry.items ?? []).map((item) => ({ ...item,
      snapshot: { fiber_total: { ...value, amount: grams } } }));
    return { ...base, extras: [{ ...entry, items } as LoggedFood] };
  };

  it("never calls a partial day under a band: it says how much is counted (review: Sol)", () => {
    const under = renderToStaticMarkup(<DayNutrients day={fibreDay(12, true)} />);
    expect(under).not.toContain("Under your");
    expect(under).toContain("At least 12.0 g counted");
    // A lower bound that already reaches the band, or passes it, establishes the verdict.
    expect(renderToStaticMarkup(<DayNutrients day={fibreDay(22, true)} />)).toContain("In your 20–25 g band");
    expect(renderToStaticMarkup(<DayNutrients day={fibreDay(40, true)} />)).toContain("Over your 20–25 g band");
    // A whole day keeps its verdict.
    expect(renderToStaticMarkup(<DayNutrients day={fibreDay(12, false)} />)).toContain("Under your 20–25 g band");
  });

  it("adds one line when the day includes a partly measured recipe, and none otherwise", () => {
    expect(PARTIAL_DAY_LINE).toBe("Includes a partly measured recipe.");
    expect(renderToStaticMarkup(<DayNutrients day={day(true)} />)).toContain(PARTIAL_DAY_LINE);
    expect(renderToStaticMarkup(<DayNutrients day={day(false)} />)).not.toContain(PARTIAL_DAY_LINE);
  });
});
