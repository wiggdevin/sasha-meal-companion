"use client";

/**
 * Onboarding v2, lane 3 — the playback-sentence renderer (BRIEF.md §4/§5, acceptance criteria
 * for lane 3 in BRIEF.md §6): what the user said, played back as one editable sentence with
 * inline chips, instead of a five-chip grid. One "That's me" tap confirms every high-confidence
 * REQUIRED field at once; a hold on any ghost chip opens that field for its own edit instead of
 * confirming it, and a confirmed chip's one action (click, Enter/Space, or a hold — they all
 * converge, see `SentenceChip`) opens that same editor; an empty slot renders inline with a
 * point-affordance for Sprout (the actual Sprout wiring is lane 2's — this component exposes
 * `pointingAt`, the key of the first missing-or-dropped REQUIRED field, for a caller to wire up).
 *
 * `REQUIRED_FIELDS` (birthYear, sex, heightCm, weightKg, goal) are the five BRIEF.md §2 calls
 * "Required" — these alone gate `pointingAt`/`hasAnyHighConfidence`/"That's me" and alone ever
 * render an empty gap chip (BRIEF §4: "gaps point, they don't ask" — a gap is a required field
 * with nothing in it yet). `activity` is BRIEF §2's one **Optional** field with a sentence-table
 * entry in VISUAL-SPEC.md §5 — it appends as a trailing clause only once it has a real value
 * (ghost or high band), never as a forced empty ask, and never affects the required-field gating.
 *
 * Sol r1 fixes: a `<div>`, not a `<p>`, hosts the chip row; connective words turn the chip row
 * into an actual sentence; a ghost birth year gets its own confirm action; `firstMissingField`
 * reads the band, not bare presence.
 *
 * Sol r2 fixes: a high-confidence birth year carries its own "Edit" button beside the stepper.
 *
 * Sol r3 re-plan: `effectiveBand` (types.ts) gates every field read here. `SentenceChip` exposes
 * one required `onActivate` (click-driven) instead of an optional `onTap`.
 *
 * Sol r4 fixes: `hasFactValue` rejects an enum string outside its real values. `factValue` is the
 * one accessor every field read here goes through.
 *
 * Sol r5 fixes: `hasFactValue` (types.ts) now checks the FIELD's own expected shape first (a
 * number on an enum key, or a string on a numeric key, used to slip through the r4 fix — r5
 * BLOCK). The per-field lead text is now band-aware (`leadFor` below) — a static "and want to"
 * before an empty "what's the goal?" gap chip read as a stacked, redundant question (r5 WARN);
 * the empty case now uses a plain comma instead. `activity` is now rendered (r5 WARN: BRIEF/
 * VISUAL-SPEC both describe it, but it was absent here entirely).
 *
 * Sol r6 fixes: the sentence's closing "." was static on the goal field regardless of what came
 * after it — an empty goal rendered the double-punctuation "what's the goal?.", and a filled goal
 * followed by activity rendered a mid-sentence "build muscle., usually …" (r6 WARN). `goalTrail`
 * below only adds "." once goal is actually resolved AND nothing (activity) follows it — the
 * eventual segment, filled or not, supplies its own terminator otherwise. The empty weight gap
 * ("and now?") also had no weight cue of its own (r6 WARN) — its lead is now ", weight" instead of
 * a bare comma, so the fragment reads "…tall?, weight and now?" rather than a free-floating "now?".
 *
 * VISUAL-SPEC.md §5 (2026-10-07): the gap-prompt copy below is that spec's own table verbatim —
 * short lowercase question fragments, never a bracketed `[field?]` placeholder and never the bare
 * field name for sex ("add this", not "sex" or "your sex" — the picker itself explains why, per
 * the spec: "never asks 'sex' as a bare word"). Weight's filled-state lead reads "starting
 * weight," so a resolved value continues that clause, exactly as the spec asks.
 */
import { BirthYearStepper } from "@/components/Onboarding/facts/BirthYearStepper";
import { CHIP_FILL } from "@/components/Onboarding/facts/chip-fill";
import { SentenceChip } from "@/components/Onboarding/facts/SentenceChip";
import Button from "@/components/ui/Button";
import {
  effectiveBand, factValue, type ChipConfidence, type OnboardingFactKey, type OnboardingFacts,
} from "@/components/Onboarding/facts/types";
import { heightEchoCm, weightEchoKg } from "@/components/Onboarding/facts/unit-echo";

