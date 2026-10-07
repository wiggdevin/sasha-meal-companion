import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGREEMENT_MIN_KCAL, AGREEMENT_PCT, BMR_HIGH, BMR_LOW, CLEAN_HISTORY_DAYS, CYCLE_MIN_QUALIFIED,
  CYCLE_PERIOD_TOLERANCE_DAYS, CYCLE_PERSIST_NIGHTS, ENGINE_VERSION, POST_STEP_DAYS,
  PRE_CYCLE_MAX_WEIGHT, WEIGH_EPISODE_GAP_DAYS,
  FADE_LENGTH_DAYS, FADE_START_DAYS, FAR_FROM_SEED_PCT, FLAG_RELEASE_DAYS, HELD_LOOKBACK_DAYS,
  isQualifiedDay, KCAL_PER_KG, LONG_MIN_PER_WEEK_BLOCK, LONG_MIN_QUALIFIED, LONG_MIN_SPAN_DAYS,
  LONG_MIN_WEIGH_DAYS, LONG_WINDOW_DAYS, MAX_HALF_WIDTH_KCAL, MAX_HALF_WIDTH_PCT, MAX_STALE_DAYS,
  MIN_ENERGY_COVERAGE, MIN_HALF_WIDTH_KCAL, MIN_QUALIFIED_KCAL, PROPOSAL_MIN_CALENDAR_DAYS,
  PROPOSAL_MIN_QUALIFIED_28, RANGE_HISTORY_DAYS, ROUND_KCAL, SEED_HALF_WIDTH_PCT,
  SHORT_MIN_QUALIFIED, SHORT_MIN_SPAN_DAYS, SHORT_MIN_WEIGH_DAYS, SHORT_WINDOW_DAYS, toDayNumber,
  type IntakeDay,
} from "@/lib/expenditure";
import { BMR_KCAL, PRIOR_KCAL } from "@/lib/expenditure.fixtures";
import {
  BREAK_EDGE_DAYS, CYCLE_MIN_AMPLITUDE_KG, CYCLE_MIN_BIC_GAIN, MAX_HALF_PHASE_RAD,
  MIN_HALF_AMPLITUDE_SHARE, MIN_STEP_KG, CYCLE_MIN_OUTLIER_KG, CYCLE_MIN_SPAN_DAYS,
  CYCLE_MIN_WEIGH_DAYS, CYCLE_PERIODS, CYCLE_WINDOW_DAYS,
} from "@/lib/expenditure-cycle";

/** Contracts §9 / rulings doc: a change to any engine constant fails at least one test,
 *  deliberately, so a tuned number is always a deliberate edit. */
