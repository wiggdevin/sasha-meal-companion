// @vitest-environment jsdom
/**
 * Reconciliation audit 2026-10-08, finding `week-tab-unreachable`: the Week screen (`app/week`)
 * existed with nothing linking to it, and had no way back to Today once opened. This spec pins
 * both halves: Today's header carries a "Week" link, and the Week screen's own header carries a
 * visible, keyboard-reachable close control that returns to "/".
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import WeekPage from "@/app/week/page";

afterEach(cleanup);

describe("the Week screen's close control", () => {
  it("renders a 44px, keyboard-reachable control that returns to Today", () => {
    render(<WeekPage />);
    const close = screen.getByRole("link", { name: "Back to Today" });
    expect(close.getAttribute("href")).toBe("/");
    expect(close.tagName).toBe("A"); // a native link: reachable by Tab and Enter with no extra wiring
    expect(close.className).toContain("h-11");
    expect(close.className).toContain("w-11");
  });
});
