import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calendarDragDecision, createTapDisambiguator, quarterHours, swipeDismissDecision,
  todayDismissalKey,
} from "./presentation";

describe("Today presentation decisions", () => {
  it("calendar drag requires long hold and dominant threshold", () => {
    // A qualifying long press followed by a deliberate downward drag snaps the grid open.
    expect(calendarDragDecision(80, 0.2, 450)).toBe("expand");
    expect(calendarDragDecision(80, 0.2, 900)).toBe("expand");
    // Held too briefly: a scroll, not a calendar gesture.
    expect(calendarDragDecision(80, 0.2, 449)).toBeNull();
    expect(calendarDragDecision(200, 1.5, 120)).toBeNull();
    // Held long enough but the drag never crossed the threshold.
    expect(calendarDragDecision(12, 0.05, 600)).toBeNull();
    expect(calendarDragDecision(0, 0, 600)).toBeNull();
  });

  it("upward velocity collapses", () => {
    expect(calendarDragDecision(-60, -0.8, 0)).toBe("collapse");
    expect(calendarDragDecision(-60, -0.8, 700)).toBe("collapse");
    // A slow upward drift is not a flick.
    expect(calendarDragDecision(-20, -0.1, 0)).toBeNull();
    // Upward velocity with a net downward drag does not collapse.
    expect(calendarDragDecision(40, -0.8, 0)).toBeNull();
  });

  it("cancelled swipe does not dismiss", () => {
    // Too short, rightward, or diagonal: the card returns to where it was.
    expect(swipeDismissDecision(-20, 0)).toBeNull();
    expect(swipeDismissDecision(120, 0)).toBeNull();
    expect(swipeDismissDecision(-120, -110)).toBeNull();
    expect(swipeDismissDecision(-200, 180)).toBeNull();
    // A partial left swipe reveals Clear; a completed one dismisses.
    expect(swipeDismissDecision(-80, 6)).toBe("reveal");
    expect(swipeDismissDecision(-220, 10)).toBe("dismiss");
  });

  it("dismissal key includes account date and card", () => {
    expect(todayDismissalKey("user-a", "2026-09-28", "nutrients"))
      .toBe("smc:u:user-a:today-dismissed:2026-09-28:nutrients");
    expect(todayDismissalKey("user-b", "2026-09-28", "nutrients"))
      .not.toBe(todayDismissalKey("user-a", "2026-09-28", "nutrients"));
    expect(todayDismissalKey("user-a", "2026-09-29", "nutrients"))
      .not.toBe(todayDismissalKey("user-a", "2026-09-28", "nutrients"));
    expect(todayDismissalKey("user-a", "2026-09-28", "other"))
      .not.toBe(todayDismissalKey("user-a", "2026-09-28", "nutrients"));
  });

  it("quarter hours covers 00:00 through 23:45 in 15 minute steps", () => {
    const hours = quarterHours();
    expect(hours).toHaveLength(96);
    expect(new Set(hours).size).toBe(96);
    expect(hours[0]).toBe("00:00");
    expect(hours[1]).toBe("00:15");
    expect(hours[48]).toBe("12:00");
    expect(hours[95]).toBe("23:45");
    for (const value of hours) expect(value).toMatch(/^([01]\d|2[0-3]):(00|15|30|45)$/);
  });
});

describe("createTapDisambiguator", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keyboard click detail 0 edits immediately", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();
    createTapDisambiguator(onSingle, onDouble).click(0);
    expect(onSingle).toHaveBeenCalledOnce();
    expect(onDouble).not.toHaveBeenCalled();
  });

  it("a pointer single waits 220 ms", () => {
    const onSingle = vi.fn();
    const tap = createTapDisambiguator(onSingle, vi.fn());
    tap.click(1);
    vi.advanceTimersByTime(219);
    expect(onSingle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSingle).toHaveBeenCalledOnce();
  });

  it("double tap cancels pending single tap", () => {
    const onSingle = vi.fn();
    const onDouble = vi.fn();
    const tap = createTapDisambiguator(onSingle, onDouble);
    tap.click(1);
    vi.advanceTimersByTime(120);
    tap.click(2);
    // A third click in the same burst must not expand a second time.
    tap.click(3);
    vi.advanceTimersByTime(1000);
    expect(onSingle).not.toHaveBeenCalled();
    expect(onDouble).toHaveBeenCalledOnce();
  });

  it("cancel clears the pending timer", () => {
    const onSingle = vi.fn();
    const tap = createTapDisambiguator(onSingle, vi.fn());
    tap.click(1);
    tap.cancel();
    vi.advanceTimersByTime(1000);
    expect(onSingle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
