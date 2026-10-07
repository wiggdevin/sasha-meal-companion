import { describe, expect, it, vi } from "vitest";
import {
  clampPending, createWaterScrub, SCRUB_HOLD_MS, SCRUB_SLOP_PX, scrubSteps, type ScrubClock,
} from "@/lib/today/water-scrub";

function manualClock() {
  let pending: (() => void) | null = null;
  const clock: ScrubClock = {
    setTimeout: (fn) => { pending = fn; return 1; },
    clearTimeout: () => { pending = null; },
  };
  return { clock, fire: () => { const fn = pending; pending = null; fn?.(); } };
}

function rig() {
  const ports = { onHold: vi.fn(), onStep: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
  const { clock, fire } = manualClock();
  return { ports, fire, scrub: createWaterScrub(ports, clock) };
}

describe("the scrub's steps", () => {
  it("counts one step per 24 px near the start, then accelerates", () => {
    expect([scrubSteps(0), scrubSteps(10), scrubSteps(24), scrubSteps(48)]).toEqual([0, 0, 1, 2]);
    expect([scrubSteps(100), scrubSteps(150), scrubSteps(200)]).toEqual([8, 15, 24]);
    expect(scrubSteps(-100)).toBe(-8);
  });

  it("never takes back more than the day holds, nor passes the cap", () => {
    expect(clampPending(-9, 3)).toBe(-3);
    expect(clampPending(40, 3, 30)).toBe(27);
    expect(clampPending(5, 3)).toBe(5);
  });
});

describe("the scrub's press", () => {
  it("is a tap when lifted before the hold matures", () => {
    const { scrub, ports } = rig();
    scrub.down(100, 50, 4);
    expect(scrub.up()).toBe("tap");
    expect(ports.onHold).not.toHaveBeenCalled();
  });

  it(`opens after ${SCRUB_HOLD_MS} ms and commits the slid amount once`, () => {
    const { scrub, ports, fire } = rig();
    scrub.down(100, 50, 4);
    fire();
    expect(ports.onHold).toHaveBeenCalledOnce();
    scrub.move(124, 52);
    scrub.move(150, 70); // vertical drift does not count
    scrub.move(150, 70);
    expect(ports.onStep.mock.calls.map(([n]) => n)).toEqual([1, 3]);
    expect(scrub.up()).toBe("commit");
    expect(ports.onCommit).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("cancels when lifted back at zero", () => {
    const { scrub, ports, fire } = rig();
    scrub.down(100, 50, 4);
    fire();
    scrub.move(160, 50);
    scrub.move(100, 50);
    expect(scrub.up()).toBe("cancel");
    expect(ports.onCommit).not.toHaveBeenCalled();
    expect(ports.onCancel).toHaveBeenCalledOnce();
  });

  it("abandons a press that moves past the slop before the hold, so a scroll never logs", () => {
    const { scrub, ports, fire } = rig();
    scrub.down(100, 50, 4);
    scrub.move(100, 50 + SCRUB_SLOP_PX + 1);
    fire();
    expect(ports.onHold).not.toHaveBeenCalled();
    expect(scrub.up()).toBe("none");
  });

  it("closes with no change on cancel (Escape, a lost pointer)", () => {
    const { scrub, ports, fire } = rig();
    scrub.down(100, 50, 4);
    fire();
    scrub.move(200, 50);
    scrub.cancel();
    expect(ports.onCancel).toHaveBeenCalledOnce();
    expect(scrub.up()).toBe("none");
    expect(ports.onCommit).not.toHaveBeenCalled();
  });
});
