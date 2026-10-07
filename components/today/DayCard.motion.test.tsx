// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import DayCard from "./DayCard";
import { DAY_CARD_EXPLAINER } from "./ExplainerPlayer";
import { boardTips } from "@/lib/today/board";
import type { Macros } from "@/lib/types";

/**
 * The Day card's motion (2026-10-03): faces never remount, the card's height is held and sprung
 * between faces, the orb steps away and back, and the explainer leaves every tile mounted under it.
 * jsdom has no layout, so the faces box reads a fixed height per face from a stub.
 */
const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
const HEIGHTS = { calendar: 200, overview: 366, board: 520 } as const;

let restoreHeight: (() => void) | null = null;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = vi.fn();
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.style.height) return parseFloat(this.style.height);
      const active = this.querySelector(':scope > [role="tabpanel"][data-active]');
      return active ? HEIGHTS[active.getAttribute("data-face") as keyof typeof HEIGHTS] : 0;
    },
  });
  restoreHeight = () => { if (own) Object.defineProperty(HTMLElement.prototype, "offsetHeight", own); };
});
afterEach(() => { cleanup(); restoreHeight?.(); vi.useRealTimers(); });

function mount(reduced = false) {
  const card = <DayCard date="2026-10-01" today="2026-10-01" targets={targets} consumed={consumed}
    water={{ cups: 4, goal: 8 }} onAddCup={() => {}} onSetCups={() => {}} calendar={<div>Week calendar</div>}
    board={{
      next: { slot: "meal-2", label: "Meal 2", name: "Eggs & Jasmine rice", time: "10:30", kcal: 940, protein: 42, image: null },
      planned: 3, onMarkEaten: () => {}, tips: boardTips(), explainers: [DAY_CARD_EXPLAINER],
    }} />;
  return render(reduced ? <MotionConfig reducedMotion="always">{card}</MotionConfig> : card);
}

const tab = (name: "Calendar" | "Overview" | "Board") => screen.getByRole("tab", { name });
const panel = (name: "Calendar" | "Overview" | "Board") => document.getElementById(tab(name).getAttribute("aria-controls")!)!;
const facesBox = () => panel("Calendar").parentElement!;
const eat = (scope: HTMLElement, hidden = false) =>
  within(scope).getByRole("button", { name: "Mark Eggs & Jasmine rice eaten", hidden });
const live = (scope: HTMLElement) => scope.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]')!;
const PLAYER = "How your Day card works";

describe("DayCard · faces stay mounted", () => {
  it("switches between every face without remounting any of them or the board's tiles", () => {
    mount();
    const before = { calendar: panel("Calendar"), overview: panel("Overview"), board: panel("Board") };
    const button = eat(before.board, true);
    for (const name of ["Board", "Overview", "Calendar", "Board"] as const) fireEvent.click(tab(name));
    expect(panel("Calendar")).toBe(before.calendar);
    expect(panel("Overview")).toBe(before.overview);
    expect(panel("Board")).toBe(before.board);
    expect(eat(panel("Board"))).toBe(button);
  });
});

describe("DayCard · height", () => {
  it("holds the card at the height it had and springs it to the next face's own", async () => {
    mount();
    fireEvent.click(tab("Board"));
    expect(facesBox().style.height).toBe(`${HEIGHTS.calendar}px`);
    // Settled, the box hands its height back to its content (the month, an explainer).
    await waitFor(() => expect(facesBox().style.height).toBe(""), { timeout: 3000 });
  });

  it("takes each face's height at once under reduced motion", () => {
    mount(true);
    fireEvent.click(tab("Board"));
    expect(facesBox().style.height).toBe("");
    fireEvent.click(tab("Overview"));
    expect(facesBox().style.height).toBe("");
  });
});

describe("DayCard · explainer", () => {
  it("keeps every tile mounted under the player, so closing it reloads nothing", async () => {
    mount();
    fireEvent.click(tab("Board"));
    const board = panel("Board");
    fireEvent.click(within(board).getByRole("button", { name: "Next tip" }));
    const button = eat(board);
    const tip = live(board).textContent;
    fireEvent.click(within(board).getByRole("button", { name: "Play How your Day card works, 0:20" }));
    const player = await screen.findByRole("region", { name: PLAYER });
    // Under the player the tiles are still there, out of the flow and out of reach.
    expect(button.isConnected).toBe(true);
    expect(button.closest("[inert]")).not.toBeNull();
    expect(within(board).queryByRole("button", { name: "Mark Eggs & Jasmine rice eaten" })).toBeNull();
    expect(document.activeElement).toBe(within(player).getByRole("button", { name: `Close ${PLAYER}` }));
    fireEvent.click(within(player).getByRole("button", { name: `Close ${PLAYER}` }));
    await waitFor(() => expect(screen.queryByRole("region", { name: PLAYER })).toBeNull(), { timeout: 3000 });
    expect(eat(board)).toBe(button);
    expect(live(board).textContent).toBe(tip);
  });

  it("closes a playing explainer when the board leaves the screen", async () => {
    mount();
    fireEvent.click(tab("Board"));
    fireEvent.click(within(panel("Board")).getByRole("button", { name: "Play How your Day card works, 0:20" }));
    await screen.findByRole("region", { name: PLAYER });
    fireEvent.click(tab("Calendar"));
    await waitFor(() => expect(screen.queryByRole("region", { name: PLAYER, hidden: true })).toBeNull(), { timeout: 3000 });
  });

  it("opens and closes without a morph under reduced motion", async () => {
    mount(true);
    fireEvent.click(tab("Board"));
    fireEvent.click(within(panel("Board")).getByRole("button", { name: "Play How your Day card works, 0:20" }));
    const player = await screen.findByRole("region", { name: PLAYER });
    fireEvent.click(within(player).getByRole("button", { name: `Close ${PLAYER}` }));
    // No shrink back into the pin to wait for: the player is gone within a frame or two.
    await waitFor(() => expect(screen.queryByRole("region", { name: PLAYER })).toBeNull(), { timeout: 200 });
    await waitFor(() => expect(document.activeElement)
      .toBe(within(panel("Board")).getByRole("button", { name: "Play How your Day card works, 0:20" })));
  });
});
