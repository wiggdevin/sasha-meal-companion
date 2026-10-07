// @vitest-environment jsdom
/**
 * U28/U29 (Phase 17 O1): a card carries the day generator's quiet line. An empty slot says why it is
 * empty, near its Plan action; an under-target plate says so under the card. A flow open on the card,
 * or a ticked meal, hides the line.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import SlotCard, { type SlotVariant } from "./SlotCard";
import type { Meal, ResolvedSlot } from "@/lib/types";

afterEach(cleanup);

const ZERO = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
const empty: ResolvedSlot = {
  slot: "meal-1", time: "07:30", label: "Meal 1", meal: null, components: [], macros: ZERO, eaten: false,
};
const meal: Meal = {
  id: "plate:eggs", name: "Eggs and toast", slot: "meal-1", prepMinutes: 5, tags: [],
  components: [{ name: "Eggs", qty: 2, unit: "whole", role: "protein",
    macros: { kcal: 140, protein: 12, carbs: 1, fat: 10 } }],
  macros: { kcal: 140, protein: 12, carbs: 1, fat: 10 },
};
const planned: ResolvedSlot = { ...empty, meal, components: meal.components, macros: meal.macros };
const REASON = "Add a breakfast starch or fruit to Eats";
const MISS = "These foods can’t reach this meal’s protein in usual portions";

function Card({ slot, variant = "standard", flow = false, emptyReason, planMiss }: {
  slot: ResolvedSlot; variant?: SlotVariant; flow?: boolean; emptyReason?: string; planMiss?: string;
}) {
  return <MotionConfig reducedMotion="always">
    <SlotCard slot={slot} variant={variant} canSwap={false}
      onToggleEaten={() => {}} onOpenSwap={() => {}} onPlanWithCoach={() => {}} onLogWhatYouAte={() => {}}
      emptyReason={emptyReason} planMiss={planMiss}
      attachment={flow ? <button type="button">Inside the flow</button> : undefined} />
  </MotionConfig>;
}

describe("an empty generated slot shows why it is empty (U28)", () => {
  it.each(["standard", "focus"] as const)("draws the reason as one muted caption on a %s card", (variant) => {
    render(<Card slot={empty} variant={variant} emptyReason={REASON} />);
    const line = screen.getByText(REASON);
    expect(line.className).toContain("text-caption");
    expect(line.className).toContain("text-muted");
    expect(line.closest("[data-fold]")).toBeTruthy(); // it folds in, never a cut
    expect(screen.getByRole("button", { name: variant === "focus" ? "Plan with the coach" : "Plan" })).toBeTruthy();
  });

  it("hides the reason while a flow is open in the card, and shows nothing without one", () => {
    const { rerender } = render(<Card slot={empty} emptyReason={REASON} flow />);
    expect(screen.queryByText(REASON)).toBeNull();
    rerender(<Card slot={empty} />);
    expect(document.querySelector("[data-slot-empty-reason]")).toBeNull();
  });
});

describe("an under-target plate says so under its card (U29)", () => {
  it("draws the miss on the ground below the meal card", () => {
    render(<Card slot={planned} planMiss={MISS} />);
    const line = screen.getByText(MISS);
    expect(line.className).toContain("text-muted");
    // Outside the charcoal card, so the light text roles apply (DESIGN.md §Contrast).
    expect(line.closest("[data-after-dark-meal]")).toBeNull();
    expect(line.closest("[data-card-group]")).toBeTruthy();
  });

  it("hides the miss once the meal is ticked or a flow is open", () => {
    const { rerender } = render(<Card slot={{ ...planned, eaten: true }} planMiss={MISS} />);
    expect(screen.queryByText(MISS)).toBeNull();
    rerender(<Card slot={planned} planMiss={MISS} flow />);
    expect(screen.queryByText(MISS)).toBeNull();
  });
});