const GOAL_LABEL: Record<string, string> = {
  lose_fat: "lose fat", recomp: "recomp", maintain: "maintain", gain_muscle: "build muscle",
};
const SEX_LABEL: Record<string, string> = {
  male: "male", female: "female", unspecified: "prefer not to say",
};
const ACTIVITY_LABEL: Record<string, string> = {
  sedentary: "mostly sitting", light: "lightly active", moderate: "moderately active",
  active: "active", very_active: "very active",
};

/** The band-dependent words right before a field's chip, so the row reads as one sentence (BRIEF
 *  §4: "You're 34 … about 5'10\" … and want to build muscle") without also reading as a stacked,
 *  redundant question when the chip is still an empty gap prompt (Sol r5 WARN: a static "and want
 *  to" before "what's the goal?" repeated "goal" twice in a row). Filled fields keep the fuller,
 *  conversational connective; empty ones use a plain comma and let the gap prompt's own wording
 *  carry the sentence. */
function leadFor(key: OnboardingFactKey, empty: boolean): string {
  switch (key) {
    case "birthYear": return "You’re";
    case "sex": return ",";
    // Empty still names the field ("weight") so the gap prompt that follows ("and now?") isn't a
    // free-floating question with no cue of its own (Sol r6 WARN).
    case "heightCm": return ", about";
    case "weightKg": return empty ? ", weight" : ", starting weight";
    case "goal": return empty ? "," : ", and want to";
    default: return ",";
  }
}

/** The five fields BRIEF.md §2 calls Required — the only ones that gate `pointingAt`,
 *  `hasAnyHighConfidence`/"That's me", or ever render as an empty gap chip. Allergy/condition has
 *  its own card (BRIEF §4, "safety, before any food word") and never appears here. */
const REQUIRED_FIELDS: { key: OnboardingFactKey }[] = [
  { key: "birthYear" }, { key: "sex" }, { key: "heightCm" }, { key: "weightKg" }, { key: "goal" },
];

/** The sentence's closing "." — only once goal is actually resolved (its own "?" already
 *  terminates the empty gap prompt, so a second "." there would double-punctuate) AND nothing
 *  else follows it (an optional `activity` clause supplies its own continuation and, eventually,
 *  its own end) — Sol r6 WARN: a static trail on the goal field punctuated mid-sentence. */
function goalTrail(goalBand: ChipConfidence, activityBand: ChipConfidence): string {
  return goalBand !== "empty" && activityBand === "empty" ? "." : "";
}

export type PlaybackSentenceProps = {
  facts: OnboardingFacts;
  today?: Date;
  /** The one action on a confirmed value, or a ghost chip's hold-instead-of-confirm — opens this
   *  field's own single-value editor. */
  onHoldEdit: (key: OnboardingFactKey) => void;
  /** A ghost chip's primary action — confirms just this one field. */
  onGhostConfirm: (key: OnboardingFactKey) => void;
  /** An empty slot's primary action — opens its single-value picker (no new extraction call). */
  onEmptyTap: (key: OnboardingFactKey) => void;
  /** Nudges the in-chip birth-year stepper; distinct from confirming or editing it. */
  onBirthYearNudge: (birthYear: number) => void;
  /** "That's me" — confirms every required field currently at high confidence, all at once. */
  onConfirmAll: () => void;
};

/** Screen-reader label only — never shown. VISUAL-SPEC.md §5 keeps the visible gap chip terse and
 *  conversational ("add this"); the aria label stays descriptive for anyone not reading the chip
 *  in the context of the sentence around it. */
function fieldLabel(key: OnboardingFactKey): string {
  switch (key) {
    case "birthYear": return "age/birth year";
    case "sex": return "sex";
    case "heightCm": return "height";
    case "weightKg": return "weight";
    case "goal": return "goal";
    case "activity": return "activity level";
    default: return key;
  }
}

/** The visible gap-prompt text for an empty slot — VISUAL-SPEC.md §5's table verbatim, no
 *  brackets, no bare field names. */
function gapPrompt(key: OnboardingFactKey): string {
  switch (key) {
    case "birthYear": return "how old?";
    case "sex": return "add this";
    case "heightCm": return "how tall?";
    case "weightKg": return "and now?";
    case "goal": return "what’s the goal?";
    case "activity": return "how active?";
    default: return fieldLabel(key);
  }
}

function chipLabel(key: OnboardingFactKey, facts: OnboardingFacts): string {
  switch (key) {
    case "heightCm": {
      const v = factValue(facts, "heightCm");
      return v !== undefined ? heightEchoCm(v) : "";
    }
    case "weightKg": {
      const v = factValue(facts, "weightKg");
      return v !== undefined ? weightEchoKg(v) : "";
    }
    case "goal": {
      const v = factValue(facts, "goal");
      return v ? GOAL_LABEL[v] : "";
    }
    case "sex": {
      const v = factValue(facts, "sex");
      return v ? SEX_LABEL[v] : "";
    }
    case "activity": {
      const v = factValue(facts, "activity");
      return v ? ACTIVITY_LABEL[v] : "";
    }
    default: return "";
  }
}

