import { describe, expect, it } from "vitest";
import { normalizeHealthAutoExport, normalizeHealthAutoExportRows, normalizeShortcut } from "@/lib/health/normalize";

const TZ = "America/New_York";

/** Health Auto Export REST export, trimmed to the four metrics the recipe enables. */
const HAE = { data: { metrics: [
  { name: "step_count", units: "count", data: [
    { date: "2026-09-15 13:00:00 -0400", qty: 812, source: "Apple Watch" },
    { date: "2026-09-15 14:00:00 -0400", qty: 610, source: "Sasha's iPhone" }] },
  { name: "active_energy", units: "kcal", data: [
    { date: "2026-09-15 13:00:00 -0400", qty: 96.4, source: "Apple Watch" }] },
  { name: "weight_body_mass", units: "lb", data: [
    { date: "2026-09-15 07:12:00 -0400", qty: 127.2, source: "Withings" }] },
  { name: "sleep_analysis", units: "hr", data: [
    { date: "2026-09-15 06:30:00 -0400", asleep: 7.4, inBed: 8.1,
      sleepStart: "2026-09-14 23:05:00 -0400", sleepEnd: "2026-09-15 07:11:00 -0400",
      source: "Apple Watch" }] }] } };

/** The Shortcut fallback posts the canonical envelope (docs/health-auto-export.md §"Shortcut"). */
const SHORTCUT = { source_kind: "apple_health_shortcut", sent_at: "2026-09-15T14:01:00-04:00",
  tz: TZ, samples: [
    { type: "step_count", value: 812, unit: "count", start_time: "2026-09-15T13:00:00-04:00",
      end_time: "2026-09-15T14:00:00-04:00", device_label: "Apple Watch" },
    { type: "body_mass", value: 127.2, unit: "lb", start_time: "2026-09-15T11:12:00Z",
      end_time: "2026-09-15T11:12:00Z" }] };

