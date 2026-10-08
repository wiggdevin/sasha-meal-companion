// @vitest-environment jsdom
/**
 * "How Sasha works" (owner, 2026-10-08): five steps with Back / Next, Skip on every step, Escape,
 * focus kept inside and handed back, and reduced motion drawing still frames that never move.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import AppTour from "./AppTour";
import { TOUR_STEPS } from "./tour-steps";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderTour(reduced: "always" | "never" = "always") {
  const onClose = vi.fn();
  const view = render(<MotionConfig reducedMotion={reduced}><AppTour onClose={onClose} /></MotionConfig>);
  return { onClose, ...view };
}
/** The step the sheet is on, as the live line announces it ("Step 2 of 5: Your meal card"). */
const title = () => document.querySelector("[aria-live='polite']")?.textContent?.replace(/^Step \d+ of \d+: /, "");
const next = () => fireEvent.click(screen.getByRole("button", { name: /^(Next|Start using Sasha)$/ }));

describe("AppTour", () => {
  it("walks the five steps forward and back, then finishes", () => {
    const { onClose } = renderTour();
    expect(screen.getByRole("dialog", { name: "Meet Sasha" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    next();
    expect(title()).toBe("Your meal card");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(title()).toBe("Meet Sasha");
    for (const step of TOUR_STEPS.slice(1)) { next(); expect(title()).toBe(step.title); }
    expect(screen.getByText(`Step ${TOUR_STEPS.length} of ${TOUR_STEPS.length}: Ask Sasha anything`)).toBeTruthy();
    next();
    expect(onClose).toHaveBeenCalledWith("done");
  }, 15_000);

  it("teaches the card's taps and gestures in words", () => {
    renderTour();
    next();
    expect(screen.getByText("The heart saves the meal as a favorite meal.")).toBeTruthy();
    expect(screen.getByText(/three icons: Mark eaten, Swap and Expand/)).toBeTruthy();
    next();
    expect(screen.getByText(/^Mark eaten: tap to tick the meal off/)).toBeTruthy();
    expect(screen.getByText(/^Swap: other meals open inside the card/)).toBeTruthy();
    expect(screen.getByText(/Tap it again to undo/)).toBeTruthy();
    expect(screen.getByText(/Undo for 5 seconds/)).toBeTruthy();
    expect(screen.getByText(/Plan with Sasha and Log what you ate/)).toBeTruthy();
    next();
    expect(screen.getByText("Swipe right to swap.")).toBeTruthy();
    expect(screen.getByText("Swipe left to show Clear, then Delete.")).toBeTruthy();
    expect(screen.getByText(/15-minute steps/)).toBeTruthy();
  });

  it("offers Skip on every step, and Escape closes", () => {
    const { onClose } = renderTour();
    for (let i = 0; i < TOUR_STEPS.length; i += 1) {
      expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
      if (i < TOUR_STEPS.length - 1) next();
    }
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onClose).toHaveBeenCalledWith("skip");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("escape");
  });

  it("moves with the arrow keys", () => {
    renderTour();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(title()).toBe("Your meal card");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(title()).toBe("Meet Sasha");
  });

  it("takes focus, keeps Tab inside, and gives focus back on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = renderTour();
    const nextButton = screen.getByRole("button", { name: "Next" });
    expect(document.activeElement).toBe(nextButton);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Skip" }));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(nextButton);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("draws still frames under reduced motion: nothing moves with time", () => {
    vi.useFakeTimers();
    renderTour("always");
    next(); next();
    const stage = document.querySelector<HTMLElement>("[data-demo='taps']")!;
    expect(stage.dataset.still).toBe("true");
    const before = stage.innerHTML;
    expect(stage.querySelector("[data-beat]")?.getAttribute("data-beat")).toBe("7");
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(stage.innerHTML).toBe(before);
    expect(stage.querySelector("[data-finger]")?.getAttribute("style") ?? "").toContain("opacity: 0");
    // The still frame of the taps demo is the opened card, with no finger in it.
    expect(stage.textContent).toContain("Search to add");
  });

  it("plays the demo when motion is allowed", () => {
    vi.useFakeTimers();
    renderTour("never");
    const stage = document.querySelector<HTMLElement>("[data-demo='meet']")!;
    expect(stage.dataset.still).toBeUndefined();
    const beat = () => stage.querySelector("[data-beat]")?.getAttribute("data-beat");
    expect(beat()).toBe("0");
    act(() => { vi.advanceTimersByTime(750); });
    expect(beat()).toBe("1");
    act(() => { vi.advanceTimersByTime(750); });
    expect(beat()).toBe("2");
  });

  it("lets the gesture chips choose the still frame", () => {
    renderTour("always");
    next(); next(); next();
    const left = screen.getByRole("button", { name: "Swipe left" });
    fireEvent.click(left);
    expect(left.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-demo='gestures']")?.textContent).toContain("Delete");
  });
});
