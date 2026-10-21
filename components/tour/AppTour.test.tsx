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

  it("draws the companion as the guide, and no figure when the account hid it", () => {
    const { unmount } = render(<MotionConfig reducedMotion="always"><AppTour onClose={vi.fn()} mascot="blueberry" /></MotionConfig>);
    expect(screen.getByText(/^Blu shows you · 1 of /)).toBeTruthy();
    expect(document.querySelector("[data-pose]")).toBeTruthy();
    unmount();
    render(<MotionConfig reducedMotion="always"><AppTour onClose={vi.fn()} mascot="blueberry" guide={false} /></MotionConfig>);
    expect(screen.getByText(/^Quick tour · 1 of /)).toBeTruthy();
    expect(document.querySelector("[data-pose]")).toBeNull();
  });

  it("teaches the card's taps and gestures in words", () => {
    renderTour();
    next();
    expect(screen.getByText("Tap the heart to save this meal and favor its foods.")).toBeTruthy();
    expect(screen.getByText("The chip says Next, Now or Eaten.")).toBeTruthy();
    next();
    expect(screen.getByText("Mark eaten. Tap again to undo.")).toBeTruthy();
    expect(screen.getByText("Swap for another meal.")).toBeTruthy();
    expect(screen.getByText("Expand to change portions and foods.")).toBeTruthy();
    expect(screen.getByText("Daily share: how much of today's calories and macros this meal covers.")).toBeTruthy();
    next();
    expect(screen.getByText("Swipe right: swap.")).toBeTruthy();
    expect(screen.getByText("Swipe left: Clear, then Delete.")).toBeTruthy();
    expect(screen.getByText(/15-minute steps/)).toBeTruthy();
    next();
    expect(screen.getByText(/Plan with Sasha and Log what you ate/)).toBeTruthy();
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

  it("gives focus to the companion when what opened it has gone", () => {
    const companion = document.createElement("button");
    const bubble = document.createElement("button");
    document.body.append(companion, bubble);
    bubble.focus();
    const { unmount } = render(<MotionConfig reducedMotion="always">
      <AppTour onClose={() => {}} returnFocusTo={companion} /></MotionConfig>);
    bubble.remove();
    unmount();
    expect(document.activeElement).toBe(companion);
    companion.remove();
  });

  it("appears without any fade or growth under reduced motion", () => {
    renderTour("always");
    const panel = document.querySelector<HTMLElement>("[data-tour-panel]")!;
    const scrim = document.querySelector<HTMLElement>("[data-tour-scrim]")!;
    // Drawn at rest on the first frame: no opacity ramp and no scale or offset to spring from.
    expect(panel.style.opacity === "" || panel.style.opacity === "1").toBe(true);
    expect(scrim.style.opacity === "" || scrim.style.opacity === "1").toBe(true);
    expect(panel.style.transform).not.toMatch(/scale|translate/);
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
