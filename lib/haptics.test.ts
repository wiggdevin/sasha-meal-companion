import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMIT_SUCCESS_PATTERN, commitSuccessHaptic } from "@/lib/haptics";

afterEach(() => vi.restoreAllMocks());

describe("commitSuccessHaptic", () => {
  it("rises to its strongest pulse early, then decays over a two-second envelope", () => {
    const pulses = COMMIT_SUCCESS_PATTERN.filter((_, index) => index % 2 === 0);
    const pauses = COMMIT_SUCCESS_PATTERN.filter((_, index) => index % 2 === 1);
    const peak = pulses.indexOf(Math.max(...pulses));
    const total = COMMIT_SUCCESS_PATTERN.reduce((sum, duration) => sum + duration, 0);

    expect(COMMIT_SUCCESS_PATTERN.length % 2).toBe(1);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    for (let i = 1; i <= peak; i += 1) expect(pulses[i]).toBeGreaterThan(pulses[i - 1]);
    for (let i = peak + 1; i < pulses.length; i += 1) expect(pulses[i]).toBeLessThan(pulses[i - 1]);
    for (let i = peak + 1; i < pauses.length; i += 1) expect(pauses[i]).toBeGreaterThanOrEqual(pauses[i - 1]);
    // The peak lands inside the first quarter of the envelope; the tail trails away after it.
    const peakAt = COMMIT_SUCCESS_PATTERN.slice(0, peak * 2).reduce((sum, duration) => sum + duration, 0);
    expect(peakAt).toBeLessThan(total / 4);
    expect(total).toBeGreaterThanOrEqual(1_900);
    expect(total).toBeLessThanOrEqual(2_100);
  });

  it("passes the pattern to supported devices and stays optional elsewhere", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate });

    expect(commitSuccessHaptic()).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(COMMIT_SUCCESS_PATTERN);

    vi.stubGlobal("navigator", {});
    expect(commitSuccessHaptic()).toBe(false);
  });
});
