// @vitest-environment jsdom
/**
 * Sprout breaks through the glass for a swim (owner, 2026-10-06): a crack, Sprout through it, splashes
 * in the real water, one polite line; nothing with motion reduced, and the clack follows Sound off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import WaterSwim, { POP_MS } from "./WaterSwim";

const sound = vi.hoisted(() => ({ play: vi.fn(), muted: false }));
vi.mock("@/components/today/care/sound", () => ({ play: sound.play, readMuted: () => sound.muted }));

afterEach(() => { cleanup(); vi.useRealTimers(); sound.play.mockClear(); sound.muted = false; });

const swim = (run: number, motion: "never" | "always", onSplash = vi.fn()) => {
  const view = render(<MotionConfig reducedMotion={motion}>
    <WaterSwim run={run} active auto={false} surface={0.45} onSplash={onSplash} /></MotionConfig>);
  return { ...view, onSplash };
};
const live = (container: HTMLElement) => container.querySelector("[aria-live]")?.textContent;

describe("WaterSwim", () => {
  it("cracks the glass, sends Sprout through, splashes the water and says so", () => {
    vi.useFakeTimers();
    const { container, onSplash } = swim(1, "never");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("sprout-swim");
    expect(sound.play).toHaveBeenCalledWith("clack");
    act(() => { vi.advanceTimersByTime(POP_MS); });
    expect(live(container)).toBe("Sprout breaks through the glass for a swim.");
    act(() => { vi.advanceTimersByTime(600); });
    expect(onSplash).toHaveBeenCalledWith(expect.any(Number), 110);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(onSplash.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(live(container)).toBe("");
  });

  it("does nothing until asked", () => {
    const { container } = swim(0, "never");
    expect(container.querySelector("svg")).toBeNull();
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("plays nothing with motion reduced", () => {
    const { container, onSplash } = swim(1, "always");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(onSplash).not.toHaveBeenCalled();
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("keeps the clack quiet under Sound off", () => {
    sound.muted = true;
    swim(1, "never");
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("re-announces a swim asked for again before the last one's line cleared", () => {
    vi.useFakeTimers();
    const onSplash = vi.fn();
    const view = render(<MotionConfig reducedMotion="never">
      <WaterSwim run={1} active auto={false} surface={0.45} onSplash={onSplash} /></MotionConfig>);
    act(() => { vi.advanceTimersByTime(POP_MS); });
    expect(live(view.container)).toBe("Sprout breaks through the glass for a swim.");
    // A second swim starts mid-way through the first: the line clears first, so a screen reader
    // sees it actually change rather than stay put on the same string.
    view.rerender(<MotionConfig reducedMotion="never">
      <WaterSwim run={2} active auto={false} surface={0.45} onSplash={onSplash} /></MotionConfig>);
    expect(live(view.container)).toBe("");
    act(() => { vi.advanceTimersByTime(POP_MS); });
    expect(live(view.container)).toBe("Sprout breaks through the glass for a swim.");
  });

  it("clears its line when motion reduces mid-swim", () => {
    vi.useFakeTimers();
    const view = render(<MotionConfig reducedMotion="never">
      <WaterSwim run={1} active auto={false} surface={0.45} onSplash={vi.fn()} /></MotionConfig>);
    act(() => { vi.advanceTimersByTime(POP_MS); });
    expect(live(view.container)).toBe("Sprout breaks through the glass for a swim.");
    view.rerender(<MotionConfig reducedMotion="always">
      <WaterSwim run={1} active auto={false} surface={0.45} onSplash={vi.fn()} /></MotionConfig>);
    // The line leaves at once; it does not wait on the glass's own exit animation.
    expect(live(view.container)).toBe("");
  });

  it("stops at once when the water stops moving, and never replays that swim (Sol r1)", () => {
    vi.useFakeTimers();
    const onSplash = vi.fn();
    const at = (active: boolean) => <MotionConfig reducedMotion="never">
      <WaterSwim run={1} active={active} auto={false} surface={0.45} onSplash={onSplash} /></MotionConfig>;
    const view = render(at(true));
    act(() => { vi.advanceTimersByTime(POP_MS); });
    view.rerender(at(false));
    expect(live(view.container)).toBe("");
    // Gone at once: no crack or swimmer left playing an exit (Sol r2).
    expect(view.container.querySelector("svg")).toBeNull();
    expect(view.container.querySelector("img")).toBeNull();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onSplash).not.toHaveBeenCalled();
    sound.play.mockClear();
    view.rerender(at(true));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(sound.play).not.toHaveBeenCalled();
    expect(onSplash).not.toHaveBeenCalled();
  });

  it("lets the keyboard ask for a swim with its own button (Sol r1)", () => {
    vi.useFakeTimers();
    const { container } = swim(0, "never");
    fireEvent.click(screen.getByRole("button", { name: "Sprout, take a swim" }));
    expect(container.querySelector("svg")).not.toBeNull();
    expect(sound.play).toHaveBeenCalledWith("clack");
  });

  it("offers no swim button with motion reduced", () => {
    swim(0, "always");
    expect(screen.queryByRole("button", { name: "Sprout, take a swim" })).toBeNull();
  });
});
