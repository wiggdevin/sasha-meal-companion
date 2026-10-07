/**
 * Static `GET /api/expenditure` payloads, one per engine phase (docs/specs/phase-16-adaptive-handoff.md
 * §E2), for the development-only gallery at `/design/tdee`. Round example numbers, owned by no
 * account; nothing here is read by the app itself.
 */
import type { ExpenditureResponse } from "@/lib/api-types";

const BASE: ExpenditureResponse = {
  status: "burn_in", localDate: "2026-10-04", tdeeKcal: null, weightTrendKg: null,
  confidence: 0, intakeCompleteness: 0, qualifiedDays: 0, weighInCount: 0, reason: null,
  engineVersion: "exp-3.1.0", profileTdeeKcal: 1_900, learningDaysRemaining: 21,
  phase: "starting", tdeeLowKcal: 1_620, tdeeHighKcal: 2_190, dataWeight: 0,
  seedSource: "revision", proposalEligible: false, reviewFlag: null,
};

/** A trend that drifts down by a little each day, with one missed night. */
export const GALLERY_TREND_KG: (number | null)[] = Array.from({ length: 21 }, (_, day) =>
  day === 9 ? null : Math.round((80 - day * 0.05) * 10) / 10);

export type TdeeFixture = { name: string; note: string; estimate: ExpenditureResponse };

export const TDEE_FIXTURES: TdeeFixture[] = [
  { name: "Starting", note: "phase starting · status burn_in · no learned number yet",
    estimate: { ...BASE, qualifiedDays: 3, weighInCount: 4,
      reason: "Starting estimate — learning from your days, 3 of 14 counted" } },
  { name: "Provisional", note: "phase provisional · status burn_in WITH a number (new in exp-3)",
    estimate: { ...BASE, phase: "provisional", tdeeKcal: 2_010, tdeeLowKcal: 1_840,
      tdeeHighKcal: 2_180, dataWeight: 0.25, confidence: 0.25, qualifiedDays: 13, weighInCount: 9,
      weightTrendKg: 79.2, reason: "Learning — 13 of 14 counted days in the last 28",
      weightTrendSeriesKg: GALLERY_TREND_KG.map((kg, i) => (i < 15 ? null : kg)) } },
  { name: "Adaptive, still blending", note: "phase adaptive · status estimating · dataWeight 0.8",
    estimate: { ...BASE, status: "estimating", phase: "adaptive", tdeeKcal: 2_050,
      tdeeLowKcal: 1_900, tdeeHighKcal: 2_200, dataWeight: 0.8, confidence: 0.8, qualifiedDays: 19,
      weighInCount: 16, weightTrendKg: 79.1,
      reason: "Needs four weeks of history before suggesting a change",
      weightTrendSeriesKg: GALLERY_TREND_KG } },
  { name: "Adaptive, fully learned", note: "phase adaptive · dataWeight 1 · proposal eligible",
    estimate: { ...BASE, status: "estimating", phase: "adaptive", tdeeKcal: 2_080,
      tdeeLowKcal: 1_930, tdeeHighKcal: 2_230, dataWeight: 1, confidence: 1, qualifiedDays: 25,
      weighInCount: 22, weightTrendKg: 79.0, proposalEligible: true, reason: null,
      weightTrendSeriesKg: GALLERY_TREND_KG } },
  { name: "Adaptive, with a fluid cycle", note: "fluidCycleDays 27 · a gate reason in the note slot",
    estimate: { ...BASE, status: "estimating", phase: "adaptive", tdeeKcal: 2_060,
      tdeeLowKcal: 1_910, tdeeHighKcal: 2_210, dataWeight: 0.9, confidence: 0.9, qualifiedDays: 16,
      weighInCount: 20, weightTrendKg: 79.0, fluidCycleDays: 27,
      reason: "16 of 21 counted days in the last 28", weightTrendSeriesKg: GALLERY_TREND_KG } },
  { name: "Held", note: "status held · phase provisional · the last estimate stays",
    estimate: { ...BASE, status: "held", phase: "provisional", tdeeKcal: 2_020,
      tdeeLowKcal: 1_850, tdeeHighKcal: 2_190, dataWeight: 0.4, confidence: 0.4,
      qualifiedDays: 15, weighInCount: 7,
      reason: "Holding the last estimate — no weigh-in in the last 2 days",
      weightTrendSeriesKg: GALLERY_TREND_KG } },
  { name: "Needs a check", note: "reviewFlag far_from_seed · proposals paused",
    estimate: { ...BASE, status: "estimating", phase: "adaptive", tdeeKcal: 2_640,
      tdeeLowKcal: 2_420, tdeeHighKcal: 2_860, dataWeight: 0.9, confidence: 0.9,
      qualifiedDays: 22, weighInCount: 20, weightTrendKg: 79.0, reviewFlag: "far_from_seed",
      reason: "Your logged intake and weight don't fit together — check that every counted day is complete",
      weightTrendSeriesKg: GALLERY_TREND_KG } },
  { name: "No profile", note: "status held · phase starting · no seed, so no number",
    estimate: { ...BASE, status: "held", profileTdeeKcal: null, tdeeLowKcal: null,
      tdeeHighKcal: null, seedSource: null,
      reason: "Finish your profile — the estimate starts from your own numbers" } },
  { name: "Older row (exp-2)", note: "phase absent · the previous engine's estimating row",
    estimate: { status: "estimating", localDate: "2026-10-04", tdeeKcal: 2_180,
      weightTrendKg: 79.1, confidence: 0.8, intakeCompleteness: 1, qualifiedDays: 18,
      weighInCount: 21, reason: null, engineVersion: "exp-2.0.0", profileTdeeKcal: 1_900,
      weightTrendSeriesKg: GALLERY_TREND_KG } },
];
