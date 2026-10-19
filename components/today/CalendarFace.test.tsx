// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CalendarFace from "./CalendarFace";
import type { OverviewData } from "./overview/types";

/** The interim Calendar face (UI makeover W0): the week strip over the live widget. */
const DATA: OverviewData = {
  date: "2026-10-01", today: "2026-10-01", when: "today",
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 }, consumed: { kcal: 1200, protein: 90, carbs: 80, fat: 30 },
  partial: false, water: { cups: 4, goal: 8 }, next: null, planned: 0,
};

beforeEach(() => { window.scrollTo = () => {}; Element.prototype.scrollIntoView = vi.fn(); localStorage.clear(); });
afterEach(cleanup);

describe("CalendarFace", () => {
  it("draws the week strip over the live widget when a revision exists", () => {
    render(<CalendarFace calendar={<div>Week calendar</div>} data={DATA} active />);
    expect(screen.getByText("Week calendar")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Day widget" })).toBeTruthy();
  });

  it("asks to finish the profile without a revision, and draws no widget", () => {
    render(<CalendarFace calendar={<div>Week calendar</div>} data={{ ...DATA, targets: null }} active />);
    expect(screen.getByText("Week calendar")).toBeTruthy();
    expect(screen.getByText("Finish your profile")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up" }).getAttribute("href")).toBe("/settings");
    expect(screen.queryByRole("region", { name: "Day widget" })).toBeNull();
  });
});
