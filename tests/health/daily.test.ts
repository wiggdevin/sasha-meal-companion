import { describe, expect, it } from "vitest";
import { emptyDay, localDateOf, rollUpDay } from "@/lib/health/daily";
import type { NormalizedSample } from "@/lib/health/contract";

const TZ = "America/New_York";
const s = (over: Partial<NormalizedSample> & Pick<NormalizedSample, "type" | "value">):
  NormalizedSample => ({ unit: "count", start_time: "2026-09-15T17:00:00Z",
    end_time: "2026-09-15T18:00:00Z", tz: TZ, ...over });

describe("localDateOf", () => {
  it("puts a 23:30 local sample on that local date, not the UTC one", () => {
    expect(localDateOf("2026-09-16T03:30:00Z", TZ)).toBe("2026-09-15");
  });
  it("rolls a DST-change day up once", () => {
    expect(localDateOf("2026-11-01T05:30:00Z", TZ)).toBe("2026-11-01");
    expect(localDateOf("2026-11-01T06:30:00Z", TZ)).toBe("2026-11-01");
  });
});

describe("rollUpDay", () => {
  it("prefers the Watch on an overlap and keeps the phone's uncovered span", () => {
    const day = rollUpDay([
      s({ type: "step_count", value: 1000, device_label: "Apple Watch" }),
      s({ type: "step_count", value: 600, device_label: "Sasha's iPhone",
        start_time: "2026-09-15T17:30:00Z", end_time: "2026-09-15T18:30:00Z" }),
    ], TZ);
    expect(day.local_date).toBe("2026-09-15");
    expect(day.steps).toBe(1300);
    expect(day.sources).toEqual(["Apple Watch", "Sasha's iPhone"]);
  });

  it("prefers Oura sleep over Apple and reports minutes", () => {
    const day = rollUpDay([
      s({ type: "sleep_asleep", value: 402, unit: "min", device_label: "Apple Watch" }),
      s({ type: "sleep_asleep", value: 444, unit: "min", device_label: "Oura" }),
    ], TZ);
    expect(day.sleep_minutes).toBe(444);
  });

  it("names the sample that contributed, never one fully overlapped by a preferred source", () => {
    const day = rollUpDay([
      s({ type: "step_count", value: 1000, device_label: "Old export",
        source_kind: "health_auto_export" }),
      s({ type: "step_count", value: 600, device_label: "Sasha's iPhone",
        source_kind: "apple_health_shortcut", start_time: "2026-09-15T17:10:00Z",
        end_time: "2026-09-15T17:50:00Z" }),
    ], TZ);
    // The phone sits entirely inside the watch's hour: it added no steps, so it is not the source.
    expect(day.steps).toBe(1000);
    expect(day.provenance.step_count).toEqual({ kind: "health_auto_export",
      end: "2026-09-15T18:00:00Z" });
  });

  it("attributes sleep to the max-value winner, not the sample that started (or ended) last", () => {
    const day = rollUpDay([
      s({ type: "sleep_asleep", value: 500, unit: "min", device_label: "Old export",
        source_kind: "health_auto_export", start_time: "2026-09-15T11:00:00Z",
        end_time: "2026-09-15T12:00:00Z" }),
      s({ type: "sleep_asleep", value: 400, unit: "min", device_label: "Sasha's iPhone",
        source_kind: "apple_health_shortcut", start_time: "2026-09-15T13:00:00Z",
        end_time: "2026-09-15T14:00:00Z" }),
    ], TZ);
    expect(day.sleep_minutes).toBe(500);
    expect(day.provenance.sleep_asleep).toEqual({ kind: "health_auto_export",
      end: "2026-09-15T12:00:00Z" });
  });

  it("takes the latest weigh-in of the local day and leaves the rest null", () => {
    const day = rollUpDay([
      s({ type: "body_mass", value: 57.7, unit: "kg", start_time: "2026-09-15T11:12:00Z",
        end_time: "2026-09-15T11:12:00Z" }),
      s({ type: "body_mass", value: 57.5, unit: "kg", start_time: "2026-09-15T22:00:00Z",
        end_time: "2026-09-15T22:00:00Z" }),
    ], TZ);
    expect(day.body_mass_kg).toBe(57.5);
    expect(day.steps).toBeNull();
    expect(day.active_kcal).toBeNull();
    expect(day.sleep_minutes).toBeNull();
  });

  it("a day with no weigh-in yields null, never 0", () => {
    expect(rollUpDay([s({ type: "step_count", value: 10 })], TZ).body_mass_kg).toBeNull();
  });

  it("takes RHR as the day's lowest sample and HRV as the day's mean, naming each", () => {
    const day = rollUpDay([
      s({ type: "resting_heart_rate", value: 52, unit: "bpm", source_kind: "oura" }),
      s({ type: "resting_heart_rate", value: 47, unit: "bpm", source_kind: "oura",
        start_time: "2026-09-15T19:00:00Z", end_time: "2026-09-15T19:05:00Z" }),
      s({ type: "hrv_sdnn", value: 40, unit: "ms", source_kind: "oura" }),
      s({ type: "hrv_sdnn", value: 50, unit: "ms", source_kind: "apple_health_shortcut",
        start_time: "2026-09-15T19:00:00Z", end_time: "2026-09-15T19:05:00Z" }),
    ], TZ);
    expect(day.resting_heart_rate).toBe(47);
    expect(day.hrv_sdnn).toBe(45);
    // The minimum is the value, so the minimum's own sample is the one named — not the newest.
    expect(day.provenance.resting_heart_rate).toEqual({ kind: "oura",
      end: "2026-09-15T19:05:00Z" });
    // A mean has no single contributor, so it names the newest sample behind it.
    expect(day.provenance.hrv_sdnn).toEqual({ kind: "apple_health_shortcut",
      end: "2026-09-15T19:05:00Z" });
  });

  it("leaves both heart metrics null on a day that carries neither", () => {
    const day = rollUpDay([s({ type: "step_count", value: 10 })], TZ);
    expect(day.resting_heart_rate).toBeNull();
    expect(day.hrv_sdnn).toBeNull();
    expect(day.provenance.resting_heart_rate).toBeUndefined();
    expect(day.provenance.hrv_sdnn).toBeUndefined();
  });

  // Eighth round, finding 4: the SQL `daily_health` view returns `min(value)` and `avg(value)` at full
  // numeric precision, so the roll-up must too — rounding here made the two read paths disagree about
  // the same day (47 against 47.4). The renderer is the only place that rounds.
  it("keeps a fractional RHR and HRV exactly as the samples gave them", () => {
    const day = rollUpDay([
      s({ type: "resting_heart_rate", value: 52.5, unit: "bpm", source_kind: "oura" }),
      s({ type: "resting_heart_rate", value: 47.4, unit: "bpm", source_kind: "oura",
        start_time: "2026-09-15T19:00:00Z", end_time: "2026-09-15T19:05:00Z" }),
      s({ type: "hrv_sdnn", value: 40.5, unit: "ms", source_kind: "oura" }),
      s({ type: "hrv_sdnn", value: 50.25, unit: "ms", source_kind: "oura",
        start_time: "2026-09-15T19:00:00Z", end_time: "2026-09-15T19:05:00Z" }),
    ], TZ);
    expect(day.resting_heart_rate).toBe(47.4);      // the day's minimum, not 47
    expect(day.hrv_sdnn).toBe(45.375);              // the day's mean, not 45
  });

  // T11b finding 3: readiness is stored by the Oura pull and was dropped by the roll-up. Its daily
  // rule is the day's LATEST sample — Oura publishes one score per day and a re-run is a correction
  // — so a later, lower score must win. (The lower value is deliberate: "latest" is not "max".)
  it("takes readiness as the day's latest sample and names that sample", () => {
    const day = rollUpDay([
      s({ type: "readiness_score", value: 82, unit: "score", source_kind: "oura" }),
      s({ type: "readiness_score", value: 70, unit: "score", source_kind: "oura",
        start_time: "2026-09-15T19:00:00Z", end_time: "2026-09-15T19:05:00Z" }),
    ], TZ);
    expect(day.readiness_score).toBe(70);
    expect(day.provenance.readiness_score).toEqual({ kind: "oura",
      end: "2026-09-15T19:05:00Z" });
  });

  it("leaves readiness null on a day that carries none", () => {
    const day = rollUpDay([s({ type: "step_count", value: 10 })], TZ);
    expect(day.readiness_score).toBeNull();
    expect(day.provenance.readiness_score).toBeUndefined();
  });

  it("refuses an empty array — an absent day is emptyDay(), not a roll-up", () => {
    expect(() => rollUpDay([], TZ)).toThrow(/at least one sample/);
    expect(emptyDay("2026-09-16")).toEqual({ local_date: "2026-09-16", steps: null,
      active_kcal: null, sleep_minutes: null, body_mass_kg: null, resting_heart_rate: null,
      hrv_sdnn: null, readiness_score: null, sources: [], provenance: {} });
  });
});
