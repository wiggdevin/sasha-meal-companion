"use client";

/**
 * The dock's weigh-in logs straight through the coach's own weight path (U19, 2026-10-04; owner:
 * "I don't think that it needs to route you to the AI chat interface. You just log it, get a
 * confirmation … and then it should just be logged"). `applyLogWeight` saves the morning weight,
 * re-derives a complete profile's targets and returns the token `undoLogWeight` needs to put the
 * previous weight and target revision back exactly; no chat turn is made for the log itself.
 */
import type { CoachAction } from "@/lib/coach/actions";
import { applyLogWeight, undoLogWeight } from "@/lib/coach/apply-body";
import { LB_PER_KG, type WeightUnit } from "@/lib/health/units";

export type WeightToken = Parameters<typeof undoLogWeight>[0];
export type LoggedWeight = { token: WeightToken; note: string | null };
export type WeightWriter = {
  log: (kg: number) => Promise<LoggedWeight>;
  undo: (token: WeightToken) => Promise<void>;
};

/** The weight range the coach's own `log_weight` accepts (lib/coach/actions/log-weight.ts). */
export const MIN_KG = 20;
export const MAX_KG = 400;
/** How long Undo stays after a weigh-in. */
export const WEIGH_IN_UNDO_MS = 8000;

/** A typed weight in kilograms, or a reason to show. Accepts a decimal comma ("81,5"). */
export function parseWeight(raw: string, unit: WeightUnit): { kg: number } | { hint: string } {
  const text = raw.trim().replace(",", ".");
  const amount = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) return { hint: `Enter your weight in ${unit}.` };
  const kg = unit === "kg" ? amount : amount / LB_PER_KG;
  if (kg < MIN_KG || kg > MAX_KG) {
    const low = unit === "kg" ? MIN_KG : Math.ceil(MIN_KG * LB_PER_KG);
    const high = unit === "kg" ? MAX_KG : Math.floor(MAX_KG * LB_PER_KG);
    return { hint: `Enter a weight between ${low} and ${high} ${unit}.` };
  }
  return { kg };
}

/** The phone's time zone, the same one every coach action is applied in. */
function zone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export const coachWeightWriter: WeightWriter = {
  async log(kg) {
    const action: Extract<CoachAction, { kind: "log_weight" }> = {
      kind: "log_weight", kg, actionId: crypto.randomUUID(), flagged: [],
    };
    const result = await applyLogWeight(action, { tz: zone(), now: new Date() });
    if (result.status === "failed") throw new Error(result.reason);
    if (result.token.kind !== "log_weight") throw new Error("That weight did not save.");
    return { token: result.token as WeightToken, note: "partial" in result ? result.message : null };
  },
  undo: (token) => undoLogWeight(token),
};
