// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The meal card's height (2026-10-01): the client saw opening and closing go jagged again after
 * #303 wrapped the card in AutoHeight. While its spring ran, every new measurement stopped it and
 * started a fresh one, so the box lost its speed each frame. A retarget now carries the box's
 * current velocity, and content growing by itself is still followed exactly.
 */
const animate = vi.hoisted(() => vi.fn());
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  animate: (...args: unknown[]) => { animate(...args); return { stop: vi.fn() }; },
}));

import AutoHeight from "@/components/ui/AutoHeight";

let resize: (() => void) | null = null;
let height = 100;

beforeEach(() => {
  animate.mockReset();
  height = 100;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => height });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function grow(to: number) {
  height = to;
  act(() => { resize?.(); });
}

describe("AutoHeight", () => {
  it("follows a small change exactly when nothing is running", () => {
    render(<AutoHeight><p>tray</p></AutoHeight>);
    grow(120);
    expect(animate).not.toHaveBeenCalled();
  });

  it("springs a sudden change, then retargets that spring with its velocity instead of restarting it", () => {
    render(<AutoHeight><p>tray</p></AutoHeight>);
    grow(260);
    expect(animate).toHaveBeenCalledTimes(1);
    grow(280);
    expect(animate).toHaveBeenCalledTimes(2);
    const [value, target, options] = animate.mock.calls[1] as [{ getVelocity: () => number }, number, { velocity?: number }];
    expect(target).toBe(280);
    expect(options.velocity).toBe(value.getVelocity());
  });

  it("clips only while it travels, so a focus ring or glow inside is never cut at rest", () => {
    const { container } = render(<AutoHeight><p>tray</p></AutoHeight>);
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.overflow).toBe("visible");
    grow(260);
    expect(box.style.overflow).toBe("clip");
    const [, , options] = animate.mock.calls[0] as [unknown, number, { onComplete: () => void }];
    act(() => { options.onComplete(); });
    expect(box.style.overflow).toBe("visible");
  });
});
