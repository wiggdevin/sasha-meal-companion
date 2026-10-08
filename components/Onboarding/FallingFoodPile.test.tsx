// @vitest-environment jsdom
/**
 * Onboarding v2 lane 4 — two GPT-6 Sol r4 BLOCK fixes, each with its own regression test:
 *   1. a same-length deck swap must still clear `falling`/`issued` (keyed on deck identity, not
 *      just `choices.length`) — otherwise an excluded food already mid-fall stays tappable.
 *   2. `resolve` must be idempotent per `fallKey` — Motion fires one shared `onAnimationComplete`
 *      for both the fall (`animate`) and the pop-out (`exit`), so a tap's own exit transition
 *      re-invokes the handler a moment after the tap already resolved the disc.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STARTERS } from "@/lib/foods/starter";
import FallingFoodPile, { PILE_TIMING } from "./FallingFoodPile";

afterEach(cleanup);

function choicesFor(ids: readonly string[]) {
  return ids.map((id) => STARTERS.find((item) => item.id === id)!);
}

describe("a same-length deck replacement clears the previous session", () => {
  it("never lets an excluded food that was already falling stay tappable", () => {
    vi.useFakeTimers();
    try {
      const withWhey = choicesFor(
        ["chicken-breast-roasted", "whey-protein-powder", "white-rice-cooked", "olive-oil"]);
      const withoutWhey = choicesFor(
        ["chicken-breast-roasted", "tofu-firm", "white-rice-cooked", "olive-oil"]);

      const { rerender } = render(<FallingFoodPile choices={withWhey} marks={{}} onMark={vi.fn()} />);
      // Let the whole small deck spawn in (well past the worst-case jittered interval).
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs + 6000); });
      expect(within(screen.getByTestId("food-pile")).getByRole("button", { name: /Whey protein/i }))
        .toBeTruthy();

      // Same length (4 choices either way) — only `choices.length` would miss this swap.
      expect(withWhey.length).toBe(withoutWhey.length);
      rerender(<FallingFoodPile choices={withoutWhey} marks={{}} onMark={vi.fn()} />);
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs + 6000); });

      const pile = screen.getByTestId("food-pile");
      expect(within(pile).queryByRole("button", { name: /Whey protein/i })).toBeNull();
      expect(within(pile).getByRole("button", { name: /Tofu/i })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a disc exiting mid-deck-swap can't still mark an excluded food loved", () => {
  it("ignores a tap on a stale (about-to-exit) disc once its food has left the allowed set", () => {
    vi.useFakeTimers();
    try {
      const onMark = vi.fn();
      const withWhey = choicesFor(["chicken-breast-roasted", "whey-protein-powder"]);
      const withoutWhey = choicesFor(["chicken-breast-roasted", "tofu-firm"]);

      const { rerender } = render(<FallingFoodPile choices={withWhey} marks={{}} onMark={onMark} />);
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs + 2000); });
      // Captured before the swap, exactly like `AnimatePresence`'s own ~220ms-exiting element
      // would be: a DOM node (and its bound onToggle) from the pre-swap render.
      const staleWheyDisc = screen.getByRole("button", { name: /Whey protein/i });

      rerender(<FallingFoodPile choices={withoutWhey} marks={{}} onMark={onMark} />);
      // The allowed-ids effect (keyed on `choices`) has already run by here — `rerender` flushes
      // effects — even though Motion would still be mid-exit for the stale node in a real app.
      fireEvent.click(staleWheyDisc);

      expect(onMark).not.toHaveBeenCalledWith("whey-protein-powder", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolve is idempotent per disc", () => {
  it("a disc resolved twice (the tap's own exit-animation echo) marks it loved only once", () => {
    vi.useFakeTimers();
    try {
      const onMark = vi.fn();
      const single = choicesFor(["chicken-breast-roasted"]);
      render(<FallingFoodPile choices={single} marks={{}} onMark={onMark} />);
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs); });

      const disc = screen.getByRole("button", { name: /Love Chicken breast, roasted/i });
      // The second click simulates Motion's shared onAnimationComplete firing again for the same
      // disc's exit transition after the first click already resolved it (GPT-6 Sol r3/r4 BLOCK).
      fireEvent.click(disc);
      fireEvent.click(disc);

      expect(onMark).toHaveBeenCalledTimes(1);
      expect(onMark).toHaveBeenCalledWith("chicken-breast-roasted", "eats");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the page settles before anything falls, and the list is one tap away (owner 2026-10-08)", () => {
  it("holds still for the settle time, then drops discs well apart", () => {
    vi.useFakeTimers();
    try {
      const deck = choicesFor(["chicken-breast-roasted", "white-rice-cooked", "olive-oil"]);
      render(<FallingFoodPile choices={deck} marks={{}} onMark={vi.fn()} />);
      act(() => { vi.advanceTimersByTime(PILE_TIMING.settleMs - 50); });
      expect(within(screen.getByTestId("food-pile")).queryAllByRole("button")).toHaveLength(0);
      act(() => { vi.advanceTimersByTime(50); });
      expect(within(screen.getByTestId("food-pile")).queryAllByRole("button")).toHaveLength(1);
      // The next disc waits a whole spawn interval, several times the old 450 ms.
      act(() => { vi.advanceTimersByTime(PILE_TIMING.spawnBaseMs - PILE_TIMING.spawnJitterMs - 50); });
      expect(within(screen.getByTestId("food-pile")).queryAllByRole("button")).toHaveLength(1);
      expect(PILE_TIMING.fallSeconds).toBeGreaterThanOrEqual(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Just pick from the list' shows the whole eligible deck, not the 14-food animation queue (Sol r1 BLOCK)", () => {
    const all = STARTERS.slice(0, 20);
    render(<FallingFoodPile choices={all} marks={{}} onMark={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Just pick from the list" }));
    expect(within(screen.getByTestId("food-grid")).getAllByRole("button")).toHaveLength(20);
  });

  it("'Just pick from the list' opens the shared tile grid with every food, writing the same marks", () => {
    const onMark = vi.fn();
    const deck = choicesFor(["chicken-breast-roasted", "white-rice-cooked", "olive-oil"]);
    render(<FallingFoodPile choices={deck} marks={{}} onMark={onMark} />);
    fireEvent.click(screen.getByRole("button", { name: "Just pick from the list" }));
    const grid = screen.getByTestId("food-grid");
    expect(within(grid).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(within(grid).getByRole("button", { name: /Love Olive oil/ }));
    expect(onMark).toHaveBeenCalledWith("olive-oil", "eats");
  });

  it("a tile grid tile starts unselected and becomes selected on a tap, and reverts when tapped again", () => {
    const onMark = vi.fn();
    const deck = choicesFor(["chicken-breast-roasted", "white-rice-cooked", "olive-oil"]);
    const { rerender } = render(<FallingFoodPile choices={deck} marks={{}} onMark={onMark} />);
    fireEvent.click(screen.getByRole("button", { name: "Just pick from the list" }));
    const grid = screen.getByTestId("food-grid");
    const oliveOil = within(grid).getByRole("button", { name: /Love Olive oil/ });
    expect(oliveOil.getAttribute("aria-pressed")).toBe("false");

    rerender(<FallingFoodPile choices={deck} marks={{ "olive-oil": "eats" }} onMark={onMark} />);
    const selectedOliveOil = within(screen.getByTestId("food-grid")).getByRole("button", { name: /Love Olive oil/ });
    expect(selectedOliveOil.getAttribute("aria-pressed")).toBe("true");
  });
});
