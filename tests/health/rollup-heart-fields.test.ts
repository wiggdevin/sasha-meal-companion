/**
 * T11b original-eval evidence (eighth round, finding 6) AND the standing regression assertion for the
 * two columns the ticket adds.
 *
 * `tests/health/daily.test.ts` is NOT byte-identical on `main` and on `HEAD` — T11b added its RHR,
 * HRV and readiness cases — so the eval is this file instead: the smallest behavioural file that
 * names only what the feature ADDS, and therefore the one a pre-fix checkout can fail on. The same
 * bytes are run in a temporary worktree of `main` (where `DailyHealthRow` has no such field) and here
 * on the branch (where the roll-up pins RHR to the day's minimum and HRV to the day's mean).
 */
import { describe, expect, it } from "vitest";
import { rollUpDay } from "@/lib/health/daily";
import type { NormalizedSample } from "@/lib/health/contract";

const TZ = "America/New_York";

function sample(type: "resting_heart_rate" | "hrv_sdnn", value: number, at: string):
    NormalizedSample {
  return { type, value, unit: type === "resting_heart_rate" ? "bpm" : "ms",
    start_time: at, end_time: at, tz: TZ, source_kind: "oura" };
}

describe("rollUpDay heart metrics", () => {
  it("exposes resting_heart_rate as the day's lowest sample", () => {
    const day = rollUpDay([
      sample("resting_heart_rate", 52, "2026-09-15T06:00:00Z"),
      sample("resting_heart_rate", 47, "2026-09-15T06:30:00Z"),
    ], TZ);
    expect(day.resting_heart_rate).toBe(47);
  });

  it("exposes hrv_sdnn as the day's mean", () => {
    const day = rollUpDay([
      sample("hrv_sdnn", 40, "2026-09-15T06:00:00Z"),
      sample("hrv_sdnn", 50, "2026-09-15T06:30:00Z"),
    ], TZ);
    expect(day.hrv_sdnn).toBe(45);
  });
});
