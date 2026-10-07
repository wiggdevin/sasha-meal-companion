// @vitest-environment jsdom
/**
 * Onboarding v2 lane 4 — GPT-6 Sol r3/r4 BLOCK: "the flagged branch in FoodsStep.tsx shows the
 * game without FoodsSafetyGate." `FoodsStep`'s default export reads
 * `process.env.NEXT_PUBLIC_CHAT_ONBOARDING` once, at module load, so this file stubs the env
 * *before* importing it (a plain top-level import in the usual `FoodsStep.test.tsx` would always
 * see today's env, not the one this test wants) and asserts the ordering through the real,
 * flag-selected component — not through `FallingFoodsStep` directly, which every other test in
 * this lane already covers.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { starterChoices } from "@/lib/foods/starter";

afterEach(cleanup);

const profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };

describe("FoodsStep (NEXT_PUBLIC_CHAT_ONBOARDING=1): the allergy gate renders before the game", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_CHAT_ONBOARDING", "1");
  });

  it("shows the allergy card, not the falling-food game, until 'No, nothing' is confirmed", async () => {
    const { default: FoodsStep } = await import("./FoodsStep");
    render(<FoodsStep choices={starterChoices([], profile)} marks={{}} onMark={vi.fn()} />);

    expect(screen.getByTestId("allergy-condition-gate")).toBeTruthy();
    expect(screen.queryByTestId("falling-food-pile")).toBeNull();
    expect(screen.queryByText("Tap the ones you love most.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "No, nothing" }));

    expect(screen.queryByTestId("allergy-condition-gate")).toBeNull();
    expect(screen.getByTestId("falling-food-pile")).toBeTruthy();
    expect(screen.getByText("Tap the ones you love most.")).toBeTruthy();
  });
});
