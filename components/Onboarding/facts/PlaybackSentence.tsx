"use client";

/**
 * Onboarding v2 — the facts recap: what the person has told Sprout so far, read back as one
 * inline sentence ("You’re 34, female, 5′10″, 165 lb, and want to lose fat.").
 *
 * Live QA 2026-10-07 (defect 4) rebuilt this. It used to put gap chips into the prose ("add this",
 * "and now?") and lay every word out as its own flex item, so a comma could start a line with a
 * space before it. Now:
 * - only answered fields appear; a missing field is asked by `FactQuestion`, below, in plain words;
 * - the sentence is one `<p>` of inline text, punctuation joined to the word before it;
 * - every value is a ≥ 44 px chip that opens that field's question again (tap to change);
 * - a value Sprout only guessed from typing (ghost band) carries a dashed outline and a "?" until
 *   the person confirms it in its question;
 * - units are US only (feet and inches, pounds), stored metric underneath.
 */
import type { ReactNode } from "react";
import { CHIP_FILL } from "@/components/Onboarding/facts/chip-fill";
import {
  effectiveBand, factValue, type ChipConfidence, type OnboardingFactKey, type OnboardingFacts,
} from "@/components/Onboarding/facts/types";
import { ageFromBirthYear, heightImperial, weightImperial } from "@/components/Onboarding/facts/unit-echo";

const GOAL_LABEL: Record<string, string> = {
  lose_fat: "lose fat", recomp: "lose fat and build muscle", maintain: "keep what you have",
  gain_muscle: "build muscle",
};
const SEX_LABEL: Record<string, string> = {
  male: "male", female: "female", unspecified: "sex not given",
};
const ACTIVITY_LABEL: Record<string, string> = {
  sedentary: "mostly sitting", light: "lightly active", moderate: "moderately active",
  active: "active", very_active: "very active",
};

/** The five required fields, in the order the facts beat asks them. */
export const REQUIRED_FACT_ORDER: readonly OnboardingFactKey[] = [
  "birthYear", "sex", "heightCm", "weightKg", "goal",
];

/** Plain names for screen readers and the edit buttons ("Change your weight"). */
const FIELD_NAME: Partial<Record<OnboardingFactKey, string>> = {
  birthYear: "age", sex: "sex", heightCm: "height", weightKg: "weight", goal: "goal",
  activity: "activity",
};

function valueLabel(key: OnboardingFactKey, facts: OnboardingFacts, today: Date): string {
  switch (key) {
    case "birthYear": { const v = factValue(facts, "birthYear"); return v === undefined ? "" : String(ageFromBirthYear(v, today)); }
    case "heightCm": { const v = factValue(facts, "heightCm"); return v === undefined ? "" : heightImperial(v); }
    case "weightKg": { const v = factValue(facts, "weightKg"); return v === undefined ? "" : weightImperial(v); }
    case "goal": { const v = factValue(facts, "goal"); return v ? GOAL_LABEL[v] : ""; }
    case "sex": { const v = factValue(facts, "sex"); return v ? SEX_LABEL[v] : ""; }
    case "activity": { const v = factValue(facts, "activity"); return v ? ACTIVITY_LABEL[v] : ""; }
    default: return "";
  }
}

/** The first required field whose value is missing or dropped (no usable value). */
export function firstMissingField(facts: OnboardingFacts): OnboardingFactKey | null {
  return REQUIRED_FACT_ORDER.find((key) => effectiveBand(facts, key) === "empty") ?? null;
}

/** The first required field not yet confirmed (missing, or only a ghost guess) — the one the facts
 *  beat asks next. */
export function firstUnconfirmedField(facts: OnboardingFacts): OnboardingFactKey | null {
  return REQUIRED_FACT_ORDER.find((key) => effectiveBand(facts, key) !== "high") ?? null;
}

export function hasAnyHighConfidence(facts: OnboardingFacts): boolean {
  return REQUIRED_FACT_ORDER.some((key) => effectiveBand(facts, key) === "high");
}

function ValueChip({ fieldKey, band, label, active, onEdit }: {
  fieldKey: OnboardingFactKey; band: ChipConfidence; label: string; active: boolean;
  onEdit: (key: OnboardingFactKey) => void;
}) {
  const ghost = band === "ghost";
  const name = FIELD_NAME[fieldKey] ?? fieldKey;
  return <button type="button" data-chip-kind={ghost ? "ghost" : "value"} aria-pressed={active}
    aria-label={ghost ? `Your ${name}: ${label}? Tap to confirm` : `Your ${name}: ${label}. Tap to change`}
    onClick={() => onEdit(fieldKey)}
    className={`${CHIP_FILL} mx-0.5 inline-flex min-h-11 items-center rounded-full px-3 align-middle font-sans text-body font-medium text-charcoal ${ghost ? "border border-dashed border-muted" : ""} ${active ? "ring-2 ring-[rgb(var(--ink-rgb)/0.55)]" : ""}`}>
    {ghost ? `${label}?` : label}
  </button>;
}

export type PlaybackSentenceProps = {
  facts: OnboardingFacts;
  today?: Date;
  /** The field whose question is open below, highlighted in the sentence. */
  activeField?: OnboardingFactKey | null;
  /** Tap on any value: open that field's question again. */
  onEdit: (key: OnboardingFactKey) => void;
};

export function PlaybackSentence({ facts, today = new Date(), activeField = null, onEdit }: PlaybackSentenceProps) {
  const body = (["birthYear", "sex", "heightCm", "weightKg", "activity"] as const)
    .filter((key) => effectiveBand(facts, key) !== "empty");
  const goalBand = effectiveBand(facts, "goal");
  if (body.length === 0 && goalBand === "empty") return null;
  const chip = (key: OnboardingFactKey) => <ValueChip key={key} fieldKey={key} band={effectiveBand(facts, key)}
    label={valueLabel(key, facts, today)} active={activeField === key} onEdit={onEdit} />;

  const parts: ReactNode[] = [];
  if (body.length > 0) {
    parts.push("You’re ");
    body.forEach((key, index) => {
      if (index > 0) parts.push(", ");
      parts.push(chip(key));
    });
    if (goalBand !== "empty") { parts.push(", and want to "); parts.push(chip("goal")); }
  } else {
    parts.push("You want to ");
    parts.push(chip("goal"));
  }
  parts.push(".");
  return <p className="m-0 w-full font-serif text-heading-sm leading-[1.9] text-charcoal" data-testid="facts-recap">
    {parts.map((part, index) => typeof part === "string" ? <span key={`t${index}`}>{part}</span> : part)}
  </p>;
}
