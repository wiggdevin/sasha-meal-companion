import { describe, expect, it } from "vitest";
import { HAE_FRESHNESS_WINDOW_DAYS } from "@/lib/server/health-ingest";
import { normalizeHealthAutoExport } from "@/lib/health/normalize";

const metric = (name: string, qty: number) => ({ data: { metrics: [{ name, units: "kg", data: [
  { date: "2026-09-19 00:00:00 -0600", qty, source: "Apple Health" },
] }] } });

describe("Health Auto Export daily corrections", () => {
  it.each(["weight_&_body_mass", "weight_body_mass"])("accepts weight key %s", (name) => {
    const result = normalizeHealthAutoExport(metric(name, 57.7), "America/Denver",
      new Date("2026-09-20T14:00:00Z"));
    expect(result.rejected).toEqual([]);
    expect(result.samples[0]).toMatchObject({ type: "body_mass", value: 57.7, unit: "kg" });
  });

  it("uses one stable source/type/local-day identity and stamps the newest receipt", () => {
    const first = normalizeHealthAutoExport(metric("weight_&_body_mass", 57.7), "America/Denver",
      new Date("2026-09-20T14:00:00Z")).samples[0];
    const correction = normalizeHealthAutoExport(metric("weight_&_body_mass", 57.5),
      "America/Denver", new Date("2026-09-20T15:00:00Z")).samples[0];
    expect(first.vendor_sample_id).toBe("hae:body_mass:2026-09-19");
    expect(correction.vendor_sample_id).toBe(first.vendor_sample_id);
    expect(Date.parse(correction.vendor_updated_at!)).toBeGreaterThan(Date.parse(first.vendor_updated_at!));
    expect(correction.value).toBe(57.5);
  });

  it("names the repeated-summary freshness window as eight days", () => {
    expect(HAE_FRESHNESS_WINDOW_DAYS).toBe(8);
  });

  it("does not invent zero samples for omitted Shortcut readings", async () => {
    const { normalizeShortcut } = await import("@/lib/health/normalize");
    const result = normalizeShortcut({ samples: [{ type: "step_count", value: 6241, unit: "count",
      start_time: "2026-09-19T00:00:00-06:00", end_time: "2026-09-20T00:00:00-06:00",
      vendor_sample_id: "shortcut:step_count:2026-09-19",
      vendor_updated_at: "2026-09-20T08:15:00-06:00" }] }, "America/Denver");
    expect(result.samples.map((sample) => sample.type)).toEqual(["step_count"]);
    expect(result.samples.some((sample) => sample.value === 0)).toBe(false);
  });
});
