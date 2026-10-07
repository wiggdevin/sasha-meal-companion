import { describe, expect, it } from "vitest";
import { ouraActivityToSamples, ouraReadinessToSamples, ouraSleepToSamples } from "@/lib/oura/map";
import { DEFAULT_TZ, healthTimeZone } from "@/lib/health/contract";
import { localDateOf } from "@/lib/health/daily";

/** usercollection/sleep, Oura API v2 shape. */
const SLEEP = { id: "sleep-1", day: "2026-09-15", bedtime_start: "2026-09-14T23:05:00-04:00",
  bedtime_end: "2026-09-15T07:11:00-04:00", total_sleep_duration: 26640, time_in_bed: 29160,
  average_heart_rate: 52.3, lowest_heart_rate: 48, average_hrv: 68, type: "long_sleep" };

/** usercollection/daily_activity. */
const ACTIVITY = { id: "act-1", day: "2026-09-15", steps: 9412, active_calories: 431,
  timestamp: "2026-09-15T04:00:00-04:00" };

/** usercollection/daily_readiness. */
const READINESS = { id: "rdy-1", day: "2026-09-15", score: 78,
  timestamp: "2026-09-15T04:00:00-04:00" };

describe("ouraSleepToSamples", () => {
  it("maps one session to asleep, in-bed, resting heart rate and HRV", () => {
    const out = ouraSleepToSamples(SLEEP);
    expect(out.map((s) => s.type)).toEqual(["sleep_asleep", "sleep_in_bed",
      "resting_heart_rate", "hrv_sdnn"]);
    expect(out[0]).toMatchObject({ value: 444, unit: "min", device_label: "Oura",
      vendor_sample_id: "sleep-1:sleep_asleep", start_time: "2026-09-15T03:05:00.000Z",
      end_time: "2026-09-15T11:11:00.000Z" });
    expect(out[1].value).toBe(486);
    expect(out[2].value).toBe(48);
  });

  it("returns nothing for a document with no duration, rather than a zero", () => {
    expect(ouraSleepToSamples({ id: "x", day: "2026-09-15" })).toEqual([]);
    expect(ouraSleepToSamples(null)).toEqual([]);
  });

  it("buckets an ordinary Eastern bedtime to the night it began, by the zone the ingest path resolved", () => {
    const out = ouraSleepToSamples(SLEEP);
    // The mapper stamps the neutral default: no region is authored in code (D1 §6.4).
    expect(out[0].tz).toBe(DEFAULT_TZ);
    // bedtime_start "2026-09-14T23:05:00-04:00" -> UTC instant "2026-09-15T03:05:00Z", which the
    // instant alone reads as the 15th. The USER's own zone - the one healthTimeZone resolves from
    // the source row, the user row and HEALTH_TZ - is what puts the instant back on the night that
    // began on the 14th.
    const userTz = healthTimeZone(null, "America/New_York", null);
    expect(localDateOf(out[0].start_time, userTz)).toBe("2026-09-14");
    expect(localDateOf(out[0].start_time, DEFAULT_TZ)).toBe("2026-09-15");
  });
});

describe("ouraActivityToSamples and ouraReadinessToSamples", () => {
  it("map steps, active energy and readiness over the local day", () => {
    const activity = ouraActivityToSamples(ACTIVITY);
    expect(activity.map((s) => [s.type, s.value])).toEqual([["step_count", 9412],
      ["active_energy", 431]]);
    expect(activity[0].vendor_sample_id).toBe("act-1:step_count");
    const readiness = ouraReadinessToSamples(READINESS);
    expect(readiness).toHaveLength(1);
    expect(readiness[0]).toMatchObject({ type: "readiness_score", value: 78, unit: "score" });
  });

  it("skips a missing metric instead of writing 0", () => {
    expect(ouraActivityToSamples({ id: "a", day: "2026-09-15" })).toEqual([]);
    expect(ouraReadinessToSamples({ id: "r", day: "2026-09-15", score: null })).toEqual([]);
  });
});
