// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import WaterTile from "@/components/today/WaterTile";
import { resetWaterTiltForTests } from "@/components/today/useWaterTilt";
import type { OrbitWater } from "@/lib/today/health-orbit";
import { MAX_CUPS } from "@/lib/today/water-gesture";
import { SCRUB_HOLD_MS } from "@/lib/today/water-scrub";

const OZ: OrbitWater = { cups: 4, goal: 16, unit: "oz" };

function mount(water: OrbitWater = OZ) {
  const onAddCup = vi.fn();
  const onSetCups = vi.fn();
  const tile = (w: OrbitWater) => <MotionConfig reducedMotion="always">
    <WaterTile water={w} onAddCup={onAddCup} onSetCups={onSetCups} active />
  </MotionConfig>;
  const utils = render(tile(water));
  const button = () => screen.getByRole("button", { name: /water/i });
  return { ...utils, onAddCup, onSetCups, button, rerenderWith: (w: OrbitWater) => utils.rerender(tile(w)) };
}

/** The scrub bar's live line, when one is open. */
function barText(): string | null {
  return screen.queryAllByRole("status").map((el) => el.textContent ?? "").find((t) => t.includes("→")) ?? null;
}

function hold(button: HTMLElement, x = 100, y = 40) {
  fireEvent.pointerDown(button, { pointerId: 1, clientX: x, clientY: y, button: 0 });
  act(() => { vi.advanceTimersByTime(SCRUB_HOLD_MS + 10); });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.scrollTo = () => {};
  resetWaterTiltForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent;
});