describe("engine constants", () => {
  it("carries the exp-3.1.0 values (docs/decisions/2026-10-04-adaptive-handoff-rulings.md)", () => {
    expect({
      ENGINE_VERSION, KCAL_PER_KG, ROUND_KCAL, MIN_ENERGY_COVERAGE, MIN_QUALIFIED_KCAL,
      SHORT_WINDOW_DAYS, LONG_WINDOW_DAYS, SHORT_MIN_QUALIFIED, SHORT_MIN_WEIGH_DAYS,
      SHORT_MIN_SPAN_DAYS, LONG_MIN_QUALIFIED, LONG_MIN_WEIGH_DAYS, LONG_MIN_SPAN_DAYS,
      LONG_MIN_PER_WEEK_BLOCK, MAX_STALE_DAYS, FADE_START_DAYS, FADE_LENGTH_DAYS,
      PROPOSAL_MIN_QUALIFIED_28, PROPOSAL_MIN_CALENDAR_DAYS, AGREEMENT_MIN_KCAL, AGREEMENT_PCT,
      CLEAN_HISTORY_DAYS, MAX_HALF_WIDTH_KCAL, MAX_HALF_WIDTH_PCT, FAR_FROM_SEED_PCT,
      FLAG_RELEASE_DAYS, BMR_LOW, BMR_HIGH, MIN_HALF_WIDTH_KCAL, SEED_HALF_WIDTH_PCT,
      RANGE_HISTORY_DAYS, HELD_LOOKBACK_DAYS, CYCLE_MIN_QUALIFIED, PRE_CYCLE_MAX_WEIGHT,
      POST_STEP_DAYS, WEIGH_EPISODE_GAP_DAYS, CYCLE_PERSIST_NIGHTS: [...CYCLE_PERSIST_NIGHTS],
      CYCLE_PERIOD_TOLERANCE_DAYS,
    }).toEqual({
      ENGINE_VERSION: "exp-3.1.0", KCAL_PER_KG: 7700, ROUND_KCAL: 10, MIN_ENERGY_COVERAGE: 0.95,
      MIN_QUALIFIED_KCAL: 1000,
      SHORT_WINDOW_DAYS: 14, LONG_WINDOW_DAYS: 28, SHORT_MIN_QUALIFIED: 10, SHORT_MIN_WEIGH_DAYS: 6,
      SHORT_MIN_SPAN_DAYS: 11, LONG_MIN_QUALIFIED: 14, LONG_MIN_WEIGH_DAYS: 12, LONG_MIN_SPAN_DAYS: 24,
      LONG_MIN_PER_WEEK_BLOCK: 2, MAX_STALE_DAYS: 2, FADE_START_DAYS: 14, FADE_LENGTH_DAYS: 28,
      PROPOSAL_MIN_QUALIFIED_28: 21, PROPOSAL_MIN_CALENDAR_DAYS: 28, AGREEMENT_MIN_KCAL: 150,
      AGREEMENT_PCT: 0.08, CLEAN_HISTORY_DAYS: 7, MAX_HALF_WIDTH_KCAL: 200, MAX_HALF_WIDTH_PCT: 0.1,
      FAR_FROM_SEED_PCT: 0.35, FLAG_RELEASE_DAYS: 14, BMR_LOW: 0.9, BMR_HIGH: 2.2,
      MIN_HALF_WIDTH_KCAL: 150, SEED_HALF_WIDTH_PCT: 0.15, RANGE_HISTORY_DAYS: 14,
      HELD_LOOKBACK_DAYS: 28, CYCLE_MIN_QUALIFIED: 28, PRE_CYCLE_MAX_WEIGHT: 0.5,
      POST_STEP_DAYS: 28, WEIGH_EPISODE_GAP_DAYS: 14, CYCLE_PERSIST_NIGHTS: [14, 28],
      CYCLE_PERIOD_TOLERANCE_DAYS: 3,
    });
  });

  it("carries the fluid-cycle values (lib/expenditure-cycle.ts, ruling R10)", () => {
    expect({ CYCLE_WINDOW_DAYS, CYCLE_MIN_SPAN_DAYS, CYCLE_MIN_WEIGH_DAYS,
      CYCLE_MIN_AMPLITUDE_KG, CYCLE_MIN_BIC_GAIN, CYCLE_MIN_OUTLIER_KG, BREAK_EDGE_DAYS,
      MIN_STEP_KG, MIN_HALF_AMPLITUDE_SHARE, MAX_HALF_PHASE_RAD,
      periods: [...CYCLE_PERIODS] }).toEqual({ CYCLE_WINDOW_DAYS: 56, CYCLE_MIN_SPAN_DAYS: 38,
      CYCLE_MIN_WEIGH_DAYS: 16, CYCLE_MIN_AMPLITUDE_KG: 0.3, CYCLE_MIN_BIC_GAIN: 10,
      CYCLE_MIN_OUTLIER_KG: 0.5, BREAK_EDGE_DAYS: 7, MIN_STEP_KG: 0.7,
      MIN_HALF_AMPLITUDE_SHARE: 0.5, MAX_HALF_PHASE_RAD: Math.PI / 3,
      periods: [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35] });
  });

  it("bounds the absolute clamp at 1,235 and 3,018 kcal on the measured BMR", () => {
    expect(Math.round(BMR_LOW * BMR_KCAL)).toBe(1235);
    expect(Math.round(BMR_HIGH * BMR_KCAL)).toBe(3018);
  });

  // PRIOR_KCAL / BMR_KCAL are fixtures-only test seeds (lib/expenditure.fixtures.ts), never engine
  // constants — the engine takes seedKcal/bmrKcal per account (lib/server/profile-tdee.ts).
  it("keeps the fixtures' test seeds at their documented values", () => {
    expect(PRIOR_KCAL).toBe(2130);
    expect(BMR_KCAL).toBe(1372);
  });
});

