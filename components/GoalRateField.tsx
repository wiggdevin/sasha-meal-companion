"use client";

/**
 * "How fast?" under the goal (step D, docs/plans/2026-09-22-tdee-engine-plan.md §D). A loss or
 * gain goal is a rate in % of body weight a week, from three presets; maintain and recomp hold
 * weight and show no picker. The maths lives in `lib/profile/rate-goal.ts`; this field records
 * the choice and, given the derivation's outcome, says which limit set the number.
 */
import { useId } from "react";
import type { RateOutcome } from "@/lib/profile/energy";
import { DEFAULT_RATE_BP, RATE_PRESETS_BP } from "@/lib/profile/rate-goal";
import type { Goal } from "@/lib/types";
import GlassSelect from "@/components/ui/GlassSelect";

/** Pace by goal: the presets are ordered slow → fast in RATE_PRESETS_BP for both ladders. */
const PACE = ["Slow", "Steady", "Fast"] as const;

function pct(bp: number, sign = true): string {
  const value = `${Math.abs(bp) / 100}%`;
  if (!sign) return value;
  return bp < 0 ? `−${value}` : `+${value}`;
}

export function rateLabel(goal: Goal, bp: number): string {
  const suffix = bp === DEFAULT_RATE_BP[goal] ? " (recommended)" : "";
  const pace = PACE[RATE_PRESETS_BP[goal].indexOf(bp)] ?? "";
  return `${pace} · ${pct(bp)} of body weight a week${suffix}`;
}

/** The plan-step footer's clause: "losing 0.5% of body weight a week". */
export function rateSentence(goal: Goal, goalRateBpWeek: number | null): string {
  if (DEFAULT_RATE_BP[goal] === 0) return "at maintenance";
  if (goalRateBpWeek === null || goalRateBpWeek === 0) {
    return "at maintenance until you choose a rate";
  }
  const verb = goalRateBpWeek < 0 ? "losing" : "gaining";
  return `${verb} ${pct(goalRateBpWeek, false)} of body weight a week`;
}

const kcal = new Intl.NumberFormat("en-US");

/** The two clamp sentences from the ruling, or null when the rate applied as chosen. */
export function rateClampCopy(outcome: RateOutcome, goalRateBpWeek: number): string | null {
  if (outcome.bound === "rate_cap") {
    const limit = goalRateBpWeek < 0 ? "20% below" : "10% above";
    const effective = outcome.effectiveRatePctWeek;
    const rounded = `${effective < 0 ? "−" : "+"}${Math.abs(effective).toFixed(2)}%`;
    return `${pct(goalRateBpWeek)}/week exceeds the plan limit. Using ${limit} your current `
      + `TDEE: ${kcal.format(outcome.targetKcal)} kcal/day, about ${rounded}/week.`;
  }
  if (outcome.bound === "kcal_min") {
    const min = `${kcal.format(outcome.kcalMin)} kcal/day`;
    return `Your selected rate would fall below your ${min} nutrition minimum. `
      + `Using ${min}; progress may be slower.`;
  }
  return null;
}

/** The Settings goal select's write: a new goal carries its default rate, no goal no rate. */
export function goalChangePatch(raw: string): { goal: Goal | null; goalRateBpWeek: number | null } {
  const goal = raw in DEFAULT_RATE_BP ? raw as Goal : null;
  return { goal, goalRateBpWeek: goal === null ? null : DEFAULT_RATE_BP[goal] };
}

export default function GoalRateField({ goal, value, onChange, outcome, required = false,
  fieldClass, fieldClassName, labelClassName, captionClassName }: {
  goal: Goal;
  value: number | null;
  onChange: (goalRateBpWeek: number) => void;
  /** The derivation's outcome for the current profile, when there is one to explain. */
  outcome?: RateOutcome;
  /** Onboarding cannot continue without a rate; Settings can, at maintenance. */
  required?: boolean;
  fieldClass: string;
  fieldClassName?: string;
  labelClassName: string;
  captionClassName: string;
}) {
  const id = useId();
  if (DEFAULT_RATE_BP[goal] === 0) return null;
  const chosen = value !== null && RATE_PRESETS_BP[goal].includes(value) ? value : null;
  const clamp = chosen !== null && outcome ? rateClampCopy(outcome, chosen) : null;
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className={labelClassName}>How fast?</span>
        <GlassSelect aria-label="Goal rate" aria-describedby={`${id}-help`}
          className={fieldClassName ? `${fieldClass} ${fieldClassName}` : fieldClass}
          value={chosen === null ? "" : String(chosen)}
          onChange={(next) => onChange(Number(next))}
          options={[...(chosen === null ? [{ value: "", label: "Choose a rate", disabled: true }] : []),
            ...RATE_PRESETS_BP[goal].map((bp) => ({ value: String(bp), label: rateLabel(goal, bp) }))]} />
      </label>
      <p id={`${id}-help`} className={`m-0 ${captionClassName}`}>
        {chosen === null
          ? required ? "Choose a rate to continue."
            : "Your plan stays at maintenance until you choose a rate."
          : clamp ?? "Steady suits most people. Fast is held to 20% below your burn when "
            + "losing and 10% above it when gaining."}
      </p>
    </div>
  );
}
