import { describe, expect, it, vi } from "vitest";
import { createWaterPress, cupsFromDrag, guardSelection, HOLD_MS, MAX_CUPS, PX_PER_CUP } from "./water-gesture";

function rig() {
  const ports = {
    onTap: vi.fn(), onHoldStart: vi.fn(), onAdjust: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn(),
  };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (handle: unknown) => { timers[(handle as number) - 1] = { fn: () => {}, ms: 0 }; },
  };
  const press = createWaterPress(ports, clock);
  const fireHold = () => { for (const t of timers.splice(0)) t.fn(); };
  return { ports, press, fireHold, timers };
}

describe("water press — tap", () => {
  it("a press released before the hold matures adds one cup and opens nothing", () => {
    const { ports, press, timers } = rig();
    press.down(100, 3);
    expect(timers[0]?.ms).toBe(HOLD_MS);
    press.up();
    expect(ports.onTap).toHaveBeenCalledTimes(1);
    expect(ports.onHoldStart).not.toHaveBeenCalled();
    expect(ports.onCommit).not.toHaveBeenCalled();
    expect(press.phase).toBe("idle");
  });

  it("a move before the hold matures is not an adjust", () => {
    const { ports, press } = rig();
    press.down(100, 3);
    press.move(160);
    expect(ports.onAdjust).not.toHaveBeenCalled();
  });
});

describe("water press — hold and drag", () => {
  it("opens the slider at the current count once the hold matures", () => {
    const { ports, press, fireHold } = rig();
    press.down(100, 3);
    fireHold();
    expect(ports.onHoldStart).toHaveBeenCalledWith(3);
    expect(press.phase).toBe("adjusting");
  });

  it("one cup per PX_PER_CUP of travel, right adds, left removes, and only reports changes", () => {
    const { ports, press, fireHold } = rig();
    press.down(100, 3);
    fireHold();
    press.move(100 + PX_PER_CUP);
    press.move(100 + PX_PER_CUP + 3);          // same cup, no second report
    press.move(100 - 2 * PX_PER_CUP);
    expect(ports.onAdjust.mock.calls.map((c) => c[0])).toEqual([4, 1]);
  });

  it("commits the shown count on release, and nothing when the finger came back to the start", () => {
    const a = rig();
    a.press.down(100, 3); a.fireHold(); a.press.move(100 + 2 * PX_PER_CUP); a.press.up();
    expect(a.ports.onCommit).toHaveBeenCalledWith(5);
    expect(a.ports.onTap).not.toHaveBeenCalled();

    const b = rig();
    b.press.down(100, 3); b.fireHold(); b.press.move(100 + PX_PER_CUP); b.press.move(100); b.press.up();
    expect(b.ports.onCommit).toHaveBeenCalledWith(null);
  });

  it("never goes below zero or above the ceiling", () => {
    expect(cupsFromDrag(1, -10 * PX_PER_CUP)).toBe(0);
    expect(cupsFromDrag(MAX_CUPS - 1, 10 * PX_PER_CUP)).toBe(MAX_CUPS);
  });
});

describe("water press — cancel", () => {
  it("a cancel during the press adds nothing and stops the hold timer", () => {
    const { ports, press, fireHold } = rig();
    press.down(100, 3);
    press.cancel();
    fireHold();
    expect(ports.onCancel).toHaveBeenCalledTimes(1);
    expect(ports.onTap).not.toHaveBeenCalled();
    expect(ports.onHoldStart).not.toHaveBeenCalled();
  });

  it("a cancel while adjusting closes without a commit", () => {
    const { ports, press, fireHold } = rig();
    press.down(100, 3);
    fireHold();
    press.move(100 + PX_PER_CUP);
    press.cancel();
    expect(ports.onCommit).not.toHaveBeenCalled();
    expect(ports.onCancel).toHaveBeenCalledTimes(1);
    expect(press.phase).toBe("idle");
  });
});

describe("water press — selection guard while the slider is open", () => {
  function fakeDocument() {
    const listeners = new Map<string, Array<(e: { cancelable: boolean; preventDefault: () => void }) => void>>();
    const doc = {
      body: { style: { userSelect: "auto" } },
      ranges: 1,
      getSelection() { return { removeAllRanges: () => { doc.ranges = 0; } }; },
      addEventListener(type: string, fn: (e: { cancelable: boolean; preventDefault: () => void }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      removeEventListener(type: string, fn: (e: { cancelable: boolean; preventDefault: () => void }) => void) {
        listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
      },
      fire(type: string) {
        const e = { cancelable: true, prevented: false, preventDefault() { e.prevented = true; } };
        for (const fn of listeners.get(type) ?? []) fn(e);
        return e.prevented;
      },
    };
    return doc;
  }

  it("stops text selection and page scroll under the finger, then puts everything back on release", () => {
    const doc = fakeDocument();
    const release = guardSelection(doc as unknown as Document);
    expect(doc.body.style.userSelect).toBe("none");
    expect(doc.ranges).toBe(0);
    expect(doc.fire("selectstart")).toBe(true);
    expect(doc.fire("touchmove")).toBe(true);
    release();
    expect(doc.body.style.userSelect).toBe("auto");
    expect(doc.fire("selectstart")).toBe(false);
    expect(doc.fire("touchmove")).toBe(false);
  });
});
