// @vitest-environment jsdom
/** IdeaCard: one meal idea inside the Plan flow, its own figures, placing and skipping. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import IdeaCard from "@/components/plan/IdeaCard";
import type { ComposedMeal } from "@/lib/coach/compose";

afterEach(cleanup);

const meal = {
  wish: "Salmon and rice",
  totals: { kcal: 520, protein: 38, carbs: 50, fat: 16 },
  items: [{ name: "Salmon", grams: 140 }, { name: "Rice", grams: 180 }],
} as unknown as ComposedMeal;

describe("IdeaCard", () => {
  it("idle: shows the idea's own name, figures and portions, and places it on a tap", () => {
    const onPlace = vi.fn();
    render(<IdeaCard meal={meal} label="Meal 2" busy={false} placing={false} onPlace={onPlace} onSkip={() => {}} />);
    expect(screen.getByText("Salmon and rice")).toBeTruthy();
    expect(screen.getByText("Salmon 140 g · Rice 180 g")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Put it in Meal 2/ }));
    expect(onPlace).toHaveBeenCalledTimes(1);
  });

  it("placing: the place button shows its dots and both actions are held", () => {
    render(<IdeaCard meal={meal} label="Meal 2" busy placing onPlace={() => {}} onSkip={() => {}} />);
    const place = screen.getByRole("button", { name: /Put it in Meal 2/ });
    expect(place.getAttribute("data-status")).toBe("pending");
    expect((screen.getByRole("button", { name: "Not this: Salmon and rice" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