describe("normalizeHealthAutoExport", () => {
  it("folds same-day step rows into one correction-safe daily total", () => {
    const { samples, rejected } = normalizeHealthAutoExport({ data: { metrics: [{
      name: "step_count", units: "count", data: [
        { date: "2026-09-15 13:00:00 -0400", qty: 812, source: "Apple Watch" },
        { date: "2026-09-15 14:00:00 -0400", qty: 610, source: "Apple Watch" },
      ],
    }] } }, TZ);

    expect(rejected).toEqual([]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      type: "step_count",
      value: 1422,
      unit: "count",
      vendor_sample_id: "hae:step_count:2026-09-15",
    });
  });

  it("sums same-day active energy rows", () => {
    const result = normalizeHealthAutoExport({ data: { metrics: [{
      name: "active_energy", units: "kcal", data: [
        { date: "2026-09-15 13:00:00 -0400", qty: 96.4 },
        { date: "2026-09-15 14:00:00 -0400", qty: 42.1 },
      ],
    }] } }, TZ);

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({ type: "active_energy", value: 138.5,
      vendor_sample_id: "hae:active_energy:2026-09-15" });
  });

  it("keeps only the latest same-day body-mass reading", () => {
    const result = normalizeHealthAutoExport({ data: { metrics: [{
      name: "weight_body_mass", units: "kg", data: [
        { date: "2026-09-15 07:00:00 -0400", qty: 57.7 },
        { date: "2026-09-15 07:15:00 -0400", qty: 57.5 },
      ],
    }] } }, TZ);

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({ type: "body_mass", value: 57.5,
      start_time: "2026-09-15T11:15:00.000Z",
      vendor_sample_id: "hae:body_mass:2026-09-15" });
  });

  it("keeps one same-day sleep row", () => {
    const result = normalizeHealthAutoExport({ data: { metrics: [{
      name: "sleep_analysis", units: "hr", data: [
        { date: "2026-09-15 06:30:00 -0400", asleep: 7.4,
          sleepStart: "2026-09-14 23:05:00 -0400", sleepEnd: "2026-09-15 07:11:00 -0400" },
        { date: "2026-09-15 07:00:00 -0400", asleep: 7.2,
          sleepStart: "2026-09-14 23:30:00 -0400", sleepEnd: "2026-09-15 07:00:00 -0400" },
      ],
    }] } }, TZ);

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].vendor_sample_id).toBe("hae:sleep_asleep:2026-09-14");
  });

  it("maps every metric to one canonical sample for its local day", () => {
    const { samples, rejected } = normalizeHealthAutoExport(HAE, TZ);
    expect(rejected).toEqual([]);
    expect(samples).toHaveLength(4);
    const steps = samples.filter((s) => s.type === "step_count");
    expect(steps[0]).toMatchObject({ value: 1422, unit: "count", device_label: "Apple Watch",
      start_time: "2026-09-15T17:00:00.000Z", end_time: "2026-09-15T19:00:00.000Z", tz: TZ });
    expect(samples.find((s) => s.type === "body_mass")?.value).toBeCloseTo(57.697, 3);
    expect(samples.find((s) => s.type === "sleep_asleep")).toMatchObject({ value: 444, unit: "min",
      start_time: "2026-09-15T03:05:00.000Z", end_time: "2026-09-15T11:11:00.000Z" });
  });

  it("rejects one malformed entry and still normalizes the rest — acceptance criterion 5", () => {
    const broken = { data: { metrics: [{ name: "step_count", units: "count", data: [
      { date: "2026-09-15 13:00:00 -0400", qty: 812, source: "Apple Watch" },
      { date: "whenever", qty: 10, source: "x" },
      { date: "2026-09-15 15:00:00 -0400", qty: "many", source: "x" }] }] } };
    const { samples, rejected } = normalizeHealthAutoExport(broken, TZ);
    expect(samples).toHaveLength(1);
    expect(rejected).toEqual([{ index: 1, reason: "bad timestamp" }, { index: 2, reason: "value is not a number" }]);
  });

  it("rejects basal_energy_burned — INGEST_SAMPLE_TYPES excludes basal_energy from any phone payload (Oura-only invariant, contract.ts:12-15)", () => {
    const basal = { data: { metrics: [{ name: "basal_energy_burned", units: "kcal", data: [
      { date: "2026-09-15 13:00:00 -0400", qty: 1500, source: "iPhone" }] }] } };
    const { samples, rejected } = normalizeHealthAutoExport(basal, TZ);
    expect(samples).toEqual([]);
    expect(rejected).toEqual([{ index: 0, reason: "unknown metric basal_energy_burned" }]);
  });

  it("rejects a metric name it does not know instead of inventing one", () => {
    const odd = { data: { metrics: [{ name: "blood_alcohol", units: "%", data: [
      { date: "2026-09-15 13:00:00 -0400", qty: 1 }] }] } };
    expect(normalizeHealthAutoExport(odd, TZ)).toEqual({ samples: [],
      rejected: [{ index: 0, reason: "unknown metric blood_alcohol" }] });
  });

  it("rejects a sleep row with neither asleep nor inBed instead of dropping it silently (A012)", () => {
    const blank = { data: { metrics: [{ name: "sleep_analysis", units: "hr", data: [
      { date: "2026-09-15 06:30:00 -0400", sleepStart: "2026-09-14 23:05:00 -0400" },
      { date: "2026-09-15 06:30:00 -0400", inBed: 8,
        sleepStart: "2026-09-14 23:05:00 -0400", sleepEnd: "2026-09-15 07:05:00 -0400" }] }] } };
    const { samples, rejected } = normalizeHealthAutoExport(blank, TZ);
    expect(samples).toHaveLength(1);
    expect(samples[0].type).toBe("sleep_in_bed");
    expect(rejected).toEqual([{ index: 0, reason: "no sleep value" }]);
  });

  it("names the payload rows behind each folded sample (A012)", () => {
    const result = normalizeHealthAutoExportRows({ data: { metrics: [
      { name: "blood_alcohol", units: "%", data: [{ date: "2026-09-15 13:00:00 -0400", qty: 1 }] },
      { name: "step_count", units: "count", data: [
        { date: "2026-09-15 13:00:00 -0400", qty: 812 },
        { date: "2026-09-16 13:00:00 -0400", qty: 100 },
        { date: "2026-09-15 14:00:00 -0400", qty: 610 }] },
      { name: "weight_body_mass", units: "kg", data: [
        { date: "2026-09-15 07:00:00 -0400", qty: 57.7 },
        { date: "2026-09-15 07:15:00 -0400", qty: 57.5 }] },
    ] } }, TZ);
    expect(result.samples.map((s) => s.vendor_sample_id)).toEqual(["hae:step_count:2026-09-15",
      "hae:step_count:2026-09-16", "hae:body_mass:2026-09-15"]);
    expect(result.rows).toEqual([[1, 3], [2], [4, 5]]);
    // The plain entry point keeps its shape.
    const { rows: _rows, ...plain } = result;
    expect(normalizeHealthAutoExport({ data: { metrics: [{ name: "step_count", units: "count",
      data: [{ date: "2026-09-15 13:00:00 -0400", qty: 812 }] }] } }, TZ)).not.toHaveProperty("rows");
    expect(plain.rejected).toEqual([{ index: 0, reason: "unknown metric blood_alcohol" }]);
  });

  it("returns a single envelope rejection for a payload that is not an HAE document", () => {
    expect(normalizeHealthAutoExport({ nope: true }, TZ))
      .toEqual({ samples: [], rejected: [{ index: -1, reason: "not a Health Auto Export payload" }] });
  });

  it("normalises a Weight in lb to kg and stores a Weight already in kg unchanged (ruling 3)", () => {
    const lb = { data: { metrics: [{ name: "weight_body_mass", units: "lb", data: [
      { date: "2026-09-15 07:12:00 -0400", qty: 127.2, source: "Withings" }] }] } };
    const kg = { data: { metrics: [{ name: "weight_body_mass", units: "kg", data: [
      { date: "2026-09-15 07:12:00 -0400", qty: 57.697, source: "Withings" }] }] } };
    const fromLb = normalizeHealthAutoExport(lb, TZ);
    const fromKg = normalizeHealthAutoExport(kg, TZ);
    expect(fromLb.rejected).toEqual([]);
    expect(fromLb.samples[0]).toMatchObject({ type: "body_mass", unit: "kg" });
    expect(fromLb.samples[0].value).toBeCloseTo(57.697, 3);
    expect(fromKg.rejected).toEqual([]);
    expect(fromKg.samples[0]).toMatchObject({ type: "body_mass", value: 57.697, unit: "kg" });
  });
});

