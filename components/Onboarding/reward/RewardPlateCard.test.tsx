// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RewardPlateCard from "./RewardPlateCard";

const TARGETS = {
  training: { kcal: 2400, protein: 180, carbs: 240, fat: 80 },
  rest: { kcal: 2000, protein: 180, carbs: 160, fat: 70 },
};
const FOODS = [
  { id: "chicken-breast", name: "Chicken breast", role: "protein" as const },
  { id: "rice-white", name: "White rice", role: "carb" as const },
];

describe("RewardPlateCard", () => {
  it("preparing: shows a holding state with no numbers when targets are not ready", () => {
    render(<RewardPlateCard targets={null} lovedFoods={[]} showNumbers={false} onToggleNumbers={vi.fn()} />);
    expect(screen.getByTestId("reward-plate-preparing")).toBeTruthy();
    expect(screen.queryByText(/kcal/)).toBeNull();
  });

  it("ready: shows the headline and loved foods with no numbers in the headline", () => {
    render(<RewardPlateCard targets={TARGETS} lovedFoods={FOODS} showNumbers={false}
      onToggleNumbers={vi.fn()} />);
    expect(screen.getByText("Here’s your plate for tomorrow")).toBeTruthy();
    expect(screen.getByText("Chicken breast")).toBeTruthy();
    expect(screen.queryByTestId("reward-plate-numbers")).toBeNull();
    expect(screen.queryByText(/kcal/)).toBeNull();
  });

  it("numbers shown: reveals macros only behind the explicit tap, and can hide them again", () => {
    const onToggle = vi.fn();
    render(<RewardPlateCard targets={TARGETS} lovedFoods={FOODS} showNumbers={true}
      onToggleNumbers={onToggle} />);
    expect(screen.getByTestId("reward-plate-numbers")).toBeTruthy();
    // Polish pass (2026-10-07): the kcal figure now renders through KcalText (DESIGN.md's "every
    // calorie number carries the shared .kcal class" rule), which splits the figure from the unit
    // into two text nodes — assert on the number's own persimmon-styled span, not the combined
    // string `getByText` can no longer match as one node.
    expect(screen.getByText("2,400").className).toContain("kcal");
    fireEvent.click(screen.getByRole("button", { name: "Hide the numbers" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
