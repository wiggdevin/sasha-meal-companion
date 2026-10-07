/**
 * T11a state transitions, pure (Sol audit, T11a finding 3). The hook is thin; the two rules that
 * matter are "show only the viewed date's row" and "a date change clears the previous row", so both
 * live as pure functions and this file pins them. The 320 px five-target check stays a manual phone
 * gate, not an assertion here.
 */
import { describe, expect, it } from "vitest";
import { applyDays, INITIAL_TODAY_BODY, pickDay, viewedDate } from "@/lib/health/today-card";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { ExpenditureResponse } from "@/lib/api-types";

const row = (local_date: string): DailyHealthRow => ({ local_date, steps: 1, active_kcal: null,
  sleep_minutes: null, body_mass_kg: null, resting_heart_rate: null, hrv_sdnn: null,
  readiness_score: null, sources: [], provenance: {} });

const ESTIMATE: ExpenditureResponse = { status: "estimating", localDate: "2026-09-15",
  tdeeKcal: 1820, weightTrendKg: 57.4, confidence: 0.8, intakeCompleteness: 1, qualifiedDays: 24,
  weighInCount: 24, reason: null, engineVersion: "v1" };

describe("pickDay", () => {
  it("selects the viewed date out of a cached multi-day range", () => {
    const days = [row("2026-09-14"), row("2026-09-15"), row("2026-09-16")];
    expect(pickDay(days, "2026-09-15")?.local_date).toBe("2026-09-15");
  });

  it("is null when the viewed date is absent from the cached range — never days[0]", () => {
    expect(pickDay([row("2026-09-14"), row("2026-09-16")], "2026-09-15")).toBeNull();
    expect(pickDay([], "2026-09-15")).toBeNull();
    expect(pickDay(null, "2026-09-15")).toBeNull();
  });
});

describe("the viewed-date transition", () => {
  it("clears the previous date's row the moment a new date is viewed", () => {
    const settled = applyDays(INITIAL_TODAY_BODY, "2026-09-15", [row("2026-09-15")]);
    expect(settled.row?.local_date).toBe("2026-09-15");
    expect(settled.loading).toBe(false);

    const next = viewedDate(settled, "2026-09-16");
    expect(next.row).toBeNull();
    expect(next.loading).toBe(true);
  });

  it("keeps the nightly burn value across a date change (it is not date-specific)", () => {
    const settled = { ...applyDays(INITIAL_TODAY_BODY, "2026-09-15", [row("2026-09-15")]),
      estimate: ESTIMATE };
    expect(viewedDate(settled, "2026-09-16").estimate).toBe(ESTIMATE);
  });

  it("drops the fetched window with the row, because the window ends at the viewed date", () => {
    const settled = applyDays(INITIAL_TODAY_BODY, "2026-09-15", [row("2026-09-14"),
      row("2026-09-15")]);
    expect(settled.days).toHaveLength(2);
    expect(viewedDate(settled, "2026-09-16").days).toEqual([]);
  });

  it("passes a settled row straight through for the date it belongs to", () => {
    const settled = applyDays(INITIAL_TODAY_BODY, "2026-09-15", [row("2026-09-15")]);
    expect(viewedDate(settled, "2026-09-15")).toBe(settled);
  });

  it("settles on null when the fetched range does not carry the viewed date", () => {
    const state = applyDays(INITIAL_TODAY_BODY, "2026-09-15", [row("2026-09-10")]);
    expect(state.row).toBeNull();
    expect(state.loading).toBe(false);
  });
});

describe("the offline/stale flags fetchDaily and fetchExpenditure carry", () => {
  it("records fetchDaily's offline flag and fetchedAt instead of discarding them", () => {
    const settled = applyDays(INITIAL_TODAY_BODY, "2026-09-15", [row("2026-09-15")], true,
      "2026-09-15T08:00:00Z");
    expect(settled.offline).toBe(true);
    expect(settled.fetchedAt).toBe("2026-09-15T08:00:00Z");
  });

  it("defaults offline to false and fetchedAt to null for a live fetch", () => {
    const settled = applyDays(INITIAL_TODAY_BODY, "2026-09-15", [row("2026-09-15")]);
    expect(settled.offline).toBe(false);
    expect(settled.fetchedAt).toBeNull();
  });

  it("clears the previous date's offline/fetchedAt on a date change, but keeps stale — it rides "
      + "with the estimate, not the viewed date", () => {
    const settled = { ...applyDays(INITIAL_TODAY_BODY, "2026-09-15", [row("2026-09-15")], true,
      "2026-09-15T08:00:00Z"), stale: true };
    const next = viewedDate(settled, "2026-09-16");
    expect(next.offline).toBe(false);
    expect(next.fetchedAt).toBeNull();
    expect(next.stale).toBe(true);
  });
});
