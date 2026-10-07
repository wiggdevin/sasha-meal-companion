// @vitest-environment jsdom
/**
 * Sol review (2026-10-06): "Say hello" must answer without motion. With reduced motion Sprout does
 * not hop, so its line says hello back instead — seen, and announced through the polite live line —
 * then returns to the mood line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import SproutStage from "./Sprout";
import type { PetState } from "@/lib/today/pet-mood";

const STATE: PetState = { mood: "content", vitality: 0.7, line: "Sprout is doing fine." };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SproutStage", () => {
  it("says hello back when tapped under reduced motion, then returns to its mood line", () => {
    vi.useFakeTimers();
    render(<MotionConfig reducedMotion="always"><SproutStage state={STATE} glance={null} bounce={0} /></MotionConfig>);
    const line = screen.getByText(STATE.line);
    expect(line.getAttribute("aria-live")).toBe("polite");

    fireEvent.click(screen.getByRole("button", { name: "Sprout. Say hello" }));
    expect(line.textContent).toBe("Sprout says hello back.");

    act(() => { vi.advanceTimersByTime(2400); });
    expect(line.textContent).toBe(STATE.line);
  });
});
