import { describe, expect, it } from "vitest";
import { rollUpDay } from "./daily";
import type { NormalizedSample } from "@/lib/health/contract";

function sample(overrides: Partial<NormalizedSample>): NormalizedSample {
  return {
    type: "body_mass",
    value: 140,
    unit: "kg",
    start_time: "2026-09-13T12:00:00.000Z",
    end_time: "2026-09-13T12:00:00.000Z",
    tz: "America/New_York",
    ...overrides,
  };
}

describe("rollUpDay body_mass canonicalization", () => {
  it("converts a non-canonical unit (lb) to kg instead of trusting the raw value", () => {
    // finding #53: a legacy-migrated weigh-in stores unit "lb" with the raw pounds value.
    // rollUpDay must not treat that value as already-kg.
    const row = rollUpDay([sample({ value: 140, unit: "lb" })], "America/New_York");
    expect(row.body_mass_kg).not.toBe(140);
    expect(row.body_mass_kg).toBeCloseTo(63.503, 2);
  });

  it("still passes a canonical kg sample through unchanged", () => {
    const row = rollUpDay([sample({ value: 63.5, unit: "kg" })], "America/New_York");
    expect(row.body_mass_kg).toBeCloseTo(63.5, 3);
  });
});
