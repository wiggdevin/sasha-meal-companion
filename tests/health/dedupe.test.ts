import { describe, expect, it } from "vitest";
import { dedupeKey, epochSeconds } from "@/lib/health/dedupe";

describe("dedupeKey", () => {
  it("matches the generated column on the computed branch", () => {
    // 2026-09-15T13:00:00-04:00 = 1789491600; +1 h = 1789495200.
    // (The lane plan's sample literals were a day ahead of these inputs; the inputs are the intent.)
    expect(dedupeKey({ type: "step_count", start_time: "2026-09-15T13:00:00-04:00",
      end_time: "2026-09-15T14:00:00-04:00" })).toBe("step_count:1789491600|1789495200|");
  });

  it("prefixes vendor_sample_id with type when present", () => {
    expect(dedupeKey({ vendor_sample_id: "oura-sleep-2026-09-15", type: "sleep_asleep",
      start_time: "2026-09-15T03:00:00Z", end_time: "2026-09-15T10:00:00Z" }))
      .toBe("sleep_asleep:oura-sleep-2026-09-15");
  });

  it("treats an empty vendor_sample_id as absent", () => {
    expect(dedupeKey({ vendor_sample_id: "", type: "body_mass",
      start_time: "2026-09-15T11:00:00Z", end_time: "2026-09-15T11:00:00Z" }))
      .toBe("body_mass:1789470000|1789470000|");
  });

  // Finding #19: same type/start/end from two devices in one Health Auto Export payload (the
  // common Watch + iPhone case) must not collide, or one device's reading silently vanishes.
  it("folds device_label into the key so two devices sharing an hour don't collide", () => {
    const watch = dedupeKey({ type: "step_count", start_time: "2026-09-15T13:00:00-04:00",
      end_time: "2026-09-15T14:00:00-04:00", device_label: "Apple Watch" });
    const phone = dedupeKey({ type: "step_count", start_time: "2026-09-15T13:00:00-04:00",
      end_time: "2026-09-15T14:00:00-04:00", device_label: "Sasha's iPhone" });
    expect(watch).not.toBe(phone);
  });

  // Finding #91: a source that reuses one vendor_sample_id across two different sample types
  // (e.g. sleep_asleep vs sleep_in_bed derived from one exported record) must not collide, or the
  // second sample's type is silently discarded and its value stored under the first sample's type.
  it("folds type into the key even when vendor_sample_id is present", () => {
    const asleep = dedupeKey({ vendor_sample_id: "sleep-evt-42", type: "sleep_asleep",
      start_time: "2026-09-15T03:00:00Z", end_time: "2026-09-15T10:00:00Z" });
    const inBed = dedupeKey({ vendor_sample_id: "sleep-evt-42", type: "sleep_in_bed",
      start_time: "2026-09-15T03:00:00Z", end_time: "2026-09-15T10:00:00Z" });
    expect(asleep).not.toBe(inBed);
  });

  it("rounds sub-second timestamps the way numeric::bigint does", () => {
    // Postgres rounds numeric to bigint; 0.5 s rounds up, 0.4 s rounds down.
    expect(epochSeconds("2026-09-15T11:00:00.500Z")).toBe(1789470001);
    expect(epochSeconds("2026-09-15T11:00:00.400Z")).toBe(1789470000);
  });

  it("throws on a timestamp it cannot parse", () => {
    expect(() => epochSeconds("not a time")).toThrow(/not an ISO 8601 timestamp/);
  });
});