describe("the water tile", () => {
  it("adds one step on a tap", () => {
    const { button, onAddCup, onSetCups } = mount();
    fireEvent.pointerDown(button(), { pointerId: 1, clientX: 100, clientY: 40, button: 0 });
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());
    expect(onAddCup).toHaveBeenCalledOnce();
    expect(onSetCups).not.toHaveBeenCalled();
  });

  it("reads in the account's unit and follows a change of unit", () => {
    const { button, rerenderWith } = mount();
    expect(button().getAttribute("aria-label")).toBe("Add 8 oz of water. 32 of 128 oz.");
    expect(button().textContent).toContain("of 128 oz");
    rerenderWith({ ...OZ, unit: "cups" });
    expect(button().getAttribute("aria-label")).toBe("Add a cup of water. 4 of 16 cups.");
    expect(button().textContent).toContain("of 16 cups");
    rerenderWith({ ...OZ, unit: "ml" });
    expect(button().getAttribute("aria-label")).toBe("Add 237 ml of water. 948 of 3,792 ml.");
  });

  it("opens a bar on a long press, counts as the finger slides right, and writes the total once", async () => {
    const { button, onAddCup, onSetCups } = mount();
    hold(button());
    expect(barText()).toBe("+0 oz → 32 / 128 oz");
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 124, clientY: 40 });
    expect(barText()).toBe("+8 oz → 40 / 128 oz");
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 200, clientY: 44 });
    expect(barText()).toBe("+64 oz → 96 / 128 oz");
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button()); // the click a browser fires after the lift is not a second write
    expect(onSetCups).toHaveBeenCalledExactlyOnceWith(12);
    expect(onAddCup).not.toHaveBeenCalled();
    await waitFor(() => expect(barText()).toBeNull());
  });

  it("changes nothing when let go back at zero, or on Escape", async () => {
    const { button, onAddCup, onSetCups } = mount();
    hold(button());
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 180, clientY: 40 });
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 100, clientY: 40 });
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());

    hold(button());
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 180, clientY: 40 });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(barText()).toBeNull());
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());

    expect(onSetCups).not.toHaveBeenCalled();
    expect(onAddCup).not.toHaveBeenCalled();
  });

  it("never logs a press that moves before the hold, so a scroll starting on it is just a scroll", () => {
    const { button, onAddCup, onSetCups } = mount();
    fireEvent.pointerDown(button(), { pointerId: 1, clientX: 100, clientY: 40, button: 0 });
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 100, clientY: 80 });
    act(() => { vi.advanceTimersByTime(SCRUB_HOLD_MS + 10); });
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());
    expect(barText()).toBeNull();
    expect(onAddCup).not.toHaveBeenCalled();
    expect(onSetCups).not.toHaveBeenCalled();
  });

  it("takes a pending amount from the arrow keys and logs it on Enter", () => {
    const { button, onAddCup, onSetCups } = mount();
    button().focus();
    fireEvent.keyDown(button(), { key: "ArrowRight" });
    fireEvent.keyDown(button(), { key: "ArrowRight" });
    expect(screen.getAllByRole("status").some((el) => el.textContent === "+16 oz → 48 / 128 oz")).toBe(true);
    fireEvent.click(button()); // Enter activates the button
    expect(onSetCups).toHaveBeenCalledExactlyOnceWith(6);
    expect(onAddCup).not.toHaveBeenCalled();
  });

  it("caps the keyboard amount at the scrub's own maximum", () => {
    const { button, onSetCups } = mount({ cups: MAX_CUPS - 1, goal: 16, unit: "cups" });
    button().focus();
    for (let i = 0; i < 4; i++) fireEvent.keyDown(button(), { key: "ArrowRight" });
    fireEvent.click(button());
    expect(onSetCups).toHaveBeenCalledExactlyOnceWith(MAX_CUPS);
  });

  it("drops a keyboard amount on Escape: nothing is written", () => {
    const { button, onAddCup, onSetCups } = mount();
    button().focus();
    fireEvent.keyDown(button(), { key: "ArrowRight" });
    fireEvent.keyDown(button(), { key: "Escape" });
    expect(screen.queryAllByRole("status").some((el) => el.textContent?.includes("→"))).toBe(false);
    expect(onSetCups).not.toHaveBeenCalled();
    expect(onAddCup).not.toHaveBeenCalled();
  });

  it("asks for the motion sensor on the first tap only, never on load or on a scrub", async () => {
    const requestPermission = vi.fn(async () => "granted");
    (window as unknown as { DeviceOrientationEvent: unknown }).DeviceOrientationEvent = { requestPermission };
    const { button } = mount();
    expect(requestPermission).not.toHaveBeenCalled();
    hold(button());
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 160, clientY: 40 });
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(button());
    fireEvent.click(button());
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("stays quiet when the sensor is refused", async () => {
    const requestPermission = vi.fn(async () => { throw new Error("NotAllowedError"); });
    (window as unknown as { DeviceOrientationEvent: unknown }).DeviceOrientationEvent = { requestPermission };
    const { button, onAddCup } = mount();
    fireEvent.click(button());
    await act(async () => { await Promise.resolve(); });
    expect(onAddCup).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("commits the slide against the count it opened on, capped, when a sync lands mid-slide (audit r4)", () => {
    const water = { cups: MAX_CUPS - 2, goal: 16, unit: "cups" as const };
    const { button, onSetCups, rerenderWith } = mount(water);
    hold(button());
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 400, clientY: 40 });
    rerenderWith({ ...water, cups: MAX_CUPS - 1 });
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());
    expect(onSetCups).toHaveBeenCalledExactlyOnceWith(MAX_CUPS);
  });

  it("ignores the arrows while a slide is open and drops a keyed amount, so the next tap adds one (audit r4)", () => {
    const { button, onAddCup, onSetCups } = mount();
    button().focus();
    fireEvent.keyDown(button(), { key: "ArrowRight" });
    hold(button());
    fireEvent.keyDown(button(), { key: "ArrowRight" });
    fireEvent.keyDown(button(), { key: "ArrowRight" });
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 124, clientY: 40 });
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());
    expect(onSetCups).toHaveBeenCalledExactlyOnceWith(5);
    fireEvent.click(button());
    expect(onSetCups).toHaveBeenCalledTimes(1);
    expect(onAddCup).toHaveBeenCalledOnce();
  });
});
