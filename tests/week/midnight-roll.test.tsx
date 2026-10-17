// @vitest-environment jsdom
/**
 * Audit A070: a Week page left open across local midnight moves "today" to the new day, as the
 * Today screen does, instead of keeping yesterday until a reload.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import WeekPage from "@/app/week/page";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dayLink = (name: RegExp) => screen.getByRole("link", { name });

describe("the Week page across midnight", () => {
  it("marks the new day as today a minute after local midnight", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    // Wednesday 14 October, 23:59 local.
    vi.setSystemTime(new Date(2026, 9, 14, 23, 59, 0));
    render(<WeekPage />);
    expect(dayLink(/^Wed 14 Oct/).className).toContain("chip-on");
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(dayLink(/^Thu 15 Oct/).className).toContain("chip-on");
    expect(dayLink(/^Wed 14 Oct/).className).not.toContain("chip-on");
  });
});
