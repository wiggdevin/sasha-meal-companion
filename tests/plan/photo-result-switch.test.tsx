// @vitest-environment jsdom
/**
 * "Not right?" under a photo result (components/plan/PhotoResult.tsx): given `onSwitch` (the recipe
 * widget), the result draws the line that re-reads the same photo another way, the current read
 * marked and out of reach. Without it (the Plan panel, which draws its own line) there is none, so
 * the panel never shows two.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PhotoResult from "@/components/plan/PhotoResult";
import type { InspireResult } from "@/lib/plan/inspire-types";

const PLATE: InspireResult = {
  kind: "plate", title: "Chicken and rice", ingredients: [],
  plate: { kcal: 600, protein: 40, carbs: 70, fat: 12, title: "Chicken and rice",
    items: [{ name: "Chicken", grams: 150 }, { name: "Rice", grams: 200 }] } as never,
};

afterEach(cleanup);

describe("the photo result's Not right? line", () => {
  it("re-reads the photo another way, with the current read marked", () => {
    const onSwitch = vi.fn();
    render(<PhotoResult result={PLATE} label="Meal 2" targetKcal={700} busy={false} logging={null}
      onLogPlate={vi.fn()} onPick={vi.fn()} onSwitch={onSwitch} />);
    const line = screen.getByLabelText("Not right?");
    const current = within(line).getByRole("button", { name: "Log it instead" }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(current.getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(line).getByRole("button", { name: "Pick from menu instead" }));
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith("menu");
  });

  it("is out of reach while a log is in flight", () => {
    render(<PhotoResult result={PLATE} label="Meal 2" targetKcal={700} busy logging="plate"
      onLogPlate={vi.fn()} onPick={vi.fn()} onSwitch={vi.fn()} />);
    const buttons = within(screen.getByLabelText("Not right?")).getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("is left to the caller when no onSwitch is given", () => {
    render(<PhotoResult result={PLATE} label="Meal 2" targetKcal={700} busy={false} logging={null}
      onLogPlate={vi.fn()} onPick={vi.fn()} />);
    expect(screen.queryByLabelText("Not right?")).toBeNull();
  });
});
