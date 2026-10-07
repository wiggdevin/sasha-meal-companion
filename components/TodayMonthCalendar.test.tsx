// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import TodayMonthCalendar from "./TodayMonthCalendar";

afterEach(cleanup);

function renderCalendar(reducedMotion = false) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const utils = render(<TodayMonthCalendar date="2026-09-17" start="2026-09-14" today="2026-09-18"
    onSelect={onSelect} onClose={onClose} reducedMotion={reducedMotion}
    dayStatus={() => ({ label: "not due yet", dot: "var(--color-primary)" })} />);
  return { ...utils, onSelect, onClose };
}

describe("TodayMonthCalendar", () => {
  it("adds exactly four contiguous weeks after the visible seven-day strip", () => {
    renderCalendar();
    const month = screen.getByRole("group", { name: "Following four weeks" });
    const days = month.querySelectorAll("button[data-date]");
    expect(days).toHaveLength(28);
    expect(days[0].getAttribute("data-date")).toBe("2026-09-21");
    expect(days[27].getAttribute("data-date")).toBe("2026-10-18");
    expect(month.querySelector("h3")).toBeNull();
    expect(month.querySelector("input[type=date]")).toBeNull();
    expect(within(month).queryByRole("button", { name: "Next month" })).toBeNull();
  });

  it("uses the same weekday, date, and completion-dot cell structure as the week", () => {
    renderCalendar();
    const first = screen.getByRole("button", { name: "Monday 21 September 2026, not due yet" });
    expect(first.textContent).toBe("Mon21");
    expect(first.querySelector("[aria-hidden=true]")).not.toBeNull();
    expect(first.className).toContain("h-14");
    expect(first.className).toContain("min-w-11");
  });

  it("selects a day without closing the expanded card", () => {
    const { onSelect, onClose } = renderCalendar();
    fireEvent.click(screen.getByRole("button", { name: "Tuesday 22 September 2026, not due yet" }));
    expect(onSelect).toHaveBeenCalledWith("2026-09-22", expect.any(Number));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes with Escape and supports arrow-key day focus", () => {
    const { onClose } = renderCalendar();
    const monday = screen.getByRole("button", { name: "Monday 21 September 2026, not due yet" });
    fireEvent.keyDown(monday, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Tuesday 22 September 2026, not due yet" }));
    fireEvent.keyDown(monday, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the grid scrollable on narrow phones and honors reduced motion", () => {
    const moving = renderCalendar();
    const month = screen.getByRole("group", { name: "Following four weeks" });
    expect(month.className).toContain("overflow-x-auto");
    expect(month.className).toContain("today-month-enter");
    moving.unmount();
    renderCalendar(true);
    expect(screen.getByRole("group", { name: "Following four weeks" }).className)
      .not.toContain("today-month-enter");
  });
});
