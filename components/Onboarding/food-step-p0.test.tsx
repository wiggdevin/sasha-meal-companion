// @vitest-environment jsdom
/**
 * Live QA 2026-10-07 (defect 3): the food step's lanes, end state, remount and pick-for-me rules.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STARTERS, type StarterMark } from "@/lib/foods/starter";
import FallingFoodPile, { buildQueue, pickLane } from "./FallingFoodPile";
import { pickForMeIds } from "./FoodsStep";

afterEach(cleanup);

describe("pickLane", () => {
  it("never reuses a lane within the cooldown and never draws a staircase", () => {
    let game = { issued: 0, laneUsedAt: [-3, -3, -3, -3], lastLane: -2 };
    const lanes: number[] = [];
    for (let i = 0; i < 40; i++) {
      const lane = pickLane(game, (i * 0.37) % 1)!;
      expect(lane).not.toBeNull();
      lanes.push(lane);
      const laneUsedAt = game.laneUsedAt.slice(); laneUsedAt[lane] = game.issued;
      game = { issued: game.issued + 1, laneUsedAt, lastLane: lane };
    }
    for (let i = 1; i < lanes.length; i++) expect(lanes[i]).not.toBe(lanes[i - 1]);
    for (let i = 2; i < lanes.length; i++) expect(lanes[i]).not.toBe(lanes[i - 2]);
    // Not `n % 4`: the sequence is not a fixed rotation.
    expect(lanes.join(",")).not.toBe(lanes.map((_, i) => i % 4).join(","));
  });
});

describe("pickForMeIds", () => {
  const choices = STARTERS;
  it("fills only the groups still short and never touches a tap", () => {
    const proteins = choices.filter((item) => item.role === "protein").slice(0, 2);
    const marks: Record<string, StarterMark> = Object.fromEntries(proteins.map((item) => [item.id, "eats"]));
    const carb = choices.find((item) => item.role === "carb" && !item.default)!;
    marks[carb.id] = "eats";
    const picked = pickForMeIds(choices, marks);
    const roleOf = (id: string) => choices.find((item) => item.id === id)!.role;
    expect(picked.filter((id) => roleOf(id) === "protein")).toEqual([]);
    expect(picked.filter((id) => roleOf(id) === "carb")).toHaveLength(1);
    expect(picked.filter((id) => roleOf(id) === "fat")).toHaveLength(2);
    expect(picked).not.toContain(carb.id);
  });

  it("raises a group's count when the plan needs more proteins", () => {
    const picked = pickForMeIds(choices, {}, { protein: 4 });
    expect(picked.filter((id) => choices.find((item) => item.id === id)!.role === "protein")).toHaveLength(4);
  });
});

describe("FallingFoodPile end state and remount", () => {
  const deck = ["chicken-breast-roasted", "white-rice-cooked", "olive-oil"]
    .map((id) => STARTERS.find((item) => item.id === id)!);

  it("shows the instruction, and never replays foods the caller already saw", () => {
    vi.useFakeTimers();
    try {
      const onShown = vi.fn();
      render(<FallingFoodPile choices={deck} marks={{}} onMark={vi.fn()}
        shownIds={["chicken-breast-roasted", "white-rice-cooked"]} onShown={onShown} />);
      screen.getByText("Tap the foods you love");
      act(() => { vi.advanceTimersByTime(2000); });
      const pile = screen.getByTestId("food-pile");
      expect(within(pile).queryByRole("button", { name: /Chicken/ })).toBeNull();
      within(pile).getByRole("button", { name: /Olive oil/ });
      expect(onShown).toHaveBeenCalledWith("olive-oil");
    } finally {
      vi.useRealTimers();
    }
  });

  it("once everything has been shown, shows a grid of it with the taps kept", () => {
    render(<FallingFoodPile choices={deck} marks={{ "olive-oil": "eats" }} onMark={vi.fn()}
      shownIds={deck.map((item) => item.id)} onShown={vi.fn()} />);
    const grid = screen.getByTestId("food-grid");
    expect(within(grid).getAllByRole("button")).toHaveLength(3);
    expect(within(grid).getByRole("button", { name: /Olive oil/ }).getAttribute("aria-pressed")).toBe("true");
    expect(buildQueue(deck)).toHaveLength(3);
  });
});
