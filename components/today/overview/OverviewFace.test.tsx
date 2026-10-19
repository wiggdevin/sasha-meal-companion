// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import OverviewFace from "./OverviewFace";
import type { OverviewData } from "./types";
import type { WeekSummary } from "@/lib/today/board";
import type { Macros } from "@/lib/types";

/** The interim Overview face (UI makeover W0): the wells, the board without tips, and rebalance. */
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

beforeEach(() => { window.scrollTo = () => {}; Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

function data(over: Partial<OverviewData> = {}): OverviewData {
  return {
    date: "2026-10-01", today: "2026-10-01", when: "today", targets, consumed, partial: false,
    water: { cups: 4, goal: 8 },
    next: { slot: "meal-2", label: "Meal 2", name: "Eggs & Jasmine rice", time: "10:30", kcal: 940, protein: 42, image: null },
    planned: 3, week, ...over,
  };
}

function mount(over: Partial<OverviewData> = {}) {
  const onAddCup = vi.fn();
  const onMarkEaten = vi.fn();
  const onSelectDate = vi.fn();
  const utils = render(<OverviewFace data={data({ onAddCup, onMarkEaten, onSelectDate, ...over })} active />);
  return { ...utils, onAddCup, onMarkEaten, onSelectDate };
}

describe("OverviewFace · day", () => {
  it("draws the day's calories, water, active burn and recovery when a revision exists", () => {
    const { container } = mount({ body: { capability: "enabled", loading: false, row: null, offline: false, fetchedAt: null } });
    expect(container.textContent).toContain("1,200 kcal eaten of 2,000");
    expect(container.textContent).toContain("Water: 4 of 8 cups");
    for (const name of ["Active burn", "Sleep and recovery"]) expect(screen.getByRole("region", { name })).toBeTruthy();
  });

  it("invents nothing without a revision: no wells, the board stays", () => {
    const { container } = mount({ targets: null });
    expect(container.textContent).not.toContain("kcal eaten of");
    expect(container.textContent).toContain("Eggs & Jasmine rice");
  });
});

describe("OverviewFace · next meal", () => {
  it("leads with the next meal and its one action", () => {
    const { onMarkEaten } = mount();
    expect(document.body.textContent).toContain("940 calories");
    fireEvent.click(screen.getByRole("button", { name: "Mark Eggs & Jasmine rice eaten" }));
    expect(onMarkEaten).toHaveBeenCalledWith("meal-2");
  });

  it("takes the eaten meal's action out of reach at once while the next meal slides in", () => {
    const { rerender } = mount();
    rerender(<OverviewFace data={data({ next: { slot: "meal-3", label: "Meal 3", name: "Scallops", time: "13:30",
      kcal: 729, protein: 40, image: null }, onMarkEaten: () => {} })} active />);
    expect(screen.queryByRole("button", { name: "Mark Eggs & Jasmine rice eaten" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark Scallops eaten" })).toBeTruthy();
  });

  it("says every planned meal is eaten when nothing is next, never a scolding", () => {
    mount({ next: null });
    expect(document.body.textContent).toContain("Every planned meal on this day is eaten.");
  });
});

describe("OverviewFace · water and week", () => {
  it("writes the water tile's keyboard amount through the day's own setter, once", () => {
    const onSetCups = vi.fn();
    const { onAddCup, container } = mount({ onSetCups });
    const tiles = within(container).getAllByRole("button", { name: "Add a cup of water. 4 of 8 cups." });
    const tile = tiles[tiles.length - 1];
    tile.focus();
    fireEvent.keyDown(tile, { key: "ArrowRight" });
    fireEvent.keyDown(tile, { key: "ArrowRight" });
    fireEvent.click(tile);
    expect(onSetCups).toHaveBeenCalledExactlyOnceWith(6);
    expect(onAddCup).not.toHaveBeenCalled();
  });

  it("shows this week's days on plan and selects a day from its bars, with no tips or explainers", () => {
    const { onSelectDate, container } = mount();
    expect(container.textContent).toContain("3 of 4 days on plan");
    expect(screen.queryByRole("button", { name: /^Play / })).toBeNull();
    expect(container.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? "").not.toMatch(/^Tip /);
    fireEvent.click(screen.getByRole("button", { name: /^2026-09-28: 1,800 kcal/ }));
    expect(onSelectDate).toHaveBeenCalledWith("2026-09-28");
  });
});

describe("OverviewFace · rebalance", () => {
  it("shows the read-only rebalance panel only while the page passes one to show", () => {
    const onOpenSlot = vi.fn();
    const { rerender } = mount({ rebalance: { show: false } });
    expect(screen.queryByRole("button", { name: "View meal" })).toBeNull();
    rerender(<OverviewFace active data={data({ onOpenSlot, rebalance: {
      show: true, state: "under", tone: "nudge", copyKey: "under",
      numbers: { targetKcal: 2000, recordedKcal: 500, leftKcal: 1500, plannedKcal: 1800,
        intake: { status: "complete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false },
        proteinTargetG: 120, proteinConsumedG: 25 },
      cards: [{ slot: "meal-2", label: "Lunch", time: "12:30", kcal: 600, status: "missed", highlight: true }],
    } })} />);
    fireEvent.click(screen.getByRole("button", { name: "View meal" }));
    expect(onOpenSlot).toHaveBeenCalledWith("meal-2");
  });
});
