// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import DayCard from "./DayCard";
import type { OverviewData } from "./overview/types";
import type { WeekSummary } from "@/lib/today/board";
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

function data(over: Partial<OverviewData> = {}): OverviewData {
  return {
    date: "2026-10-01", today: "2026-10-01", when: "today", dayType: "rest",
    targets, consumed, partial: false, water: { cups: 4, goal: 8 }, onSetCups: () => {},
    next: { slot: "meal-2", label: "Meal 2", name: "Eggs & Jasmine rice", time: "10:30", kcal: 940, protein: 42, image: null },
    planned: 3, week, ...over,
  };
}

function card(over: Partial<OverviewData>, reduced = false) {
  const node = <DayCard calendar={<div>Week calendar</div>} overview={data(over)} />;
  return reduced ? <MotionConfig reducedMotion="always">{node}</MotionConfig> : node;
}

function mount(over: Partial<OverviewData> = {}, reduced = false) {
  const onAddCup = vi.fn();
  const utils = render(card({ onAddCup, ...over }, reduced));
  return { ...utils, onAddCup };
}

const tab = (name: "Calendar" | "Overview") => screen.getByRole("tab", { name });
const panel = (name: "Calendar" | "Overview") => document.getElementById(tab(name).getAttribute("aria-controls")!)!;
const tabNames = () => screen.getAllByRole("tab").map((item) => item.textContent);
const header = () => document.querySelector<HTMLElement>('section[aria-label="Day"] header')!;
/** The live widget's one toggle: its name is the current panel's headline. */
const widget = () => screen.getByRole("button", { name: /^Calories left, 1 of 3\./ });
const toCalendar = () => fireEvent.click(tab("Calendar"));

describe("DayCard · overview", () => {
  it("opens on the overview: two tabs, Calendar and Overview, the overview selected and on show", () => {
    mount();
    expect(tabNames()).toEqual(["Calendar", "Overview"]);
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    expect(tab("Calendar").getAttribute("aria-selected")).toBe("false");
    expect(panel("Overview").getAttribute("aria-hidden")).toBeNull();
    expect(panel("Calendar").getAttribute("aria-hidden")).toBe("true");
    expect(panel("Calendar").hasAttribute("inert")).toBe(true);
    expect(panel("Overview").textContent).toContain("1,200 of 2,000 eaten");
  });

  it("holds the board's next meal inside the overview, inside the one card", () => {
    const { container } = mount();
    const day = container.querySelector('section[aria-label="Day"]')!;
    expect(panel("Overview").closest('section[aria-label="Day"]')).toBe(day);
    expect(panel("Overview").textContent).toContain("Eggs & Jasmine rice");
  });

  it("carries no date heading of its own: the page title names the day", () => {
    mount({ date: "2026-09-30" });
    expect(screen.queryByRole("heading", { name: "Yesterday" })).toBeNull();
    expect(screen.queryByText("Wednesday 30 September")).toBeNull();
  });
});

describe("DayCard · calendar", () => {
  it("holds the week and the live widget once the calendar is chosen", () => {
    mount();
    toCalendar();
    expect(tab("Calendar").getAttribute("aria-selected")).toBe("true");
    expect(panel("Calendar").getAttribute("aria-hidden")).toBeNull();
    expect(panel("Overview").getAttribute("aria-hidden")).toBe("true");
    expect(panel("Calendar").textContent).toContain("Week calendar");
    expect(within(panel("Calendar")).getByRole("region", { name: "Day widget" })).toBeTruthy();
  });

  it("collapsed, the widget says only the calories left; open, one showcase with no title, arrow or pager", () => {
    mount();
    toCalendar();
    expect(widget().textContent).toContain("800 kcal left of 2,000");
    expect(widget().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(widget());
    const toggle = screen.getByRole("button", { name: /^Calories, protein, carbs and fat, 1 of 2\. Fold the widget/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const fuel = screen.getByRole("group", { name: "Calories, protein, carbs and fat, 1 of 2" });
    expect(screen.queryByRole("group", { name: "Panels" })).toBeNull();
    expect(fuel.textContent).not.toContain("Calories left");
    const protein = within(fuel).getByRole("button", { name: "Protein: 60 grams left. Show details" });
    expect(within(fuel).getByRole("button", { name: "Carbs: 120 grams left. Show details" })).toBeTruthy();
    expect(within(fuel).getByRole("button", { name: "Fat: 40 grams left. Show details" })).toBeTruthy();
    fireEvent.click(protein);
    expect(protein.getAttribute("aria-pressed")).toBe("true");
    expect(fuel.textContent).toContain("g protein left");
    fireEvent.click(within(fuel).getByRole("button", { name: "Protein: 60 grams left. Back to all three" }));
    expect(protein.getAttribute("aria-pressed")).toBe("false");
  });

  it("moves between the widget's panels with the arrow keys", () => {
    mount();
    toCalendar();
    fireEvent.keyDown(widget(), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /^Protein, carbs and fat, 2 of 3/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Protein, carbs and fat, 2 of 3/ }), { key: "ArrowLeft" });
    expect(widget()).toBeTruthy();
  });

  it("keeps over-target amounts truthful in the widget, in words", () => {
    mount({ consumed: { kcal: 2250, protein: 165, carbs: 80, fat: 30 } });
    toCalendar();
    expect(widget().textContent).toContain("250 kcal over 2,000");
    fireEvent.keyDown(widget(), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /^Protein, carbs and fat/ }).textContent).toContain("15 grams protein over");
  });

  it("Phase 19 R2: joins the widget and selects it, closed, once its tone turns to nudge (D3, W116)", async () => {
    const onOpenSlot = vi.fn();
    const { rerender } = mount({ onOpenSlot, rebalance: { show: false } });
    toCalendar();
    rerender(card({ onOpenSlot, rebalance: {
      show: true, state: "under", tone: "nudge", copyKey: "under",
      numbers: { targetKcal: 2000, recordedKcal: 500, leftKcal: 1500, plannedKcal: 1800,
        intake: { status: "complete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false },
        proteinTargetG: 120, proteinConsumedG: 25 },
      cards: [{ slot: "meal-2", label: "Lunch", time: "12:30", kcal: 600, status: "missed", highlight: true }],
    } }));
    const toggle = () => panel("Calendar").querySelector("[data-widget-toggle]");
    await waitFor(() => expect(toggle()?.textContent).toContain("Rebalance my day"));
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle()!);
    await waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("true"));
    fireEvent.click(within(panel("Calendar")).getByRole("button", { name: "View meal" }));
    expect(onOpenSlot).toHaveBeenCalledWith("meal-2");
  });
});

