// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CalendarFace from "./CalendarFace";
import type { OverviewData } from "./overview/types";

/** The Calendar face (UI makeover §2.1, W3): the week strip over one line about the viewed day. */
const DATA: OverviewData = {
  date: "2026-10-01", today: "2026-10-01", when: "today",
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 }, consumed: { kcal: 1200, protein: 90, carbs: 80, fat: 30 },
  partial: false, water: { cups: 4, goal: 8 }, next: null, planned: 0,
};

beforeEach(() => { window.scrollTo = () => {}; Element.prototype.scrollIntoView = vi.fn(); localStorage.clear(); });
afterEach(cleanup);

describe("CalendarFace", () => {
  it("draws the week strip over the day's line when a revision exists, and no widget", () => {
    const { container } = render(<CalendarFace calendar={<div>Week calendar</div>} data={DATA} active />);
    expect(screen.getByText("Week calendar")).toBeTruthy();
    expect(container.textContent).toContain("800 kcal left");
    expect(screen.queryByRole("region", { name: "Day widget" })).toBeNull();
  });

  it("names the next meal, or that every planned meal is eaten", () => {
    const next = { slot: "meal-2" as const, label: "Meal 2", name: "Eggs", time: "12:30", kcal: 500, protein: 30, image: null };
    const { container, rerender } = render(<CalendarFace calendar={null} data={{ ...DATA, next, planned: 4 }} />);
    expect(container.textContent).toBe("800 kcal left · Next 12:30");
    rerender(<CalendarFace calendar={null} data={{ ...DATA, next: null, planned: 4 }} />);
    expect(container.textContent).toBe("800 kcal left · All 4 meals eaten");
    rerender(<CalendarFace calendar={null} data={{ ...DATA, next: null, planned: 0 }} />);
    expect(container.textContent).toBe("800 kcal left");
  });

  it("says over and bounds a partly measured day in words", () => {
    const { container, rerender } = render(<CalendarFace calendar={null}
      data={{ ...DATA, consumed: { ...DATA.consumed, kcal: 2180 } }} />);
    expect(container.textContent).toBe("180 kcal over");
    rerender(<CalendarFace calendar={null} data={{ ...DATA, partial: true }} />);
    expect(container.textContent).toBe("at most 800 kcal left");
  });

  it("asks to finish the profile without a revision, and draws no widget", () => {
    render(<CalendarFace calendar={<div>Week calendar</div>} data={{ ...DATA, targets: null }} active />);
    expect(screen.getByText("Week calendar")).toBeTruthy();
    expect(screen.getByText("Finish your profile")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up" }).getAttribute("href")).toBe("/settings");
    expect(screen.queryByRole("region", { name: "Day widget" })).toBeNull();
  });
});
