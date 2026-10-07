// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import DayCard from "./DayCard";
import { DAY_CARD_EXPLAINER } from "./ExplainerPlayer";
import { boardTips, type WeekSummary } from "@/lib/today/board";
import type { Macros } from "@/lib/types";

const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
const WEEK_DATES = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const week: WeekSummary = {
  days: WEEK_DATES.map((date, index) => ({
    date, letter: "MTWTFSS"[index], kcal: index < 3 ? 1800 : 0, target: 2000,
    status: index < 3 ? "all done" : "not due yet", isToday: index === 3, isViewed: index === 3,
  })),
  onPlan: 3, elapsed: 4, averageKcal: 1800,
};

// Motion measures and restores the scroll position; jsdom has neither.
beforeEach(() => {
  window.scrollTo = () => {}; Element.prototype.scrollIntoView = vi.fn();
  // The widget remembers its panels and whether it was open; every test starts from the defaults.
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function mount(props: Partial<Parameters<typeof DayCard>[0]> = {}, reduced = false) {
  const onAddCup = vi.fn();
  const onMarkEaten = vi.fn();
  const onSelectDate = vi.fn();
  const card = <DayCard date="2026-10-01" today="2026-10-01" targets={targets} consumed={consumed}
    water={{ cups: 4, goal: 8 }} onAddCup={onAddCup} onSetCups={() => {}}
    calendar={<div>Week calendar</div>}
    board={{
      next: { slot: "meal-2", label: "Meal 2", name: "Eggs & Jasmine rice", time: "10:30", kcal: 940, protein: 42, image: null },
      planned: 3, onMarkEaten, week, onSelectDate, tips: boardTips(), explainers: [DAY_CARD_EXPLAINER],
    }} {...props} />;
  const utils = render(reduced ? <MotionConfig reducedMotion="always">{card}</MotionConfig> : card);
  return { ...utils, onAddCup, onMarkEaten, onSelectDate };
}

/** The overview opens from the face switch's eye. */
const opener = () => screen.getByRole("tab", { name: "Overview" });
/** The live widget's one toggle: its name is the current panel's headline. */
const widget = () => screen.getByRole("button", { name: /^Calories left, 1 of 3\./ });
const overview = () => panel("Overview");
const panel = (name: "Calendar" | "Overview" | "Board") =>
  document.getElementById(screen.getByRole("tab", { name }).getAttribute("aria-controls")!)!;

describe("DayCard · one card", () => {
  it("holds the week and the live widget, and opens the overview inside itself", () => {
    const { container } = mount();
    const card = container.querySelector('section[aria-label="Day"]')!;
    expect(card.textContent).toContain("Week calendar");
    expect(within(card as HTMLElement).getByRole("region", { name: "Day widget" })).toBeTruthy();
    expect(overview().getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(opener());
    expect(overview().closest('section[aria-label="Day"]')).toBe(card);
    expect(overview().getAttribute("aria-hidden")).toBeNull();
    expect(overview().textContent).toContain("Water: 4 of 8 cups");
    expect(overview().textContent).toContain("1,200 kcal eaten of 2,000");
    expect(opener().getAttribute("aria-selected")).toBe("true");
  });

  it("collapsed, the widget says only the calories left; open, one showcase with no title, arrow or pager", () => {
    mount();
    expect(widget().textContent).toContain("800 kcal left of 2,000");
    expect(widget().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(widget());
    // Open, the toggle is named for the view it folds, counted in views.
    const toggle = screen.getByRole("button", { name: /^Calories, protein, carbs and fat, 1 of 2\. Fold the widget/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // The calorie and macro panels open as one view; the saved three panels make two views.
    const fuel = screen.getByRole("group", { name: "Calories, protein, carbs and fat, 1 of 2" });
    expect(screen.queryByRole("group", { name: "Panels" })).toBeNull();
    expect(fuel.textContent).not.toContain("Calories left");
    const protein = within(fuel).getByRole("button", { name: "Protein: 60 grams left. Show details" });
    expect(within(fuel).getByRole("button", { name: "Carbs: 120 grams left. Show details" })).toBeTruthy();
    expect(within(fuel).getByRole("button", { name: "Fat: 40 grams left. Show details" })).toBeTruthy();

    // A ring opens into that macro's own figure and tube; tapping it again goes back to all three.
    fireEvent.click(protein);
    expect(protein.getAttribute("aria-pressed")).toBe("true");
    expect(fuel.textContent).toContain("g protein left");
    fireEvent.click(within(fuel).getByRole("button", { name: "Protein: 60 grams left. Back to all three" }));
    expect(protein.getAttribute("aria-pressed")).toBe("false");
  });

  it("moves between panels with the arrow keys, open or closed", () => {
    mount();
    fireEvent.keyDown(widget(), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /^Protein, carbs and fat, 2 of 3/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Protein, carbs and fat, 2 of 3/ }), { key: "ArrowLeft" });
    expect(widget()).toBeTruthy();
  });

  it("keeps over-target amounts truthful in the widget, in words", () => {
    mount({ consumed: { kcal: 2250, protein: 165, carbs: 80, fat: 30 } });
    expect(widget().textContent).toContain("250 kcal over 2,000");
    fireEvent.keyDown(widget(), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /^Protein, carbs and fat/ }).textContent).toContain("15 grams protein over");
  });

  it("opens the arrange tray from Edit: remove, move and add panels, never the last one", () => {
    mount();
    fireEvent.click(widget());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const tray = screen.getByRole("region", { name: "Arrange the widget" });
    // Phase 19 R2: "rebalance" is a real, gated panel now, not a "Coming soon" placeholder, and the
    // tray never offers it while its own gate says hidden (no rebalance prop here).
    expect(within(tray).queryByText("Coming soon")).toBeNull();
    expect(within(tray).queryByText("Rebalance my day")).toBeNull();
    fireEvent.click(within(tray).getByRole("button", { name: "Move Water up" }));
    fireEvent.click(within(tray).getAllByRole("button", { name: "Add" })[0]);
    expect(within(tray).getByText("Calories eaten")).toBeTruthy();
    fireEvent.click(within(tray).getByRole("button", { name: "Done" }));
  });

  it("Phase 19 R2: joins the widget and opens on it once its tone turns to nudge (D3)", async () => {
    const onOpenSlot = vi.fn();
    // Mounts hidden first, like the real gate (useRebalancePanel starts at show: false), then turns
    // on: the sync hook only jumps to "rebalance" on that edge, never on an already-true first render.
    const { rerender } = mount({ onOpenSlot, rebalance: { show: false } });
    rerender(
      <DayCard date="2026-10-01" today="2026-10-01" targets={targets} consumed={consumed}
        water={{ cups: 4, goal: 8 }} onAddCup={() => {}} onSetCups={() => {}}
        onOpenSlot={onOpenSlot}
        rebalance={{
          show: true, state: "under", tone: "nudge", copyKey: "under",
          numbers: { targetKcal: 2000, recordedKcal: 500, leftKcal: 1500, plannedKcal: 1800,
            intake: { status: "complete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false },
            proteinTargetG: 120, proteinConsumedG: 25 },
          cards: [{ slot: "meal-2", label: "Lunch", time: "12:30", kcal: 600, status: "missed", highlight: true }],
        }}
        calendar={<div>Week calendar</div>}
        board={{
          next: { slot: "meal-2", label: "Meal 2", name: "Eggs & Jasmine rice", time: "10:30", kcal: 940, protein: 42, image: null },
          planned: 3, onMarkEaten: () => {}, week, onSelectDate: () => {}, tips: boardTips(), explainers: [DAY_CARD_EXPLAINER],
        }} />,
    );
    // The nudge expands the widget by itself (D3) — no extra tap to open it first. The pager dot
    // carries the same accessible name once expanded, so the toggle is found by its own attribute.
    await waitFor(() => expect(document.querySelector("[data-widget-toggle]")?.getAttribute("aria-expanded"))
      .toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "View meal" }));
    expect(onOpenSlot).toHaveBeenCalledWith("meal-2");
  });

  it("without targets keeps the calendar with a profile prompt, and has no widget or overview", () => {
    const { container } = mount({ targets: null });
    expect(container.textContent).toContain("Finish your profile");
    expect(screen.queryByRole("region", { name: "Day widget" })).toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Calendar", "Board"]);
  });

  it("falls back to the calendar when the targets, and with them the overview, go away", () => {
    const { rerender } = mount();
    fireEvent.click(opener());
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    rerender(<DayCard date="2026-10-01" today="2026-10-01" targets={null} consumed={consumed}
      calendar={<div>Week calendar</div>} board={{ next: null, planned: 0, week, tips: boardTips(), explainers: [] }} />);
    expect(screen.queryByRole("tab", { name: "Overview" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Calendar" }).getAttribute("aria-selected")).toBe("true");
    expect(panel("Calendar").getAttribute("aria-hidden")).toBeNull();
  });

  it("titles the card with the viewed day", () => {
    mount({ date: "2026-09-30" });
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeTruthy();
    expect(screen.getByText("Wednesday 30 September")).toBeTruthy();
  });
});

describe("DayCard · face switch", () => {
  it("is a tab list: the chosen face is selected and its panel is the one on show", () => {
    mount();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Calendar", "Overview", "Board"]);
    expect(panel("Calendar").getAttribute("aria-hidden")).toBeNull();
    expect(panel("Board").getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe("true");
    expect(panel("Board").getAttribute("aria-hidden")).toBeNull();
    expect(panel("Calendar").getAttribute("aria-hidden")).toBe("true");
  });

  it("moves between faces with the arrow keys", () => {
    mount();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Calendar" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("DayCard · board", () => {
  it("leads with the next meal and its one action", () => {
    const { onMarkEaten } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    const board = panel("Board");
    expect(board.textContent).toContain("Eggs & Jasmine rice");
    expect(board.textContent).toContain("940 calories");
    fireEvent.click(within(board).getByRole("button", { name: "Mark Eggs & Jasmine rice eaten" }));
    expect(onMarkEaten).toHaveBeenCalledWith("meal-2");
  });

  it("takes the eaten meal's action out of reach at once while the next meal slides in", () => {
    const { rerender } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    rerender(<DayCard date="2026-10-01" today="2026-10-01" targets={targets} consumed={consumed}
      water={{ cups: 4, goal: 8 }} calendar={<div>Week calendar</div>}
      board={{ next: { slot: "meal-3", label: "Meal 3", name: "Scallops", time: "13:30", kcal: 729, protein: 40, image: null },
        planned: 3, onMarkEaten: () => {}, week, tips: boardTips(), explainers: [] }} />);
    const board = panel("Board");
    expect(within(board).queryByRole("button", { name: "Mark Eggs & Jasmine rice eaten" })).toBeNull();
    expect(within(board).getByRole("button", { name: "Mark Scallops eaten" })).toBeTruthy();
  });

  it("says every planned meal is logged when nothing is next, never a scolding", () => {
    mount({ board: { next: null, planned: 3, week, tips: boardTips(), explainers: [] } });
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(panel("Board").textContent).toContain("Every planned meal on this day is eaten.");
  });

  it("adds a cup from the water tile", () => {
    const { onAddCup } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    fireEvent.click(within(panel("Board")).getByRole("button", { name: "Add a cup of water. 4 of 8 cups." }));
    expect(onAddCup).toHaveBeenCalledOnce();
  });

  it("writes the water tile's keyboard amount through the card's own setter, once", () => {
    const onSetCups = vi.fn();
    const { onAddCup } = mount({ onSetCups });
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    const tile = within(panel("Board")).getByRole("button", { name: "Add a cup of water. 4 of 8 cups." });
    tile.focus();
    fireEvent.keyDown(tile, { key: "ArrowRight" });
    fireEvent.keyDown(tile, { key: "ArrowRight" });
    fireEvent.click(tile);
    expect(onSetCups).toHaveBeenCalledExactlyOnceWith(6);
    expect(onAddCup).not.toHaveBeenCalled();
  });

  it("focuses a storyboard explainer's close control on open, so Escape closes it from the keyboard", async () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    fireEvent.click(within(panel("Board")).getByRole("button", { name: "Play How your Day card works, 0:20" }));
    const player = await screen.findByRole("region", { name: "How your Day card works" });
    const close = within(player).getByRole("button", { name: "Close How your Day card works" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "How your Day card works" })).toBeNull());
    const pin = await within(panel("Board")).findByRole("button", { name: "Play How your Day card works, 0:20" }, { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(pin), { timeout: 3000 });
  });

  it("rotates tips and shows this week's days on plan", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    const board = panel("Board");
    expect(board.textContent).toContain("3 of 4 days on plan");
    const [, second, third] = boardTips();
    const count = boardTips().length;
    // With nothing pressing, the 1st of the month starts the tips one in (lib/today/board.ts
    // orderTips); each press moves one on, and the live region says so.
    const live = board.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]')!;
    expect(live.textContent).toBe(`Tip 1 of ${count}. ${second.title}. ${second.text}`);
    fireEvent.click(within(board).getByRole("button", { name: "Next tip" }));
    expect(live.textContent).toBe(`Tip 2 of ${count}. ${third.title}. ${third.text}`);
  });

  it("selects a day from this week's bars", () => {
    const { onSelectDate } = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    fireEvent.click(within(panel("Board")).getByRole("button", { name: /^2026-09-28: 1,800 kcal/ }));
    expect(onSelectDate).toHaveBeenCalledWith("2026-09-28");
  });

  it("grows the explainer into a player with pause and close, then returns to the pins and focus to its pin", async () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    fireEvent.click(within(panel("Board")).getByRole("button", { name: "Play How your Day card works, 0:20" }));
    const player = await screen.findByRole("region", { name: "How your Day card works" });
    expect(within(player).getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(player.textContent).toContain("Slide the week to choose a day.");
    fireEvent.click(within(player).getByRole("button", { name: "Pause" }));
    expect(within(player).getByRole("button", { name: "Play" })).toBeTruthy();
    fireEvent.click(within(player).getByRole("button", { name: "Close How your Day card works" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "How your Day card works" })).toBeNull());
    // The player shrinks back into its pin, which takes over (and takes focus) once it has landed.
    const pin = await within(panel("Board")).findByRole("button", { name: "Play How your Day card works, 0:20" }, { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(pin), { timeout: 3000 });
  });
});

describe("DayCard · reduced motion", () => {
  it("switches faces and opens the overview without a tween", () => {
    mount({}, true);
    fireEvent.click(opener());
    expect(overview().getAttribute("aria-hidden")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(panel("Board").getAttribute("aria-hidden")).toBeNull();
  });
});
