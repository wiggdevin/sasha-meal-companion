/**
 * Who may get an automatic loss or gain pace, and who gets no plan at all (onboarding v2
 * question set §4, gaps G1–G3; owner decisions 2026-10-08; TDEE plan step D "Eligibility").
 *
 * - Under 18 on the revision's date: no target is built (`AdultOnlyError`). The account can
 *   still browse.
 * - Pregnant, breastfeeding, an eating disorder, kidney disease, or a diet a clinician set: the
 *   goal stays, but the pace is held at 0 (maintenance calories), whatever the client sends.
 * - Kidney disease: protein is the standard adult amount (0.8 g/kg of the protein basis), not
 *   the 1.8–2.0 g/kg the engine uses for everyone else.
 *
 * The signals are the account's own stored answers only: `constraint_profiles.conditions`
 * (free text and the fixed tap-only tokens below) and the account's dietary-profile instances.
 * Nothing here reads a model's judgment. Pure: no I/O.
 */
import { APP_NAME } from "@/lib/brand";

export const ADULT_AGE = 18;

/** Standard adult protein (g per kg of the BMI-30-capped protein basis), used for kidney disease. */
export const STANDARD_PROTEIN_G_PER_KG = 0.8;

export const RATE_HOLDS = [
  "pregnancy", "breastfeeding", "eating_disorder", "kidney", "clinician_diet",
] as const;
export type RateHold = (typeof RATE_HOLDS)[number];

/**
 * The exact `constraint_profiles.conditions` entries the onboarding safety round writes for a
 * tap (§1c). They are plain words the user can read and remove in Foods › Avoids. "Pregnant"
 * also arms the pregnancy tuna check (lib/policy/pregnancy-tuna.ts).
 */
export const SAFETY_CONDITION_TEXT = {
  pregnant: "Pregnant",
  breastfeeding: "Breastfeeding",
  clinicianDiet: "Diet set by my clinician",
} as const;

const CONDITION_PATTERNS: Readonly<Record<RateHold, RegExp>> = {
  // Same words as the tuna check (lib/policy/pregnancy-tuna.ts PREGNANCY).
  pregnancy: /\bpregnan(?:t|cy)\b|\bexpecting\b/i,
  breastfeeding: /breast-?\s?feed|chest-?\s?feed|\blactat/i,
  // Same list as lib/coach/onboarding-safety.ts, plus binge eating.
  eating_disorder: /\beating disorder|anorexi|bulimi|\barfid\b|\bbinge[- ]?eating\b/i,
  // §4d: /kidney|renal|dialysis/. "Kidney stones" also matches; the conservative direction.
  kidney: /\bkidney|\brenal\b|dialysis|\bckd\b/i,
  clinician_diet: /\bdiet set by my (?:clinician|doctor|dietitian)\b|\bclinician[- ]set diet\b/i,
};

/** Dietary-profile ids (docs/research/dietary-profiles.draft.json) that hold the pace. */
const PROFILE_HOLDS: Readonly<Record<string, RateHold>> = {
  pregnancy: "pregnancy",
  lactation: "breastfeeding",
  eating_disorder_recovery: "eating_disorder",
  ckd: "kidney",
  ckd_dialysis: "kidney",
};

/** Phase 13 `minor_under_18`: adult calorie plans and weight goals disabled. */
const MINOR_PROFILE_ID = "minor_under_18";

/** True when saving or removing this dietary profile can change the account's pace holds. */
export function profileAffectsPace(profileId: string): boolean {
  return Object.hasOwn(PROFILE_HOLDS, profileId) || profileId === MINOR_PROFILE_ID;
}

export type EligibilityProfile = { profileId: string; source?: string | null };

export type TargetEligibilitySignals = {
  conditions?: readonly string[] | null;
  profiles?: readonly EligibilityProfile[] | null;
  /** The stored birth year and the date it is judged on; both or neither. */
  birthYear?: number | null;
  onDate?: string;
};

export type TargetEligibility = {
  /** Reasons the pace is held at 0, in `RATE_HOLDS` order. Empty: any preset is allowed. */
  holds: RateHold[];
  /** No plan at all: the minor life-stage profile, or (server reads with a date) a stored birth
   *  year under 18 on that date. The derivation also checks the birth year it is given. */
  minor: boolean;
};

export const NO_HOLDS: TargetEligibility = Object.freeze({ holds: [], minor: false }) as
  TargetEligibility;