describe("normalizeShortcut", () => {
  it("canonicalises units and keeps the sample order", () => {
    const { samples, rejected } = normalizeShortcut(SHORTCUT, TZ);
    expect(rejected).toEqual([]);
    expect(samples[0]).toMatchObject({ type: "step_count", value: 812, tz: TZ });
    expect(samples[1].value).toBeCloseTo(57.697, 3);
    expect(samples[1].unit).toBe("kg");
  });

  it("mints correction-safe daily ids and timestamps omitted by the Shortcut", () => {
    const { samples, rejected } = normalizeShortcut(SHORTCUT, TZ);
    expect(rejected).toEqual([]);
    expect(samples[0]).toMatchObject({
      vendor_sample_id: "shortcut:step_count:2026-09-15",
      vendor_updated_at: SHORTCUT.sent_at,
    });
    expect(samples[1]).toMatchObject({
      vendor_sample_id: "shortcut:body_mass:2026-09-15",
      vendor_updated_at: SHORTCUT.sent_at,
    });
  });

  it("rejects end_time before start_time and an unknown unit", () => {
    const bad = { samples: [
      { type: "step_count", value: 1, unit: "count", start_time: "2026-09-15T14:00:00Z",
        end_time: "2026-09-15T13:00:00Z" },
      { type: "body_mass", value: 9, unit: "stone", start_time: "2026-09-15T11:00:00Z",
        end_time: "2026-09-15T11:00:00Z" }] };
    const { samples, rejected } = normalizeShortcut(bad, TZ);
    expect(samples).toEqual([]);
    expect(rejected).toEqual([{ index: 0, reason: "end_time before start_time" },
      { index: 1, reason: "schema: unit" }]);
  });
});
