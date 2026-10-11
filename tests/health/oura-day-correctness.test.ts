/**
 * W025 (audit A010, A014, B264): Oura and Apple data count once per day and land on the
 * account's day.
 */
import { describe, expect, it } from "vitest";
import { localDateOf, rollUpDay } from "@/lib/health/daily";
import { normalizeHealthAutoExport } from "@/lib/health/normalize";
import { ouraActivityToSamples, ouraReadinessToSamples, ouraSleepToSamples } from "@/lib/oura/map";

const NY = "America/New_York";

/** The audit's repro: HAE posts one folded day, the Oura pull stores the same day's totals. */
function appleAndOura(appleSteps: number, ouraSteps: number) {
  const hae = normalizeHealthAutoExport({ data: { metrics: [
    { name: "step_count", units: "count", data: [
      { date: "2026-09-15 00:00:00 -0400", qty: appleSteps, source: "Devin's Apple Watch" }] },
    { name: "active_energy", units: "kcal", data: [
      { date: "2026-09-15 00:00:00 -0400", qty: 500, source: "Devin's Apple Watch" }] },
  ] } }, NY).samples;
  const oura = ouraActivityToSamples({ id: "a1", day: "2026-09-15", steps: ouraSteps,
    active_calories: 420 });
  return { hae, oura };
}

describe("steps and active energy: one provider per day (A010)", () => {
  it("never sums Oura and Apple totals for the same day", () => {
    const { hae, oura } = appleAndOura(8000, 8200);
    expect(hae).toHaveLength(2);
    const day = rollUpDay([...hae, ...oura], NY);
    expect(day.local_date).toBe("2026-09-15");
    expect(day.steps).toBe(8200);
    expect(day.provenance.step_count?.kind).toBe("Oura");
    expect(day.active_kcal).toBe(500);
    expect(day.provenance.active_energy?.kind).toBe("Devin's Apple Watch");
  });

  it("keeps Apple on a tie and keeps the watch/phone union within Apple", () => {
    const { hae, oura } = appleAndOura(8000, 8000);
    expect(rollUpDay([...oura, ...hae], NY).steps).toBe(8000);
  });

  it("dates a mixed bucket by each sample's own zone, not the first one's", () => {
    const { hae, oura } = appleAndOura(8000, 8200);
    // The Oura window starts 00:00Z, before the NY midnight; read in NY it would be the 14th.
    expect(rollUpDay([...hae, ...oura], NY).local_date).toBe("2026-09-15");
  });
});

describe("sleep, heart and readiness use the account zone (A014, B264)", () => {
  const SLEEP = { id: "s1", day: "2026-09-15", bedtime_start: "2026-09-14T23:30:00-04:00",
    bedtime_end: "2026-09-15T07:00:00-04:00", total_sleep_duration: 25200,
    lowest_heart_rate: 50, average_hrv: 60 };

  it("puts a US bedtime on the night it began, the same day HAE uses", () => {
    const samples = ouraSleepToSamples(SLEEP, NY);
    for (const s of samples) {
      expect(s.tz).toBe(NY);
      expect(localDateOf(s.start_time, s.tz)).toBe("2026-09-14");
    }
    const hae = normalizeHealthAutoExport({ data: { metrics: [{ name: "sleep_analysis",
      units: "hr", data: [{ date: "2026-09-15 07:00:00 -0400", asleep: 6.8,
        sleepStart: "2026-09-14 23:30:00 -0400", sleepEnd: "2026-09-15 07:00:00 -0400",
        source: "Apple Watch" }] }] } }, NY).samples;
    expect(localDateOf(hae[0].start_time, hae[0].tz)).toBe("2026-09-14");
  });

  it("dates readiness by Oura's day in the account zone", () => {
    const [ready] = ouraReadinessToSamples({ id: "r1", day: "2026-09-15", score: 80,
      timestamp: "2026-09-15T00:00:00-04:00" }, NY);
    expect(ready.tz).toBe(NY);
    expect(localDateOf(ready.start_time, ready.tz)).toBe("2026-09-15");
  });

  it("keeps readiness on Oura's day when the timestamp falls on another day in the zone", () => {
    const [ready] = ouraReadinessToSamples({ id: "r2", day: "2026-09-15", score: 80,
      timestamp: "2026-09-15T00:00:00+09:00" }, NY);
    expect(localDateOf(ready.start_time, ready.tz)).toBe("2026-09-15");
  });
});
