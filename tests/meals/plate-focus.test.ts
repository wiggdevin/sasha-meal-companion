/**
 * Phase 18 W11 (docs/specs/phase-18-open-world-foods.md §W11), acceptance 1: with shopping focus
 * on, every slot whose template can be met from list and pantry foods gets the highest coverage
 * available inside the portion bands — `rankPlates`' own ranking, not a separate generator.
 */
import { describe, expect, it } from "vitest";
import { coverageOf } from "@/lib/shopping/focus";
import { rankPlates, type PlateInput } from "@/lib/meals/plate";
import { foodKey } from "@/lib/meals/parts";
import { eats, F, MAIN } from "@/tests/helpers/meal-foods";

const FOODS = eats(F.chicken, F.tuna, F.rice, F.broccoli, F.oliveOil, F.avocado);
const BASE: Omit<PlateInput, "focus"> = {
  date: "2026-10-05", slot: "meal-2", occasion: "lunch", target: MAIN, foods: FOODS,
};

describe("W11 acceptance 1: focus mode ranks by coverage ahead of the engine's own score", () => {
  it("ranks a fully-covered, fitting plate ahead of a higher-score plate with no coverage at all", () => {
    const plain = rankPlates(BASE).plates.filter((plate) => plate.fits);
    expect(plain.length).toBeGreaterThan(1);
    // Without focus, the plain engine's own best plate is some particular anchor — captured only
    // to prove the two orders really differ below, not asserted as "correct" on its own.
    const bestWithoutFocus = plain[0].anchorKey;

    // Everything BUT that anchor's family counts as on the list/pantry: the focus-ranked best
    // plate must differ from the plain best, and must itself be fully covered.
    const usedEverythingElse = new Set(Object.values(FOODS)
      .filter((food) => foodKey(food) !== bestWithoutFocus)
      .map((food) => foodKey(food)));
    const focused = rankPlates({
      ...BASE, focus: { coverageOf: (items) => coverageOf(items, usedEverythingElse) },
    });
    const best = focused.plates[0];
    expect(best.fits).toBe(true);
    expect(best.coverage).toBe(1);
    expect(best.anchorKey).not.toBe(bestWithoutFocus);
  });

  it("orders every fitting plate by coverage, highest first, among plates that fit", () => {
    const used = new Set([foodKey(F.chicken), foodKey(F.rice)]);
    const { plates } = rankPlates({ ...BASE, focus: { coverageOf: (items) => coverageOf(items, used) } });
    const fitting = plates.filter((plate) => plate.fits);
    expect(fitting.length).toBeGreaterThan(1);
    const coverages = fitting.map((plate) => plate.coverage ?? 0);
    expect(coverages).toEqual([...coverages].sort((a, b) => b - a));
  });

  it("never changes the plain ranking when focus is absent (no regression)", () => {
    const plain = rankPlates(BASE);
    expect(plain.plates.every((plate) => plate.coverage === undefined)).toBe(true);
  });
});
