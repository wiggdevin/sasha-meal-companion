// @vitest-environment jsdom
/**
 * Sprout's moments at the pond (owner, 2026-10-07): pebbles, dancing, a workout, the tummy, a swim;
 * never the same twice in a row, each line an observation, and Sprout dozes with its rod at night.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import PondScene from "./PondScene";
import { AUTO_MOMENTS, MOMENTS, MOMENT_KEYS, momentLength, momentPose, nextMomentIn, pickMoment } from "./moments";
import { usePondMoments } from "./usePondMoments";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("moments", () => {
  it("never picks the same moment twice in a row", () => {
    for (const last of MOMENT_KEYS) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) expect(pickMoment(last, () => r)).not.toBe(last);
    }
  });

  it("never plays the tummy on its own: it is only ever asked for (it would otherwise track intake)", () => {
    expect(AUTO_MOMENTS).not.toContain("tummy");
    for (let r = 0; r < 1; r += 0.05) for (const last of [null, ...MOMENT_KEYS]) expect(pickMoment(last, () => r)).not.toBe("tummy");
  });

  it("waits 40 to 70 seconds between moments", () => {
    expect(nextMomentIn(() => 0)).toBe(40_000);
    expect(nextMomentIn(() => 0.999)).toBeLessThan(70_000);
  });

  it("steps through each moment's poses and ends", () => {
    const pebble = MOMENTS.pebble;
    expect(momentPose(pebble, 0)).toBe("rockthrow-windup");
    expect(momentPose(pebble, 500)).toBe("rockthrow-release");
    expect(momentPose(pebble, momentLength(pebble))).toBeNull();
    expect(momentPose(MOMENTS.swim, 100)).toBeNull();
    expect(momentLength(MOMENTS.swim)).toBe(4600);
  });

  it("doodles in the moss, twig poke then swish, and spins on the dance pose (owner's first list)", () => {
    expect(momentPose(MOMENTS.doodle, 0)).toBe("stick-1");
    expect(momentPose(MOMENTS.doodle, 800)).toBe("stick-2");
    expect(momentLength(MOMENTS.doodle)).toBe(4800);
    expect(MOMENTS.spin.spin).toBe(true);
    expect(momentPose(MOMENTS.spin, 100)).toBe("dance-1");
    expect(AUTO_MOMENTS).toEqual(expect.arrayContaining(["doodle", "spin"]));
  });

  it("speaks in observations, never about food, weight or what to do", () => {
    for (const key of MOMENT_KEYS) expect(MOMENTS[key].line).not.toMatch(/\b(eat|weight|fat|calorie|should|must)\b/i);
  });
});

describe("Sprout at night", () => {
  it("dozes with its rod instead of fishing", () => {
    const data = { targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
      consumed: { kcal: 1900, protein: 140, carbs: 190, fat: 65 }, partial: false };
    const { container } = render(<MotionConfig reducedMotion="always">
      <PondScene data={data} pet={{ mood: "sleepy", vitality: 0.9, line: "Sprout is asleep. Rest well." }} /></MotionConfig>);
    expect(container.querySelector("[data-on] img")?.getAttribute("src")).toContain("sprout-doze");
  });
});

describe("the moment wait", () => {
  it("holds across the short pause of every cast, so moments still come (Sol r1)", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ enabled }) => usePondMoments({ enabled, splash: () => {} }),
      { initialProps: { enabled: true } });
    // A cast every 30 s turns moments off for 2 s; the longest wait is 70 s.
    let played = false;
    for (let t = 0; t < 80_000 && !played; t += 1000) {
      rerender({ enabled: t % 30_000 < 28_000 });
      act(() => { vi.advanceTimersByTime(1000); });
      played = result.current.key !== null;
    }
    expect(played).toBe(true);
  });

  it("starts the wait again after a moment the person asked for (Sol r2)", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePondMoments({ enabled: true, splash: () => {} }));
    // Just before the earliest automatic moment could fall due, the person asks for the tummy.
    act(() => { vi.advanceTimersByTime(39_000); });
    act(() => { result.current.play("tummy"); });
    const tummy = momentLength(MOMENTS.tummy);
    act(() => { vi.advanceTimersByTime(tummy + 100); });
    expect(result.current.key).toBeNull();
    // A full fresh wait: nothing at all for the next 39 seconds.
    for (let t = 0; t < 39_000; t += 1000) {
      act(() => { vi.advanceTimersByTime(1000); });
      expect(result.current.key).toBeNull();
    }
  });
});

describe("a double tap on Sprout", () => {
  const data = { targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
    consumed: { kcal: 900, protein: 60, carbs: 90, fat: 30 }, partial: false };
  const fine = { mood: "content" as const, vitality: 0.7, line: "Sprout is doing fine." };

  it("plays the tummy and says it aloud, since the person asked for it", () => {
    render(<MotionConfig reducedMotion="never"><PondScene data={data} pet={fine} /></MotionConfig>);
    const sprout = screen.getByRole("button", { name: "Sprout. Poke" });
    fireEvent.click(sprout);
    fireEvent.click(sprout);
    expect(screen.getByText(MOMENTS.tummy.line, { selector: "[aria-live]" })).toBeTruthy();
  });

  it("is an ordinary poke when motion is reduced (no moment can play)", () => {
    render(<MotionConfig reducedMotion="always"><PondScene data={data} pet={fine} /></MotionConfig>);
    const sprout = screen.getByRole("button", { name: "Sprout. Poke" });
    fireEvent.click(sprout);
    fireEvent.click(sprout);
    expect(screen.queryByText(MOMENTS.tummy.line, { selector: "[aria-live]" })).toBeNull();
  });
});
