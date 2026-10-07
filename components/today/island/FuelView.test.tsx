// @vitest-environment jsdom
/**
 * The open well's showcase (owner, 2026-10-06): calories on top, three macro rings below with no
 * "left" and no title; a ring opens into its macro and a second tap, or a tap elsewhere in the view,
 * melts it back. The water basin rises with the day and stops below its figure at the goal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import FuelView from "./FuelView";
import { basinLevel } from "./WellWater";

const DATA = {
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
  consumed: { kcal: 2100, protein: 30, carbs: 50, fat: 15 },
  partial: false,
};

afterEach(cleanup);

describe("FuelView", () => {
  it("puts the calories on top and three rings below, without the word left on the rings", () => {
    const { container } = render(<MotionConfig reducedMotion="always"><FuelView data={DATA} /></MotionConfig>);
    expect(container.textContent).toContain("100kcal over");
    const rings = screen.getAllByRole("button");
    expect(rings).toHaveLength(3);
    for (const ring of rings) expect(ring.textContent).not.toMatch(/left/);
  });

  it("opens a ring into its macro, and a tap elsewhere in the view melts it back", () => {
    const { container } = render(<MotionConfig reducedMotion="always"><FuelView data={DATA} /></MotionConfig>);
    const carbs = screen.getByRole("button", { name: "Carbs: 150 grams left. Show details" });
    fireEvent.click(carbs);
    expect(carbs.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("150g carbs left");
    expect(container.textContent).toContain("10% of today's calories");
    fireEvent.click(container.firstElementChild!);
    expect(carbs.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("kcal over");
  });
});

describe("basinLevel", () => {
  it("keeps a puddle when empty and stops below the readout at and past the goal", () => {
    expect(basinLevel(0, 8)).toBeCloseTo(0.06);
    expect(basinLevel(4, 8)).toBeCloseTo(0.34);
    expect(basinLevel(8, 8)).toBeCloseTo(0.62);
    expect(basinLevel(20, 8)).toBeCloseTo(0.62);
    expect(basinLevel(3, 0)).toBeCloseTo(0.06);
  });
});