export function targetEligibility(signals: TargetEligibilitySignals): TargetEligibility {
  const found = new Set<RateHold>();
  for (const text of signals.conditions ?? []) {
    if (typeof text !== "string") continue;
    for (const hold of RATE_HOLDS) if (CONDITION_PATTERNS[hold].test(text)) found.add(hold);
  }
  let minor = false;
  for (const profile of signals.profiles ?? []) {
    if (Object.hasOwn(PROFILE_HOLDS, profile.profileId)) found.add(PROFILE_HOLDS[profile.profileId]);
    if (profile.profileId === MINOR_PROFILE_ID) minor = true;
    if (profile.source === "clinician_directed_per_user") found.add("clinician_diet");
  }
  if (signals.onDate && isMinorOn(signals.birthYear, signals.onDate)) minor = true;
  return { holds: RATE_HOLDS.filter((hold) => found.has(hold)), minor };
}

/**
 * The phone's twin of the server read, from the safety round's own taps (§1c) — so the
 * onboarding preview and the pace screen agree with what the server will write.
 */
export type SafetyAnswers = {
  pregnancy?: "pregnant" | "breastfeeding" | "trying_to_conceive" | null;
  clinicianDiet?: boolean;
  /** The optional free-text condition (never sent to a model). */
  conditionText?: string | null;
};

export function eligibilityFromSafetyAnswers(answers: SafetyAnswers): TargetEligibility {
  return targetEligibility({ conditions: safetyConditionEntries(answers) });
}

/** The `conditions` entries the onboarding constraint patch adds for these taps. */
export function safetyConditionEntries(answers: SafetyAnswers): string[] {
  const out: string[] = [];
  if (answers.pregnancy === "pregnant") out.push(SAFETY_CONDITION_TEXT.pregnant);
  if (answers.pregnancy === "breastfeeding") out.push(SAFETY_CONDITION_TEXT.breastfeeding);
  if (answers.clinicianDiet) out.push(SAFETY_CONDITION_TEXT.clinicianDiet);
  const text = answers.conditionText?.trim();
  if (text) out.push(text.slice(0, 64));
  return out;
}

/** Age in whole years on `onDate` (YYYY-MM-DD), the way the formula counts it (year − birth year).
 *  It can be one year high before the birthday; `isMinorOn` takes the full date when it is known. */
export function ageOn(birthYear: number, onDate: string): number {
  return Number(onDate.slice(0, 4)) - birthYear;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as "YYYY-MM-DD" (no Feb 30), else null. */
function calendarDay(value: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = typeof value === "string" ? ISO_DAY.exec(value) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
    ? { y, m, d } : null;
}

/** Whole years on `onDate` from a full date of birth (both "YYYY-MM-DD"): a birthday later in
 *  the year has not happened yet. Null when either date is not a real day. */
export function ageOnBirthDate(birthDate: string, onDate: string): number | null {
  const born = calendarDay(birthDate);
  const on = calendarDay(onDate);
  if (!born || !on) return null;
  const hadBirthday = on.m > born.m || (on.m === born.m && on.d >= born.d);
  return on.y - born.y - (hadBirthday ? 0 : 1);
}

/**
 * A year-only count cannot tell an 18-year-old from a 17-year-old in the calendar year they turn
 * 18 (audit 2026-10-10 A092). True for exactly that year: the phone then asks for the full date
 * of birth before it builds a plan.
 */
export function adultAgeUnconfirmed(birthYear: number | null | undefined, onDate: string): boolean {
  return typeof birthYear === "number" && Number.isFinite(birthYear)
    && ageOn(birthYear, onDate) === ADULT_AGE;
}

/**
 * Under 18 on `onDate`. With a full `birthDate` of the same year it is the exact age (a 17-year-old
 * whose birthday is still ahead is a minor); without one, the stored birth year's count, which is
 * what the server reads (`422 adult_only`). An unknown birth year is not a minor here.
 */
export function isMinorOn(
  birthYear: number | null | undefined, onDate: string, birthDate?: string | null,
): boolean {
  if (typeof birthYear !== "number" || !Number.isFinite(birthYear)) return false;
  const exact = birthDate && calendarDay(birthDate)?.y === birthYear
    ? ageOnBirthDate(birthDate, onDate) : null;
  return (exact ?? ageOn(birthYear, onDate)) < ADULT_AGE;
}

/** True when this account may get a non-zero loss or gain pace. */
export function paceAllowed(eligibility: TargetEligibility | null | undefined): boolean {
  return !eligibility || eligibility.holds.length === 0;
}

/** True when protein is the standard adult amount instead of the engine's high-protein factor. */
export function standardProtein(eligibility: TargetEligibility | null | undefined): boolean {
  return !!eligibility && eligibility.holds.includes("kidney");
}

/** Thrown by the derivation for a minor; the targets route answers it as 422 `adult_only`. */
export class AdultOnlyError extends Error {
  readonly code = "adult_only";
  constructor() {
    super(`${APP_NAME}'s plans are built for adults 18 and over.`);
    this.name = "AdultOnlyError";
  }
}
