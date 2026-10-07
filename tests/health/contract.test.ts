import { describe, expect, it } from "vitest";
import { DEFAULT_TZ, healthAutoExportBodySchema, healthIngestBodySchema, healthTimeZone,
  MAX_DAILY_WINDOW_DAYS, MAX_INGEST_BYTES, REPLAY_WINDOW_MS,
  SAMPLE_TYPES } from "@/lib/health/contract";

const sample = { type: "step_count", value: 812, unit: "count",
  start_time: "2026-09-15T13:00:00-04:00", end_time: "2026-09-15T14:00:00-04:00" };
const body = { source_kind: "apple_health_shortcut", sent_at: "2026-09-15T14:01:00-04:00",
  tz: "America/New_York", samples: [sample] };

describe("the Phase 5 contract", () => {
  it("pins the nine sample types and the named limits", () => {
    expect(SAMPLE_TYPES).toEqual(["body_mass", "step_count", "active_energy", "basal_energy",
      "sleep_asleep", "sleep_in_bed", "resting_heart_rate", "hrv_sdnn", "readiness_score"]);
    expect(REPLAY_WINDOW_MS).toBe(600_000);
    expect(MAX_INGEST_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_DAILY_WINDOW_DAYS).toBe(90);
    expect(DEFAULT_TZ).toBe("UTC");
  });

  it("accepts a well-formed envelope", () => {
    expect(healthIngestBodySchema.safeParse(body).success).toBe(true);
  });

  it("accepts the exact daily Shortcut summary contract", () => {
    const shortcut = {
      source_kind: "apple_health_shortcut",
      sent_at: "2026-09-20T08:15:00-06:00",
      tz: "America/Denver",
      samples: [
        { type: "step_count", value: 6241, unit: "count",
          start_time: "2026-09-19T00:00:00-06:00", end_time: "2026-09-20T00:00:00-06:00",
          vendor_sample_id: "shortcut:step_count:2026-09-19",
          vendor_updated_at: "2026-09-20T08:15:00-06:00", device_label: "Apple Watch" },
        { type: "active_energy", value: 386, unit: "kcal",
          start_time: "2026-09-19T00:00:00-06:00", end_time: "2026-09-20T00:00:00-06:00",
          vendor_sample_id: "shortcut:active_energy:2026-09-19",
          vendor_updated_at: "2026-09-20T08:15:00-06:00", device_label: "Apple Watch" },
        { type: "body_mass", value: 57.7, unit: "kg",
          start_time: "2026-09-19T07:12:00-06:00", end_time: "2026-09-19T07:12:00-06:00",
          vendor_sample_id: "shortcut:body_mass:2026-09-19",
          vendor_updated_at: "2026-09-20T08:15:00-06:00", device_label: "Apple Health" },
      ],
    };
    expect(healthIngestBodySchema.parse(shortcut)).toEqual(shortcut);
  });

  it("rejects a non-IANA Shortcut timezone", () => {
    expect(healthIngestBodySchema.safeParse({ ...body, tz: "Denver-ish" }).success).toBe(false);
  });

  it("resolves the health timezone in source, user, environment, default order", () => {
    expect(healthTimeZone("America/Denver", "America/Chicago", "America/Los_Angeles"))
      .toBe("America/Denver");
    expect(healthTimeZone("Denver-ish", "America/Chicago", "America/Los_Angeles"))
      .toBe("America/Chicago");
    expect(healthTimeZone(null, undefined, "America/Los_Angeles"))
      .toBe("America/Los_Angeles");
    expect(healthTimeZone("", null, "not-a-time-zone")).toBe("UTC");
  });

  it("rejects readiness_score and basal_energy on the ingest path", () => {
    for (const type of ["readiness_score", "basal_energy"]) {
      const bad = { ...body, samples: [{ ...sample, type }] };
      expect(healthIngestBodySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects an unparseable timestamp and an unknown unit", () => {
    expect(healthIngestBodySchema.safeParse({ ...body, sent_at: "yesterday" }).success).toBe(false);
    expect(healthIngestBodySchema.safeParse({ ...body,
      samples: [{ ...sample, unit: "furlong" }] }).success).toBe(false);
  });

  it("does NOT enforce the replay window — that is the route's job", () => {
    const old = { ...body, sent_at: "2020-01-01T00:00:00-05:00" };
    expect(healthIngestBodySchema.safeParse(old).success).toBe(true);
  });

  it("parses a Health Auto Export REST body", () => {
    const hae = { data: { metrics: [{ name: "step_count", units: "count",
      data: [{ date: "2026-09-15 13:00:00 -0400", qty: 812, source: "Apple Watch" }] }] } };
    expect(healthAutoExportBodySchema.safeParse(hae).success).toBe(true);
  });
});
