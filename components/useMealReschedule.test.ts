import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ cleanups: [] as (() => void)[], setters: [] as ReturnType<typeof vi.fn>[], element: null as unknown }));
vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value === null ? harness.element : value }),
  useState: (value: unknown) => {
    const setter = vi.fn();
    harness.setters.push(setter);
    return [value, setter];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) harness.cleanups.push(cleanup);
  },
}));
vi.mock("@/lib/haptics", () => ({ selectionHaptic: vi.fn() }));
import { useMealReschedule } from "./useMealReschedule";

class CardElement extends EventTarget {
  closest() { return null; }
  getBoundingClientRect() { return { width: 300 }; }
}
function pointer(target: EventTarget, type: string, y = 400) {
  const event = Object.assign(new Event(type, { cancelable: true }),
    { pointerType: "mouse", button: 0, clientX: 100, clientY: y });
  target.dispatchEvent(event);
  return event;
}
function touch(target: EventTarget, type: string, y = 400) {
  const event = Object.assign(new Event(type, { cancelable: true }),
    { touches: [{ clientX: 100, clientY: y }] });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.setters = [];
  harness.element = new CardElement();
  vi.stubGlobal("Element", CardElement);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { body: { style: { userSelect: "text" } } }));
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerHeight: 800, getSelection: () => ({ removeAllRanges() {} }) }));
});
afterEach(() => {
  harness.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("meal rescheduling gestures", () => {
  it("leaves an ordinary finger pan uncancelled and never saves", () => {
    const save = vi.fn();
    useMealReschedule("12:00", save);
    touch(harness.element as EventTarget, "touchstart");
    expect(touch(document, "touchmove", 425).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(600);
    touch(document, "touchend", 425);
    expect(save).not.toHaveBeenCalled();
  });

  it("owns touch movement only after the hold, then saves its snapped preview", async () => {
    const save = vi.fn();
    const gesture = useMealReschedule("12:00", save);
    touch(harness.element as EventTarget, "touchstart");
    vi.advanceTimersByTime(450);
    expect(touch(document, "touchmove", 488).defaultPrevented).toBe(true);
    expect(harness.setters[0]).toHaveBeenLastCalledWith("12:30");
    expect(document.body.style.userSelect).toBe("none");
    touch(document, "touchend", 488);
    expect(harness.setters[1]).toHaveBeenLastCalledWith(null);
    expect(document.body.style.userSelect).toBe("text");
    await Promise.resolve();
    expect(save).toHaveBeenCalledExactlyOnceWith("12:30");
    expect(gesture.consumeSuppressedClick()).toBe(true);
  });

  it("supports mouse hold and drag", async () => {
    const save = vi.fn();
    useMealReschedule("12:00", save);
    pointer(harness.element as EventTarget, "pointerdown");
    vi.advanceTimersByTime(450);
    pointer(document, "pointermove", 312);
    pointer(document, "pointerup", 312);
    await Promise.resolve();
    expect(save).toHaveBeenCalledExactlyOnceWith("11:30");
  });

  it("cancels an interrupted held gesture without saving", async () => {
    const save = vi.fn();
    useMealReschedule("12:00", save);
    touch(harness.element as EventTarget, "touchstart");
    vi.advanceTimersByTime(450);
    touch(document, "touchmove", 488);
    document.dispatchEvent(new Event("touchcancel"));
    touch(document, "touchend");
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });

  it("unmounts without allowing a pending hold or release to save", async () => {
    const save = vi.fn();
    useMealReschedule("12:00", save);
    pointer(harness.element as EventTarget, "pointerdown");
    harness.cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.advanceTimersByTime(600);
    pointer(document, "pointermove", 488);
    pointer(document, "pointerup", 488);
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });
});


it("keeps scrolling through the full day while held at an edge", async () => {
  const save = vi.fn();
  useMealReschedule("12:00", save);
  pointer(harness.element as EventTarget, "pointerdown");
  vi.advanceTimersByTime(450);
  pointer(document, "pointermove", 790);
  vi.advanceTimersByTime(6000);
  expect(harness.setters[0]).toHaveBeenLastCalledWith("23:45");
  pointer(document, "pointermove", 5);
  vi.advanceTimersByTime(12000);
  expect(harness.setters[0]).toHaveBeenLastCalledWith("00:00");
  pointer(document, "pointerup", 5);
  await Promise.resolve();
  expect(save).toHaveBeenCalledExactlyOnceWith("00:00");
});

it("opens swap once for a deliberate right swipe without saving or editing", () => {
  const swap = vi.fn();
  const save = vi.fn();
  const gesture = useMealReschedule("12:00", save, swap);
  pointer(harness.element as EventTarget, "pointerdown");
  const move = Object.assign(new Event("pointermove", { cancelable: true }),
    { pointerType: "mouse", clientX: 180, clientY: 402 });
  document.dispatchEvent(move);
  expect(move.defaultPrevented).toBe(true);
  pointer(document, "pointerup", 402);
  expect(swap).toHaveBeenCalledExactlyOnceWith();
  expect(save).not.toHaveBeenCalled();
  expect(gesture.consumeSuppressedClick()).toBe(true);
});

it("cancels with Escape and restores text selection", () => {
  const save = vi.fn();
  useMealReschedule("12:00", save);
  pointer(harness.element as EventTarget, "pointerdown");
  vi.advanceTimersByTime(450);
  pointer(document, "pointermove", 488);
  document.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
  vi.advanceTimersByTime(20000);
  pointer(document, "pointerup", 488);
  expect(save).not.toHaveBeenCalled();
  expect(document.body.style.userSelect).toBe("text");
});
