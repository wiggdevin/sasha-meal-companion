/**
 * The Sunday review's model call, apart from its thread and message bookkeeping
 * (architecture §4.5, T4). The review only ever asks for a `final` step, and it validates
 * through the same wire schema a coach turn does, so a reply the union refuses is a
 * schema-failure in the adapter and never a message that renders.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { generateStructured } from "@/lib/ai/adapter";
import { AttestationRefused, assertGeminiAttested } from "@/lib/ai/attestation";
import { CallRefused } from "@/lib/ai/call";
import { weeklyReviewPayload } from "@/lib/ai/gemini-payloads";
import { MODELS } from "@/lib/ai/models";
import { renderToolResult, wrapUntrusted } from "@/lib/coach/envelope";
import type { TurnStep } from "@/lib/coach/turn";
import type { DayTotals } from "@/lib/log/contract";

type ReviewDeps = { generate?: typeof generateStructured; latestEstimate?: (userId: string) => Promise<unknown> };

const reviewDimension = z.enum([
  "logging", "protein", "carbohydrates", "fat", "meal_timing", "energy_trend",
  "not_enough_data",
]);

const weeklyReviewSchema = z.object({
  wentWell: reviewDimension,
  focus: z.enum([
    "logging", "protein", "carbohydrates", "fat", "meal_timing", "energy_trend",
    "not_enough_data", "none",
  ]),
});

type WeeklyReviewChoice = z.infer<typeof weeklyReviewSchema>;

export const WEEKLY_REVIEW_MAX_OUTPUT_TOKENS = 4096;

const STRENGTH_COPY: Record<WeeklyReviewChoice["wentWell"], string> = {
  logging: "logging consistency was the strongest pattern",
  protein: "protein was the strongest pattern",
  carbohydrates: "carbohydrate consistency was the strongest pattern",
  fat: "fat intake consistency was the strongest pattern",
  meal_timing: "meal timing was the strongest pattern",
  energy_trend: "the logged energy trend was the strongest pattern",
  not_enough_data: "there was not enough logged data to identify a strongest pattern",
};

const FOCUS_COPY: Record<WeeklyReviewChoice["focus"], string> = {
  logging: "Next week, focus on logging consistently.",
  protein: "Next week, focus on protein consistency.",
  carbohydrates: "Next week, focus on carbohydrate consistency.",
  fat: "Next week, focus on fat intake consistency.",
  meal_timing: "Next week, focus on meal timing.",
  energy_trend: "Next week, focus on the logged energy trend.",
  not_enough_data: "Next week, focus on logging consistently.",
  none: "Keep the same routine next week.",
};

/** Model output is enum-only; user-visible review prose is entirely application-owned. */
export function renderWeeklyReview(choice: WeeklyReviewChoice): string {
  return `Based on your logged week, ${STRENGTH_COPY[choice.wentWell]}. ${FOCUS_COPY[choice.focus]}`;
}

/** Fewer logged days than this is "not enough data", with or without a model. */
export const MODEL_MIN_LOGGED_DAYS = 3;

/** Days with any logged energy, the one fact the fallback may state without a model. */
export function loggedDayCount(days: readonly DayTotals[]): number {
  return days.filter((day) => day.nutrients.some((nutrient) =>
    nutrient.code === "energy_kcal" && Number(nutrient.amount) > 0)).length;
}

/**
 * The deterministic review when the model is unavailable, not attested, or fails (AI-integration
 * audit, 2026-10-04: the weekly review had no fallback). It says only what the log proves — how
 * consistently the week was logged — and never claims a macro pattern it did not compute.
 */
export function fallbackReview(days: readonly DayTotals[]): WeeklyReviewChoice {
  const logged = loggedDayCount(days);
  if (logged < MODEL_MIN_LOGGED_DAYS) return { wentWell: "not_enough_data", focus: "logging" };
  if (logged < 6) return { wentWell: "logging", focus: "logging" };
  return { wentWell: "logging", focus: "none" };
}

async function weekTotals(
  admin: SupabaseClient, userId: string, weekStart: string,
): Promise<DayTotals[]> {
  const { dayTotalsPrivileged } = await import("@/lib/server/day-totals");
  const start = Date.parse(`${weekStart}T00:00:00.000Z`);
  return Promise.all(Array.from({ length: 7 }, (_, i) =>
    dayTotalsPrivileged(admin, userId,
      new Date(start + i * 86_400_000).toISOString().slice(0, 10))));
}

/** The seven day totals and the burn-in estimate, as the untrusted blocks the prompt quotes. */
async function reviewParts(
  userId: string, weekStart: string, days: DayTotals[], deps: ReviewDeps
): Promise<string> {
  const estimate = await (deps.latestEstimate ?? (async () => null))(userId);
  return [
    "Classify the user's logged week using only the allowed enum values.",
    "Do not write prose or name a food, meal, symptom, condition, supplement, or medication.",
    "Choose one wentWell dimension and one focus dimension. Use none only for focus.",
    `Week starting ${weekStart}.`,
    renderToolResult({ name: "get_week_totals", ok: true, data: wrapUntrusted(days) }),
    renderToolResult({ name: "get_expenditure_status", ok: true, data: wrapUntrusted(estimate) }),
  ].join("\n\n");
}

export type WeeklyReviewResult = TurnStep & { kind: "final"; modelUsed: boolean };

/**
 * The week's review, or null when the week has no logged day: there is nothing to review, so
 * the account gets no message and no model call (W035, audit A153). Under three logged days the
 * model could only answer "not enough data", which the logged-days review says without one.
 */
export async function runWeeklyReview(
  admin: SupabaseClient, userId: string, weekStart: string, deps: ReviewDeps
): Promise<WeeklyReviewResult | null> {
  const days = await weekTotals(admin, userId, weekStart);
  const logged = loggedDayCount(days);
  if (logged === 0) return null;
  if (logged < MODEL_MIN_LOGGED_DAYS) {
    return { kind: "final", text: renderWeeklyReview(fallbackReview(days)), modelUsed: false };
  }
  try {
    // Phase 13 §2: the week's totals are user content, so the attestation is checked before they
    // are rendered for a model, and again by the payload builder.
    assertGeminiAttested();
    const payload = weeklyReviewPayload(await reviewParts(userId, weekStart, days, deps));
    const choice = await (deps.generate ?? generateStructured)({
      payload, userId, admin, schema: weeklyReviewSchema,
      route: { provider: "google", modelId: MODELS.weeklyReview },
      // The reply is two enum fields (~30 tokens); 4096 leaves room for the model's thinking, which
      // counts as output. Without a cap the spend reservation would hold the 65,536-token ceiling
      // (scale S2, lib/ai/spend.ts). A reply cut short falls back to the logged-days review.
      maxOutputTokens: WEEKLY_REVIEW_MAX_OUTPUT_TOKENS,
    });
    return { kind: "final", text: renderWeeklyReview(choice), modelUsed: true };
  } catch (error) {
    // A governance refusal is a configuration fault, not an outage: it stays loud.
    if (error instanceof AttestationRefused || error instanceof CallRefused) throw error;
    // The review still arrives, from the log alone; nothing more was sent to a model.
    console.error("weekly review model unavailable; using the logged-days review", { error });
    return { kind: "final", text: renderWeeklyReview(fallbackReview(days)), modelUsed: false };
  }
}