describe("toDayNumber", () => {
  it("counts whole days and is unaffected by the runtime time zone", () => {
    expect(toDayNumber("2026-09-11") - toDayNumber("2026-09-01")).toBe(10);
    expect(toDayNumber("2027-03-01") - toDayNumber("2027-02-28")).toBe(1);
  });
});

describe("isQualifiedDay", () => {
  const day = (over: Partial<IntakeDay> = {}): IntakeDay =>
    ({ date: "2026-09-10", kcal: 2000, energyCoverage: 1, ...over });

  it("qualifies a complete, fed day strictly before asOf when no marks have started", () => {
    expect(isQualifiedDay(day(), "2026-09-11")).toBe(true);
  });
  it("refuses coverage under 0.95 before marks start", () => {
    expect(isQualifiedDay(day({ energyCoverage: 0.94 }), "2026-09-11")).toBe(false);
    expect(isQualifiedDay(day({ energyCoverage: 0.95 }), "2026-09-11")).toBe(true);
  });
  it("refuses a day under 1000 kcal", () => {
    expect(isQualifiedDay(day({ kcal: 999 }), "2026-09-11")).toBe(false);
    expect(isQualifiedDay(day({ kcal: 1000 }), "2026-09-11")).toBe(true);
  });
  it("refuses today and any later date — the day is not finished", () => {
    expect(isQualifiedDay(day({ date: "2026-09-11" }), "2026-09-11")).toBe(false);
    expect(isQualifiedDay(day({ date: "2026-09-12" }), "2026-09-11")).toBe(false);
  });
  it("a marked day always qualifies, even under coverage, before or after marks start", () => {
    expect(isQualifiedDay(day({ energyCoverage: 0.2, userMarkedComplete: true }), "2026-09-11"))
      .toBe(true);
    expect(isQualifiedDay(
      day({ energyCoverage: 0.2, userMarkedComplete: true }), "2026-09-11", "2026-09-01",
    )).toBe(true);
  });

  // R3: the first-ever mark date gates which rule applies, and never moves back.
  describe("ruling R3 — marksStartedOn", () => {
    const marksStartedOn = "2026-07-01";
    it("qualifies a coverage-complete, unmarked day before marksStartedOn", () => {
      expect(isQualifiedDay(
        day({ date: "2026-06-20", energyCoverage: 1 }), "2026-07-10", marksStartedOn,
      )).toBe(true);
    });
    it("refuses a coverage-complete, unmarked day on or after marksStartedOn", () => {
      expect(isQualifiedDay(
        day({ date: "2026-07-05", energyCoverage: 1, userMarkedComplete: false }),
        "2026-07-10", marksStartedOn,
      )).toBe(false);
      expect(isQualifiedDay(
        day({ date: "2026-07-01", energyCoverage: 1 }), "2026-07-10", marksStartedOn,
      )).toBe(false);
    });
    it("qualifies a marked day on or after marksStartedOn", () => {
      expect(isQualifiedDay(
        day({ date: "2026-07-05", energyCoverage: 1, userMarkedComplete: true }),
        "2026-07-10", marksStartedOn,
      )).toBe(true);
    });
  });
});

describe("ruling — thresholds pinned", () => {
  it("pins the qualified-day thresholds by name", () => {
    expect(MIN_ENERGY_COVERAGE).toBe(0.95);
    expect(MIN_QUALIFIED_KCAL).toBe(1000);
  });

  it("pins the approval SQL's default kcal_min at 1650", () => {
    const migration = readFileSync(
      "supabase/migrations/20261006090100_phase6_expenditure.sql", "utf8",
    );
    expect(migration).toContain("coalesce(v_active.kcal_min, 1650)");
  });
});
