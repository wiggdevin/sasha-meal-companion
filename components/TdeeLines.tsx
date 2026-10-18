"use client";

import { useId } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import Disclosure from "@/components/ui/Disclosure";
import KcalText from "@/components/ui/KcalText";
import Notice from "@/components/ui/Notice";
import { buttonClasses } from "@/components/ui/Button";
import { spring } from "@/lib/design/motion";
import type { ExpenditureResponse } from "@/lib/api-types";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { ProfileState } from "@/lib/tdee";

/** The engine's joining rule (lib/expenditure.ts `clause()`), kept here so the client does not bundle
 *  the estimate engine for one line: a reason joined after a colon starts lowercase. */
function clause(text: string | null | undefined): string {
  if (!text) return "";
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export type TdeeLine = {
  key: "learned" | "profile" | "device";
  label: string;
  value: string;
  detail: string;
  kcal: number | null;
  /** "1,900–2,200": the engine's variation band (exp-3, ruling R6), never a confidence interval.
   *  Absent on an exp-2 row, and dropped when it does not contain the number it belongs to. */
  range?: string | null;
  /** 0–1: how much of `kcal` rests on the account's own days rather than its starting estimate. */
  dataWeight?: number | null;
  /** The engine paused this number for review (R5): it reads as a check, never as learned. */
  attention?: boolean;
  /** A held number: still the estimate, but not today's, so it keeps ink, not the calorie colour. */
  stale?: boolean;
  /** A second, quieter line about something other than the number (the proposal gate). */
  note?: string | null;
  /** The one thing to do when there is no number: the profile flow. */
  action?: { label: string; href: string } | null;
  /** exp-3.1.0: the fluid cycle the estimate corrects for, as one quiet line. Never names a cause. */
  cycle?: string | null;
};

export type TdeeLinesInput = {
  estimate: ExpenditureResponse | null;
  /** Kept on the public seam for existing callers; profile TDEE now comes from the API authority. */
  profile: ProfileState;
  days: readonly DailyHealthRow[];
  localDate?: string;
};

type Phase = NonNullable<ExpenditureResponse["phase"]>;

const VALUE = "text-caption font-normal text-charcoal";
const DETAIL = "text-tiny font-normal text-muted";

function int(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function kcal(value: number): string {
  return `${int(value)} kcal`;
}

/** The server's reason is already a user-facing sentence (the engine sets the case of a joined
 *  clause itself, `clause()` in lib/expenditure.ts); it is shown as sent, with a full stop. */
function sentence(reason: string | null | undefined, fallback: string): string {
  const text = (reason ?? fallback).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function profileLine(label: string, value: number): TdeeLine {
  return { key: "profile", label, value: kcal(value), kcal: value,
    detail: "Your profile is the starting estimate." };
}

/* ---------------------------------------------------------------- exp-2 rows (no `phase`) */

function learnedLine(estimate: ExpenditureResponse): TdeeLine | null {
  if (estimate.tdeeKcal === null) return null;
  if (estimate.status === "held") {
    return { key: "learned", label: "Last learned", value: kcal(estimate.tdeeKcal),
      kcal: estimate.tdeeKcal,
      detail: `Holding steady — ${sentence(estimate.reason, "not enough recent data")}` };
  }
  if (estimate.status === "blocked") {
    return { key: "learned", label: "From logs + weight", value: kcal(estimate.tdeeKcal),
      kcal: estimate.tdeeKcal,
      detail: `Estimate updated. No target proposal: ${sentence(estimate.reason,
        "the proposed change was held")}` };
  }
  if (estimate.status === "estimating") {
    const corroborated = estimate.activityContext?.smoothing === "corroborated"
      ? " Your step trend agreed, so this update moved faster." : "";
    return { key: "learned", label: "From logs + weight", value: kcal(estimate.tdeeKcal),
      kcal: estimate.tdeeKcal,
      detail: `Updated today from your logged intake and weight trend.${corroborated}` };
  }
  return null;
}

/** The previous engine's rows: `status` alone decides, and `burn_in` never carries a number. */
function legacyLines(estimate: ExpenditureResponse): TdeeLine[] {
  const profileTdee = estimate.profileTdeeKcal;
  if (estimate.status === "burn_in") {
    return typeof profileTdee === "number" ? [{ ...profileLine("From your profile", profileTdee),
      detail: `Your logs and weight will refine this in about ${estimate.learningDaysRemaining ?? 21} days.` }]
      : [];
  }
  const lines: TdeeLine[] = [];
  const learned = learnedLine(estimate);
  if (learned) lines.push(learned);
  if (typeof profileTdee === "number") lines.push(profileLine("Profile starting estimate", profileTdee));
  return lines;
}

/* ---------------------------------------------------------------- exp-3 rows (step E) */

export function phaseOf(estimate: ExpenditureResponse): Phase | null {
  const phase = estimate.phase;
  return phase === "starting" || phase === "provisional" || phase === "adaptive" ? phase : null;
}

/** The band only when both ends are real and it holds the number shown beside it. */
function rangeAround(estimate: ExpenditureResponse, center: number): string | null {
  const { tdeeLowKcal: low, tdeeHighKcal: high } = estimate;
  if (typeof low !== "number" || typeof high !== "number") return null;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) return null;
  if (center < low || center > high) return null;
  return `${int(low)}–${int(high)}`;
}

function dataWeightOf(estimate: ExpenditureResponse): number | null {
  const weight = estimate.dataWeight;
  return typeof weight === "number" && Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : null;
}

/** `starting`: the frozen seed is the number. With no seed (no profile) the reason says why, and
 *  the line carries the way to fix it. */
function startingLine(estimate: ExpenditureResponse): TdeeLine {
  const seed = estimate.profileTdeeKcal;
  if (typeof seed !== "number") {
    return { key: "profile", label: "No estimate yet", value: "Not yet", kcal: null, range: null,
      detail: sentence(estimate.reason, "Finish your profile to start the estimate"),
      action: { label: "Set up your profile", href: "/settings" } };
  }
  return { key: "profile", label: "From your profile", value: `about ${kcal(seed)}`, kcal: seed,
    range: rangeAround(estimate, seed),
    detail: sentence(estimate.reason, "Your profile is the starting estimate") };
}

/** While the fade is under way the number is a blend, so the label names both sources (the meter
 *  shows the split); at full weight it is the account's own. */
function blendLabel(weight: number | null, phase: Phase): string {
  if (weight === null) return phase === "adaptive" ? "Learned from your days" : "Your days and your profile";
  return weight >= 1 ? "Learned from your days" : "Your days and your profile";
}

const UPDATED = "Updated daily from your logged food and weigh-ins.";

/**
 * `provisional` and `adaptive` carry the engine's own number; `held` keeps its last one. On an
 * adaptive night the reason is the proposal gate (E4), not a fault in the number, so it moves to a
 * note that says what it is about (Kimi audit 2026-10-04, finding 6).
 */
function learnedPhaseLine(estimate: ExpenditureResponse, phase: Phase, tdee: number): TdeeLine {
  const weight = dataWeightOf(estimate);
  const base = { key: "learned" as const, value: `about ${kcal(tdee)}`, kcal: tdee,
    range: rangeAround(estimate, tdee), dataWeight: weight };
  if (estimate.status === "held") {
    // A frozen number: its blend is history, so no meter (finding 16).
    return { ...base, label: "Last estimate", dataWeight: null, stale: true,
      detail: sentence(estimate.reason, "Holding the last estimate") };
  }
  if (estimate.reviewFlag) {
    // R5: never presented as learned — no band, no calorie colour, no meter (finding 1).
    return { ...base, label: "Needs a check", attention: true, dataWeight: null, range: null,
      detail: sentence(estimate.reason, "Check that every counted day is complete") };
  }
  const label = blendLabel(weight, phase);
  if (estimate.status === "blocked") {
    return { ...base, label, detail: UPDATED,
      note: `No target suggestion: ${sentence(clause(estimate.reason) || null, "the proposed change was held")}` };
  }
  if (phase === "provisional") {
    return { ...base, label, detail: sentence(estimate.reason, "Learning from your logged food and weigh-ins") };
  }
  // The gate reason joins the note after a colon, cased by the engine's `clause()` rule (copied below), so
  // "16 of 21 counted days…" and "Needs about six weeks…" both read as one sentence.
  return { ...base, label, detail: UPDATED,
    note: estimate.reason ? `No target suggestion yet: ${sentence(clause(estimate.reason), "")}` : null };
}

/**
 * exp-3.1.0: a periodic weight swing the trend is fitted around (`fluidCycleDays`). Said once, with
 * the engine's own period and no cause — the app does not know one and never guesses. Absent on
 * older rows and null when no cycle was fitted.
 */
export function fluidCycleLine(estimate: ExpenditureResponse): string | null {
  const days = estimate.fluidCycleDays;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return null;
  return `Your weight follows a ~${Math.round(days)}-day cycle; the estimate allows for it.`;
}

function phasedLines(estimate: ExpenditureResponse, phase: Phase): TdeeLine[] {
  const tdee = estimate.tdeeKcal;
  if (phase === "starting" || tdee === null) return [startingLine(estimate)];
  const lines: TdeeLine[] = [{ ...learnedPhaseLine(estimate, phase, tdee), cycle: fluidCycleLine(estimate) }];
  const seed = estimate.profileTdeeKcal;
  if (typeof seed === "number") lines.push(profileLine("Starting estimate", seed));
  return lines;
}

/* ---------------------------------------------------------------- shared */

function deviceLine(estimate: ExpenditureResponse): TdeeLine | null {
  const active = estimate.activityContext?.activeKcal7dAvg;
  if (active === null || active === undefined) return null;
  return { key: "device", label: "Device active energy",
    value: `${int(active)} kcal/day estimate`,
    detail: "7-day device average · not added to your food target.", kcal: active };
}

/** `phase` decides on an exp-3 row (a provisional `burn_in` carries a number); an exp-2 row, or a
 *  payload cached before the field existed, falls back to the status rules it was written under. */
export function tdeeLines(input: TdeeLinesInput): TdeeLine[] {
  const estimate = input.estimate;
  if (estimate === null) return [];
  const phase = phaseOf(estimate);
  const lines = phase ? phasedLines(estimate, phase) : legacyLines(estimate);
  const device = deviceLine(estimate);
  if (device) lines.push(device);
  return lines;
}

export function firstTdeeLine(lines: readonly TdeeLine[]): TdeeLine | null {
  return lines.find((line) => line.key !== "device" && line.kcal !== null) ?? null;
}

/**
 * How far the number has moved from the starting estimate onto the account's own days (R2: the
 * fade), drawn as a split: the filled olive segment is the account's own days, the outlined one
 * the profile, each under its own label (Kimi audit 2026-10-04, findings 3–5: one fill growing
 * toward the profile label read backwards, and a pale track failed 3:1). Shown only while the two
 * still share the number; a held or flagged number has no meter.
 */
function LearnedMeter({ weight }: { weight: number }) {
  const reduce = useReducedMotionConfig();
  const captionId = `${useId().replace(/:/g, "")}-meter`;
  const pct = Math.round(weight * 100);
  // The caption names what the bar measures, so it is not read as the count of days above it
  // (finding N4); the end labels sit under the segments they name.
  return <div className="mt-2 flex flex-col gap-1">
    <p id={captionId} className={`m-0 ${DETAIL}`}>Where this number comes from</p>
    <div role="meter" aria-labelledby={captionId} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={pct} aria-valuetext={`${pct}% from your days, the rest from your profile`}
      className="flex h-2 w-full gap-0.5">
      <motion.span className="h-full rounded-full bg-primary"
        initial={false} animate={{ width: `${pct}%` }} transition={spring("smooth", reduce)} />
      <span className="h-full min-w-2 flex-1 rounded-full border border-muted" />
    </div>
    <div aria-hidden="true" className={`flex justify-between gap-3 ${DETAIL}`}>
      <span>Your days</span><span>Your profile</span>
    </div>
  </div>;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The figure, and its band in words: "range" is visible, not a screen-reader aside (finding 2). */
function Figure({ line }: { line: TdeeLine }) {
  const value = capitalised(line.value);
  const quiet = line.attention === true || line.stale === true;
  return <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-title tabular-nums">
    {/* A paused or held number keeps ink, not the calorie colour, so it does not read as current
        (Kimi audit 2026-10-04, findings 1 and N2). */}
    <span className={quiet ? "text-graphite" : "text-charcoal"}>
      {quiet ? value : <KcalText text={value} />}</span>
    {line.range && <span className="text-caption font-normal text-muted">range {line.range}</span>}
  </p>;
}

/** The headline: always open, because the number, its band and the reason are the answer. */
function LeadLine({ line }: { line: TdeeLine }) {
  const showMeter = !line.attention && typeof line.dataWeight === "number" && line.dataWeight < 1;
  return <div className="flex flex-col gap-1" data-tdee-lead={line.key}>
    <p className={`m-0 ${DETAIL}`}>{line.label}</p>
    {line.attention && <Notice tone="attention" title={line.detail} className="my-1" />}
    {line.kcal !== null && <Figure line={line} />}
    {!line.attention && <p className="m-0 text-caption font-normal text-graphite">{line.detail}</p>}
    {line.note && <p className={`m-0 ${DETAIL}`}>{line.note}</p>}
    {line.cycle && <p className={`m-0 ${DETAIL}`}>{line.cycle}</p>}
    {line.action && <a href={line.action.href}
      className={buttonClasses({ className: "mt-2 self-start" })}>
      {line.action.label}</a>}
    {showMeter && <LearnedMeter weight={line.dataWeight as number} />}
  </div>;
}

/** What "counted" means, next to the number that counts them (finding 13). Account-neutral. */
function WhichDaysCount({ divider }: { divider: boolean }) {
  return <Disclosure variant="row" title="Which days count" divider={divider}>
    <p className={`m-0 ${DETAIL}`}>
      A day counts when its calories are fully logged. From your first mark on Today, only days
      you mark as fully logged count.
    </p>
  </Disclosure>;
}

export default function TdeeLines(input: TdeeLinesInput) {
  const lines = tdeeLines(input);
  const lead = lines.find((line) => line.key !== "device") ?? null;
  const rest = lines.filter((line) => line !== lead);
  // "Which days count" explains a number; with no number yet (no profile) it is noise (finding N6).
  const phased = input.estimate !== null && phaseOf(input.estimate) !== null && lead?.kcal != null;
  return (
    <div className="flex flex-col gap-2">
      {lead && <LeadLine line={lead} />}
      <div className={lead !== null && (rest.length > 0 || phased) ? "mt-2 flex flex-col" : "flex flex-col"}>
        {rest.map((line, index) => (
          <Disclosure key={line.key} variant="row" title={line.label} divider={lead !== null || index > 0}
            count={<span className={`tabular-nums ${VALUE}`}><KcalText text={line.value} /></span>}>
            <p className={`m-0 ${DETAIL}`}>{line.detail}</p>
          </Disclosure>
        ))}
        {phased && <WhichDaysCount divider={lead !== null || rest.length > 0} />}
      </div>
    </div>
  );
}
