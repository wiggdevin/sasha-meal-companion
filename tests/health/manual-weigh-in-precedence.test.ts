/**
 * T8 §2 "Header pill precedence". A typed weigh-in is now a `health_samples` row like any other
 * (source kind `manual`), so a day can hold both her own number and a scale's. The rule, as amended
 * after the Grok review of round 1:
 *
 *   1. an ingest sample (any source kind other than `manual`) for that day wins,
 *   2. else the weight typed on THIS device for that day,
 *   3. else the synced copy of her manual sample, else no pill.
 *
 * Choosing between the two kinds of SAMPLE belongs to the roll-up, because that is the ONE read
 * path (lib/server/health-daily.ts) every caller shares. `pillWeightLb` then places the local value
 * between them — above the synced manual copy, because that copy is only ever a copy of something
 * she typed, and can never be newer than the original.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bodyMassSource, pillWeightLb, rollUpDay } from "@/lib/health/daily";
import type { DailyHealthRow, NormalizedSample } from "@/lib/health/contract";
import { lbToKg } from "@/lib/health/units";

const TZ = "America/Los_Angeles";

function weighIn(kg: number, at: string, sourceKind: string): NormalizedSample {
  return { type: "body_mass", value: kg, unit: "kg", start_time: at, end_time: at, tz: TZ,
    device_label: sourceKind, source_kind: sourceKind };
}

describe("a day that holds both a scale reading and a typed one", () => {
  it("keeps the ingest sample even when the manual row is newer", () => {
    const day = rollUpDay([
      weighIn(80, "2026-09-17T14:00:00.000Z", "oura"),
      weighIn(77.111, "2026-09-17T20:00:00.000Z", "manual"),
    ], TZ);
    expect(day.body_mass_kg).toBe(80);
    expect(day.provenance.body_mass?.kind).toBe("oura");
  });

  it("uses her manual row when nothing ingested a weight that day", () => {
    const day = rollUpDay([weighIn(77.111, "2026-09-17T14:00:00.000Z", "manual")], TZ);
    expect(day.body_mass_kg).toBe(77.111);
    expect(day.provenance.body_mass?.kind).toBe("manual");
  });

  it("still takes the latest of two ingest samples", () => {
    const day = rollUpDay([
      weighIn(80, "2026-09-17T14:00:00.000Z", "oura"),
      weighIn(79.5, "2026-09-17T16:00:00.000Z", "health_auto_export"),
    ], TZ);
    expect(day.body_mass_kg).toBe(79.5);
  });
});

/**
 * The amended §2 rule, in one line: an ingest sample for the day beats the value she just typed,
 * which beats the synced manual sample, and with none of the three there is no pill.
 *
 * The middle step is the correction Grok found. The synced manual sample is a COPY of something she
 * typed — and the copy is never newer than the original, because typing writes locally first and
 * only then posts. Preferring any numeric `body_mass_kg` therefore froze the pill on yesterday's
 * 170 for as long as the health cache was stale, however many times she corrected it to 171.
 */
describe("the header pill", () => {
  it("shows a scale reading for the day, over anything she typed", () => {
    expect(pillWeightLb(80, "ingest", 170)).toBe(176.4);
    expect(pillWeightLb(80, "ingest", undefined)).toBe(176.4);
  });

  it("shows the value she just typed over the synced copy of an older one", () => {
    expect(pillWeightLb(77.111, "manual", 171)).toBe(171);
  });

  it("falls back to the typed value when the day has no sample at all", () => {
    expect(pillWeightLb(null, null, 170)).toBe(170);
    expect(pillWeightLb(undefined, null, 169.55)).toBe(169.6);
  });

  it("shows her synced manual sample when nothing is typed on this device", () => {
    expect(pillWeightLb(77.111, "manual", undefined)).toBe(170);
  });

  it("shows no pill on a day with none of the three", () => {
    expect(pillWeightLb(null, null, undefined)).toBeNull();
    expect(pillWeightLb(undefined, undefined, undefined)).toBeNull();
  });

  // A row cached before T8 cannot hold a manual sample — nothing could write one — so an unnamed
  // source is a device, and outranks the local value as any other ingest reading does.
  it("treats a sample whose source is unknown as an ingest reading", () => {
    expect(pillWeightLb(80, null, 170)).toBe(176.4);
  });
});

describe("bodyMassSource", () => {
  const row = (over: Partial<DailyHealthRow>): DailyHealthRow => ({
    local_date: "2026-09-17", steps: null, active_kcal: null, sleep_minutes: null,
    body_mass_kg: null, resting_heart_rate: null, hrv_sdnn: null, readiness_score: null,
    sources: [], provenance: {}, ...over });

  it("reads the kind the roll-up already recorded against the weight", () => {
    expect(bodyMassSource(row({ body_mass_kg: 77.111,
      provenance: { body_mass: { kind: "manual", end: "2026-09-17T14:00:00.000Z" } } })))
      .toBe("manual");
    expect(bodyMassSource(row({ body_mass_kg: 80,
      provenance: { body_mass: { kind: "oura", end: "2026-09-17T14:00:00.000Z" } } })))
      .toBe("ingest");
  });

  it("answers null for a day with no weight, and for one whose provenance was never written", () => {
    expect(bodyMassSource(undefined)).toBeNull();
    expect(bodyMassSource(row({}))).toBeNull();
    expect(bodyMassSource(row({ body_mass_kg: 80 }))).toBeNull();
  });
});

describe("lbToKg", () => {
  it("stores three decimals of kilograms", () => {
    expect(lbToKg(170)).toBe(77.111);
    expect(lbToKg(171)).toBe(77.564);
  });
});

// The SQL view is the other half of the same number (the note the body-profile migration leaves on
// it). A reader in psql must see the same winner the roll-up picks.
describe("the daily_health view", () => {
  const UP = readFileSync(
    "supabase/migrations/20261019090000_manual_weigh_in.sql", "utf8");

  it("orders body_mass by source kind first, so a manual row never beats an ingest one", () => {
    expect(UP).toContain("create or replace view daily_health with (security_invoker = true)");
    expect(UP).toContain("array_agg(value order by (source_kind = 'manual'), start_time desc)");
    expect(UP).toContain("filter (where type = 'body_mass')");
  });
});