/** The first REQUIRED field whose effective band is empty — no usable value yet, or dropped for
 *  low confidence (BRIEF §5: "≤ 0.50 → field dropped, asked plainly") — where Sprout's pose
 *  should turn. Never points at `activity`: it's optional and never a forced ask. */
export function firstMissingField(facts: OnboardingFacts): OnboardingFactKey | null {
  return REQUIRED_FIELDS.map((f) => f.key)
    .find((key) => effectiveBand(facts, key) === "empty") ?? null;
}

export function hasAnyHighConfidence(facts: OnboardingFacts): boolean {
  return REQUIRED_FIELDS.some((f) => effectiveBand(facts, f.key) === "high");
}

export function PlaybackSentence({
  facts, today = new Date(), onHoldEdit, onGhostConfirm, onEmptyTap, onBirthYearNudge, onConfirmAll,
}: PlaybackSentenceProps) {
  const pointingAt = firstMissingField(facts);
  const birthYear = factValue(facts, "birthYear") ?? null;
  const activityBand = effectiveBand(facts, "activity");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5 text-body text-charcoal">
        {REQUIRED_FIELDS.map(({ key }) => {
          const band = effectiveBand(facts, key);
          const label = fieldLabel(key);
          const trail = key === "goal" ? goalTrail(band, activityBand) : undefined;
          return (
            <span key={key} className="flex flex-wrap items-center gap-1.5">
              <span>{leadFor(key, band === "empty")}</span>
              {band === "empty" ? (
                <SentenceChip kind="empty" label={gapPrompt(key)}
                  ariaLabel={`Add your ${label}`} onActivate={() => onEmptyTap(key)} />
              ) : key === "birthYear" && birthYear !== null ? (
                <span className="inline-flex items-center gap-1">
                  <BirthYearStepper birthYear={birthYear} today={today} onChange={onBirthYearNudge} />
                  {band === "ghost" && (
                    <SentenceChip kind="ghost" label="Confirm" ariaLabel="Confirm birth year"
                      onActivate={() => onGhostConfirm(key)} onHoldEdit={() => onHoldEdit(key)} />
                  )}
                  {/* The stepper's +/- nudges a value; they are not the "open the full editor"
                      action every other chip's activation reaches (Sol r2 WARN) — a real button,
                      so Enter/Space and assistive-tech clicks already work for free. */}
                  <button type="button" aria-label="Edit birth year" onClick={() => onHoldEdit(key)}
                    className={`${CHIP_FILL} inline-flex min-h-8 items-center rounded-full border border-dashed border-muted px-2.5 text-label-md text-muted`}>
                    Edit
                  </button>
                </span>
              ) : (
                <SentenceChip kind={band === "ghost" ? "ghost" : "value"}
                  label={chipLabel(key, facts)} ariaLabel={`${label}: ${chipLabel(key, facts)}`}
                  onActivate={band === "ghost" ? () => onGhostConfirm(key) : () => onHoldEdit(key)}
                  onHoldEdit={band === "ghost" ? () => onHoldEdit(key) : undefined} />
              )}
              {trail && <span>{trail}</span>}
            </span>
          );
        })}
        {/* Optional (BRIEF §2): only appears once it has a real value — never a forced empty ask,
            never part of the required gating above. */}
        {activityBand !== "empty" && (
          <span className="flex flex-wrap items-center gap-1.5">
            <span>, usually</span>
            <SentenceChip kind={activityBand === "ghost" ? "ghost" : "value"}
              label={chipLabel("activity", facts)}
              ariaLabel={`${fieldLabel("activity")}: ${chipLabel("activity", facts)}`}
              onActivate={activityBand === "ghost"
                ? () => onGhostConfirm("activity") : () => onHoldEdit("activity")}
              onHoldEdit={activityBand === "ghost" ? () => onHoldEdit("activity") : undefined} />
            <span>.</span>
          </span>
        )}
      </div>
      {pointingAt && (
        <p className="m-0 text-tiny font-normal text-muted" data-pointing-at={pointingAt}>
          Sprout is pointing at what&rsquo;s still missing.
        </p>
      )}
      {hasAnyHighConfidence(facts) && (
        <Button variant="primary" className="self-start" onClick={onConfirmAll}>
          That&rsquo;s me
        </Button>
      )}
    </div>
  );
}
