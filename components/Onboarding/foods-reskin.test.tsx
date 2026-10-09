// @vitest-environment jsdom
/**
 * Onboarding v2 lane 4 — the three tests the brief names explicitly for this lane, plus the
 * safety-gate ordering guarantee:
 *   1. a seeded allergy means the excluded category is absent from both the legacy falling-food
 *      deck AND the pilot/open-world top-pick chip list (BRIEF §6 lane 4 "Tests" column).
 *   2. a reduced-motion snapshot: the grid variant, no spring-in wrapper.
 *   3. the allergy/condition card always renders before any food UI, for both account types.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { starterChoices } from "@/lib/foods/starter";
import { FallingFoodsStep } from "./FoodsStep";
import FoodsTopPickChips from "./FoodsTopPickChips";
import FoodsSafetyGate from "./FoodsSafetyGate";

/** This whole file renders under reduced motion: the category-filtering assertions below do not
 *  depend on it, and it lets the one reduced-motion test below share the same render setup. */
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()), useReducedMotion: () => true,
}));

afterEach(cleanup);

const profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
const dairyProfile = { ...profile, avoid_allergens: ["dairy"] };
/** Two starters whose own dairy allergen is on the STARTERS table, picked so neither name is a
 *  substring of a non-dairy starter's name (unlike "butter", inside "peanut butter") — proves the
 *  assertion is about the dairy category, not a single food's name. */
const DAIRY_NAMES = [/Whey protein/i, /Greek yogurt/i];

/** `FallingFoodsStep` renders its own `FoodsSafetyGate` first — clear it before asserting
 *  anything about the deck/grid underneath. */
function confirmNoAllergy(): void {
  fireEvent.click(screen.getByRole("button", { name: "No, nothing" }));
}

describe("a seeded allergy excludes its category from both onboarding food surfaces", () => {
  it("is absent from the legacy falling-food deck", () => {
    render(<FallingFoodsStep choices={starterChoices([], dairyProfile)} marks={{}} onMark={vi.fn()} />);
    confirmNoAllergy();
    for (const name of DAIRY_NAMES) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("is absent from the pilot/open-world top-pick chip list", () => {
    render(<FoodsTopPickChips choices={starterChoices([], dairyProfile)} marks={{}}
      onMark={vi.fn()} />);
    for (const name of DAIRY_NAMES) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("a clear profile shows starters on both the legacy deck and the top-pick chip list "
    + "(the exclusion above is the allergy, not a bug)", () => {
    const { unmount } = render(<FallingFoodsStep choices={starterChoices([], profile)} marks={{}}
      onMark={vi.fn()} />);
    confirmNoAllergy();
    expect(screen.getByRole("button", { name: /Love Chicken breast, roasted/i })).toBeTruthy();
    unmount();
    render(<FoodsTopPickChips choices={starterChoices([], profile)} marks={{}} onMark={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Love Chicken breast, roasted/i })).toBeTruthy();
  });
});

describe("pilot/open-world top picks are balanced across roles", () => {
  it("offers carbs and fats, not only proteins, for a clear omnivore profile", async () => {
    const { topPickChoices } = await import("./FoodsTopPickChips");
    const picks = topPickChoices(starterChoices([], profile));
    expect(picks.some((item) => item.role === "protein")).toBe(true);
    expect(picks.some((item) => item.role === "carb")).toBe(true);
    expect(picks.some((item) => item.role === "fat")).toBe(true);
  });
});

describe("FoodsStep reduced motion", () => {
  it("renders a static 4-column grid (VISUAL-SPEC.md §6) with no spring-in wrapper, no falling", () => {
    render(<FallingFoodsStep choices={starterChoices([], profile)} marks={{}} onMark={vi.fn()} />);
    confirmNoAllergy();
    const grid = screen.getByTestId("food-grid");
    expect(grid.className).toContain("grid-cols-4");
    // No motion wrapper div sits between the grid and a disc under reduced motion.
    expect(grid.firstElementChild?.tagName).toBe("BUTTON");
    // The whole eligible deck, not the fall's 14-food cap (Sol r2 BLOCK, owner 2026-10-08): with
    // no animation there is no reason to hide foods, and the grid is the only way to reach them.
    // Still the safety-filtered deck, never the whole catalog.
    const deck = starterChoices([], profile);
    expect(deck.length).toBeGreaterThan(14);
    expect(grid.querySelectorAll("button").length).toBe(deck.length);
  });
});

describe("safety gate: the allergy/condition card renders before any food UI", () => {
  it("shows the allergy card, not the food UI, until an answer is confirmed — for both surfaces", () => {
    const onConfirmNone = vi.fn();
    const { rerender } = render(<FoodsSafetyGate confirmed={false} answer={null}
      onConfirmNone={onConfirmNone} onAddRule={vi.fn()} onRulesConfirmed={vi.fn()}>
      <div data-testid="food-ui">food ui</div>
    </FoodsSafetyGate>);
    expect(screen.getByTestId("allergy-condition-gate")).toBeTruthy();
    expect(screen.queryByTestId("food-ui")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "No, nothing" }));
    expect(onConfirmNone).toHaveBeenCalledTimes(1);
    rerender(<FoodsSafetyGate confirmed answer="none" onConfirmNone={onConfirmNone}
      onAddRule={vi.fn()} onRulesConfirmed={vi.fn()}>
      <div data-testid="food-ui">food ui</div>
    </FoodsSafetyGate>);
    expect(screen.queryByTestId("allergy-condition-gate")).toBeNull();
    expect(screen.getByTestId("food-ui")).toBeTruthy();
  });

  it("opening the rule editor does NOT by itself unlock food UI — only 'I'm done' does", () => {
    const onRulesConfirmed = vi.fn();
    render(<FoodsSafetyGate confirmed={false} answer={null} onConfirmNone={vi.fn()}
      onAddRule={vi.fn()} onRulesConfirmed={onRulesConfirmed}>
      <div data-testid="food-ui">food ui</div>
    </FoodsSafetyGate>);
    fireEvent.click(screen.getByRole("button", { name: "Allergy or rule" }));
    expect(screen.queryByTestId("food-ui")).toBeNull();
    expect(onRulesConfirmed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I’m done — continue" }));
    expect(onRulesConfirmed).toHaveBeenCalledTimes(1);
  });

  it("holds the gate the same way for a pilot/open-world account's chip list", () => {
    const { rerender } = render(<FoodsSafetyGate confirmed={false} answer={null}
      onConfirmNone={vi.fn()} onAddRule={vi.fn()} onRulesConfirmed={vi.fn()}>
      <FoodsTopPickChips choices={starterChoices([], profile)} marks={{}} onMark={vi.fn()} />
    </FoodsSafetyGate>);
    expect(screen.getByTestId("allergy-condition-gate")).toBeTruthy();
    expect(screen.queryByTestId("foods-top-pick-chips")).toBeNull();
    rerender(<FoodsSafetyGate confirmed answer="none" onConfirmNone={vi.fn()} onAddRule={vi.fn()}
      onRulesConfirmed={vi.fn()}>
      <FoodsTopPickChips choices={starterChoices([], profile)} marks={{}} onMark={vi.fn()} />
    </FoodsSafetyGate>);
    expect(screen.getByTestId("foods-top-pick-chips")).toBeTruthy();
  });
});
