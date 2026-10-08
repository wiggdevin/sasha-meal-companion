// @vitest-environment jsdom
/**
 * Meal cards v2 (docs/design/meal-cards-v2.md): what the person needs at first glance — the status
 * word and time, calories and protein, one labelled way to tick the meal off and a visible Swap.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "motion/react";
import SlotCard from "./SlotCard";
import type { ResolvedSlot } from "@/lib/types";

afterEach(cleanup);

const lunch: ResolvedSlot = {
  slot: "meal-2", time: "12:30", label: "Meal 2",
  meal: { id: "m", name: "Chicken and rice", slot: "meal-2", components: [],
    macros: { kcal: 541, protein: 52, carbs: 56, fat: 13 }, prepMinutes: 10, tags: [] },
  components: [], macros: { kcal: 541, protein: 52, carbs: 56, fat: 13 }, eaten: false,
};

type Props = Partial<React.ComponentProps<typeof SlotCard>>;
function Card(props: Props) {
  return <MotionConfig reducedMotion="always">
    <SlotCard slot={lunch} variant="standard" canSwap onToggleEaten={() => {}} onOpenSwap={() => {}}
      onPlanWithCoach={() => {}} onLogWhatYouAte={() => {}} {...props} />
  </MotionConfig>;
}

const chip = () => document.querySelector("[data-meal-time]") as HTMLElement;

describe("meal card status chip", () => {
  it("leads with Next or Now on the focus card", () => {
    render(<Card variant="focus" focusLabel="Next" />);
    expect(chip().textContent).toMatch(/^Next\s*·?\s*12:30 PM$/);
    expect(chip().getAttribute("aria-label")).toBe("Meal 2, next, scheduled for 12:30 pm");
    cleanup();
    render(<Card variant="focus" focusLabel="Now" />);
    expect(chip().textContent).toMatch(/^Now/);
  });

  it("leads with the meal's name on a later card, never a bare number", () => {
    render(<Card />);
    expect(chip().textContent).toMatch(/^Meal 2\s*·?\s*12:30 PM$/);
  });

  it("says Eaten once the meal is ticked off", () => {
    render(<Card slot={{ ...lunch, eaten: true }} variant="focus" focusLabel="Now" />);
    expect(chip().textContent).toMatch(/^Eaten/);
    expect(chip().getAttribute("aria-label")).toBe("Meal 2, eaten, scheduled for 12:30 pm");
  });
});

describe("meal card action strip", () => {
  it.each(["focus", "standard"] as const)("gives the %s card a labelled eaten button", (variant) => {
    const onToggleEaten = vi.fn();
    render(<Card variant={variant} onToggleEaten={onToggleEaten} />);
    const tick = screen.getByRole("button", { name: "Mark eaten, Meal 2" });
    expect(tick.textContent).toContain("Mark eaten");
    expect(tick.getAttribute("data-eaten")).toBe("false");
    fireEvent.click(tick);
    expect(onToggleEaten).toHaveBeenCalledTimes(1);
  });

  it("shows the calories as a figure, not a control", () => {
    render(<Card variant="focus" />);
    const calories = document.querySelector("[data-meal-calories]") as HTMLElement;
    expect(calories.textContent).toContain("541");
    expect(calories.closest("button")).toBeNull();
  });

  it("turns the eaten button into an undo once eaten, and keeps the card at full strength", () => {
    render(<Card slot={{ ...lunch, eaten: true }} />);
    const done = screen.getByRole("button", { name: "Eaten, Meal 2. Undo" });
    expect(done.textContent).toContain("Eaten");
    expect(done.getAttribute("data-eaten")).toBe("true");
    expect(document.querySelector(".opacity-70")).toBeNull();
  });

  it("offers a visible Swap while the meal can still be swapped", () => {
    const onOpenSwap = vi.fn();
    render(<Card onOpenSwap={onOpenSwap} />);
    const swap = screen.getByRole("button", { name: "Swap Meal 2" });
    expect(swap.className).not.toContain("sr-only");
    expect(swap.textContent).toBe("Swap");
    fireEvent.click(swap);
    expect(onOpenSwap).toHaveBeenCalledTimes(1);
  });

  it("gives focus back to Swap when the swap flow it opened closes", async () => {
    const flow = <button key="swap" type="button">Inside the flow</button>;
    const { rerender } = render(<Card />);
    fireEvent.click(screen.getByRole("button", { name: "Swap Meal 2" }));
    rerender(<Card attachment={flow} />);
    (await screen.findByRole("button", { name: "Inside the flow" })).focus();
    rerender(<Card />);
    const swap = await screen.findByRole("button", { name: "Swap Meal 2" });
    await waitFor(() => expect(document.activeElement).toBe(swap));
  });

  it("hides Swap on an eaten meal and when the slot cannot swap", () => {
    render(<Card slot={{ ...lunch, eaten: true }} />);
    expect(screen.queryByRole("button", { name: "Swap Meal 2" })).toBeNull();
    cleanup();
    render(<Card canSwap={false} />);
    expect(screen.queryByRole("button", { name: "Swap Meal 2" })).toBeNull();
  });
});

describe("meal card figures", () => {
  it("puts protein beside the calories on a compact card", () => {
    render(<Card />);
    const figures = document.querySelector("[data-meal-figures]") as HTMLElement;
    expect(figures.textContent).toContain("541");
    expect(figures.textContent).toContain("52 g protein");
  });

  it("drops the ornament from the featured card", () => {
    render(<Card variant="focus" />);
    expect(document.querySelector("[data-meal-ornament]")).toBeNull();
    expect(document.querySelector('[data-macro-legend="true"]')).not.toBeNull();
  });
});

describe("meal card notes and the open card", () => {
  it("keeps the plan miss inside the card's tray", () => {
    render(<Card planMiss="This plate is 18 g short of protein." />);
    const miss = document.querySelector("[data-slot-plan-miss]") as HTMLElement;
    expect(miss.textContent).toContain("18 g short of protein");
    expect(miss.closest("[data-card-tray]")).not.toBeNull();
  });

  it("offers Ask Sasha for preparation and fits the daily share title", () => {
    const onPlanWithCoach = vi.fn();
    render(<Card onPlanWithCoach={onPlanWithCoach}
      dayTotals={{ consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
        targets: { kcal: 1900, protein: 150, carbs: 190, fat: 60 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Meal 2" }));
    fireEvent.click(screen.getByRole("button", { name: /Preparation/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask Sasha how to make it" }));
    expect(onPlanWithCoach).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Daily share/ })).toBeTruthy();
  });

  it("names Sasha on an empty focus slot and leads with its status", () => {
    render(<Card slot={{ ...lunch, meal: null, components: [], macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } }}
      variant="focus" focusLabel="Next" />);
    expect(screen.getByRole("button", { name: "Plan with Sasha" })).toBeTruthy();
    expect(document.body.textContent).toContain("Next");
  });
});