describe("DayCard · without targets", () => {
  it("without targets keeps both tabs, opens on the overview, and the calendar carries the profile prompt", () => {
    const { container } = mount({ targets: null });
    expect(tabNames()).toEqual(["Calendar", "Overview"]);
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Finish your profile");
    expect(screen.queryByRole("region", { name: "Day widget", hidden: true })).toBeNull();
    // Nothing invented: no eaten-of-target line without a revision.
    expect(panel("Overview").textContent).not.toContain("kcal eaten of");
  });

  it("keeps both tabs and the chosen face when the targets go away", () => {
    const { rerender } = mount();
    toCalendar();
    rerender(card({ targets: null, next: null, planned: 0 }));
    expect(tabNames()).toEqual(["Calendar", "Overview"]);
    expect(tab("Calendar").getAttribute("aria-selected")).toBe("true");
    expect(panel("Calendar").getAttribute("aria-hidden")).toBeNull();
  });
});

describe("DayCard · header", () => {
  it("puts the day type and the cup on the first row, and the switch under them", () => {
    mount({ dayType: "training-10" });
    const rows = header().children;
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Training");
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "Add a cup of water. 4 of 8 cups." })).toBeTruthy();
    expect(rows[1].getAttribute("role")).toBe("tablist");
  });

  it("adds a cup from the header on both faces, overview and calendar", () => {
    const { onAddCup } = mount();
    const cup = () => within(header()).getByRole("button", { name: "Add a cup of water. 4 of 8 cups." });
    fireEvent.click(cup());
    expect(onAddCup).toHaveBeenCalledTimes(1);
    toCalendar();
    expect(cup().closest("[inert]")).toBeNull();
    fireEvent.click(cup());
    expect(onAddCup).toHaveBeenCalledTimes(2);
  });

  it("names the cup without a goal while the water is loading", () => {
    mount({ water: undefined, onAddCup: undefined });
    expect(within(header()).getByRole("button", { name: "Add a cup of water." })).toBeTruthy();
  });
});

describe("DayCard · face switch", () => {
  it("is a tab list with a roving tabindex: the chosen face alone is in the tab order", () => {
    mount();
    expect(screen.getByRole("tablist", { name: "Day card views" })).toBeTruthy();
    expect(tab("Overview").tabIndex).toBe(0);
    expect(tab("Calendar").tabIndex).toBe(-1);
    toCalendar();
    expect(tab("Calendar").tabIndex).toBe(0);
    expect(tab("Overview").tabIndex).toBe(-1);
  });

  it("moves between faces with the arrow keys, Home and End, and focuses the tab it lands on", () => {
    mount();
    fireEvent.keyDown(tab("Overview"), { key: "ArrowLeft" });
    expect(tab("Calendar").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Calendar"));
    fireEvent.keyDown(tab("Calendar"), { key: "ArrowRight" });
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("Overview"), { key: "Home" });
    expect(tab("Calendar").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("Calendar"), { key: "End" });
    expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    // Wraps: right from the last face is the first.
    fireEvent.keyDown(tab("Overview"), { key: "ArrowRight" });
    expect(tab("Calendar").getAttribute("aria-selected")).toBe("true");
  });
});

describe("DayCard · reduced motion", () => {
  it("switches faces without a tween under reduced motion", () => {
    mount({}, true);
    expect(panel("Overview").getAttribute("aria-hidden")).toBeNull();
    toCalendar();
    expect(panel("Calendar").getAttribute("aria-hidden")).toBeNull();
    expect(panel("Overview").getAttribute("aria-hidden")).toBe("true");
  });
});
