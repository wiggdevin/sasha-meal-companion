// @vitest-environment jsdom
/**
 * Meal cards v3 (owner round, 2026-10-08; docs/design/meal-cards-v2.md "v3"): smaller cards, no macro
 * bar, a thin strip of three equal icon zones (eaten | swap | details), and a heart that saves the
 * plate as a favorite meal when the page supplies one.
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

function Card(props: Partial<React.ComponentProps<typeof SlotCard>>) {
  return <MotionConfig reducedMotion="always">
    <SlotCard slot={lunch} variant="standard" canSwap onToggleEaten={() => {}} onOpenSwap={() => {}}
      onPlanWithCoach={() => {}} onLogWhatYouAte={() => {}} {...props} />
  </MotionConfig>;
}

const zones = () => Array.from(document.querySelectorAll("[data-strip-zone]")) as HTMLElement[];

describe("no macro bar", () => {
  it.each(["focus", "standard"] as const)("draws no proportional macro bar on the %s card", (variant) => {
    render(<Card variant={variant} />);
    expect(document.querySelector("[data-macro-composition]")).toBeNull();
    expect(document.querySelector("[data-compact-bar]")).toBeNull();
  });

});

describe("the three-zone icon strip", () => {
  it.each(["focus", "standard"] as const)("splits the %s card's strip into eaten, swap and details", (variant) => {
    render(<Card variant={variant} />);
    expect(zones().map((zone) => zone.dataset.stripZone)).toEqual(["eaten", "swap", "details"]);
    const eaten = screen.getByRole("button", { name: "Mark eaten, Meal 2" });
    const swap = screen.getByRole("button", { name: "Swap Meal 2" });
    const details = screen.getByRole("button", { name: "Expand Meal 2" });
    // Icons, not words: nothing visible but the glyph.
    for (const button of [eaten, swap, details]) {
      expect(button.textContent?.trim()).toBe("");
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.closest("[data-strip-zone]")).not.toBeNull();
    }
  });

  it("shows eaten as a state on its zone: an empty ring, then a filled tick that undoes", () => {
    const onToggleEaten = vi.fn();
    const { rerender } = render(<Card onToggleEaten={onToggleEaten} />);
    const tick = screen.getByRole("button", { name: "Mark eaten, Meal 2" });
    expect(tick.getAttribute("data-eaten")).toBe("false");
    expect(tick.querySelector("[data-tick]")).toBeNull();
    fireEvent.click(tick);
    expect(onToggleEaten).toHaveBeenCalledTimes(1);
    rerender(<Card slot={{ ...lunch, eaten: true }} onToggleEaten={onToggleEaten} />);
    const done = screen.getByRole("button", { name: "Eaten, Meal 2. Undo" });
    expect(done.getAttribute("data-eaten")).toBe("true");
    expect(done.querySelector("[data-tick]")).not.toBeNull();
  });

  it("keeps three equal zones when the meal cannot swap", () => {
    render(<Card slot={{ ...lunch, eaten: true }} />);
    expect(zones()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Swap Meal 2" })).toBeNull();
  });

  it("keeps a pending eaten zone focusable, busy, and deaf to a second tap", () => {
    const onToggleEaten = vi.fn();
    render(<Card eatenFeedback="pending" onToggleEaten={onToggleEaten} />);
    const tick = screen.getByRole("button", { name: "Mark eaten, Meal 2" }) as HTMLButtonElement;
    expect(tick.getAttribute("data-feedback-state")).toBe("pending");
    expect(tick.getAttribute("aria-busy")).toBe("true");
    expect(tick.getAttribute("aria-disabled")).toBe("true");
    expect(tick.disabled).toBe(false);
    tick.focus();
    fireEvent.click(tick);
    expect(onToggleEaten).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tick);
  });

  it("leaves the spoken outcome to the page's named toast: no second live region on the card", () => {
    render(<Card slot={{ ...lunch, eaten: true }} eatenFeedback="success" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the favorite heart", () => {
  it("draws no heart until the page supplies a favorite", () => {
    render(<Card />);
    expect(document.querySelector("[data-meal-favorite]")).toBeNull();
  });

  it("toggles between an outline and a filled heart with a name that says the action", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Card favorite={{ on: false, onToggle }} />);
    const save = screen.getByRole("button", { name: "Save Chicken and rice as a favorite meal" });
    expect(save.getAttribute("data-meal-favorite")).toBe("off");
    fireEvent.click(save);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<Card favorite={{ on: true, onToggle }} />);
    expect(screen.getByRole("button", { name: "Remove Chicken and rice from favorite meals" })
      .getAttribute("data-meal-favorite")).toBe("on");
  });

  it("takes no second tap while its write is pending, and keeps focus", () => {
    const onToggle = vi.fn();
    render(<Card favorite={{ on: false, pending: true, onToggle }} />);
    const heart = screen.getByRole("button", { name: "Save Chicken and rice as a favorite meal" });
    expect(heart.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(heart);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
