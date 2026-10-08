/**
 * Onboarding v2 (BRIEF.md §3 "Local regex fast-path", §5 "Extraction pipeline"): the zero-model
 * banded regex pass over one utterance (typed or dictated). It never calls a model and never sees
 * anything the local safety filter (lib/coach/onboarding-safety.ts) has not already cleared —
 * that filter runs BEFORE this module, in the caller, not here (this module is pure text parsing
 * with no opinion on what is safe to read).
 *
 * BRIEF.md §5, "Resolved conflict #2": confidence banding applies to THIS path too, computed from
 * pattern strength, not presence. A unit word, an explicit keyword, or an unambiguous anchor
 * ("years old", "cm", "lose fat") earns HIGH (auto-confirm in the playback sentence); a bare
 * number with nothing to anchor it earns GHOST (needs one tap) — never HIGH, and never silently
 * dropped either, because the fast path found *something*, just not with confidence.
 *
 * Pure. No I/O, no model call. Every regex here is anchored and reused by its own unit tests
 * (onboarding-fast-path.test.ts), so a confidence rule never drifts from what the tests pin.
 */
import {
  ONBOARDING_ACTIVITIES, ONBOARDING_COOKING_EFFORTS, ONBOARDING_GOALS, type OnboardingAnswerKey,
  type OnboardingFacts,
} from "@/lib/coach/ui-blocks";
import { extractPlanFastPath, withoutPlanSpans } from "@/lib/coach/onboarding-fast-path-plan";

/** A unit word, an explicit keyword, or another unambiguous anchor was present. */
export const HIGH_CONFIDENCE = 0.9;
/** A bare number (or a loose word match) with no anchor: a ghost chip, needs one tap. */
export const GHOST_CONFIDENCE = 0.6;

export type FastPathFacts = Partial<OnboardingFacts> & {
  confidence: Partial<Record<OnboardingAnswerKey, number>>;
};

function emptyResult(): FastPathFacts {
  return { confidence: {} };
}

/** Lowercased, punctuation-softened, single-spaced — the shared normal form every pattern below
 *  is written against. Never mutates in place; every matcher reads this, never the raw text. */
function normalize(text: string): string {
  return String(text).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

/** How far back, in characters, a negation word still governs a match (Sol r1 WARN: "I don't
 *  want to lose weight" and "I'm not male" were read as high-confidence positive facts). A
 *  negated match is treated as no match at all — never a silent guess at the OPPOSITE fact
 *  either, just nothing, same as any other utterance this path cannot read with confidence. */
const NEGATION_WINDOW_CHARS = 24;
const NEGATION_WORD =
  /\b(not|never|no|n't|dont|don't|doesnt|doesn't|isnt|isn't|arent|aren't|wasnt|wasn't)\b/;
/** A clause boundary: a negation on the OTHER side of one never governs a later match (Sol r2
 *  WARN: "I don't smoke; want to lose fat" and "I don't smoke, but I'm male" were both
 *  suppressed by a negation from an earlier, unrelated clause — the fixed char window alone
 *  crossed clause boundaries it should have stopped at). */
const CLAUSE_BOUNDARY = /[.,;!?]/;

function isNegated(norm: string, matchIndex: number): boolean {
  let clauseStart = Math.max(0, matchIndex - NEGATION_WINDOW_CHARS);
  for (let i = matchIndex - 1; i >= clauseStart; i -= 1) {
    if (CLAUSE_BOUNDARY.test(norm[i])) { clauseStart = i + 1; break; }
  }
  return NEGATION_WORD.test(norm.slice(clauseStart, matchIndex));
}

/** The first occurrence of `pattern` in `norm` that is NOT negated, or null if every occurrence
 *  is (Sol r2 WARN: checking only the first occurrence missed a later affirmative repeat, e.g.
 *  "I don't want to lose weight, actually I do want to lose fat"). `pattern` need not carry the
 *  global flag itself — this always searches every occurrence regardless. */
function firstUnnegatedMatch(norm: string, pattern: RegExp): RegExpExecArray | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  for (const match of norm.matchAll(global)) {
    if (!isNegated(norm, match.index)) return match;
  }
  return null;
}

// ---- Height -------------------------------------------------------------------------------

/** "5'10", "5 ft 10", "5 foot 10 in", "5'" (no inches stated: whole feet). Unit word present
 *  (the mark, "ft"/"feet"/"foot") -> HIGH, always, regardless of how the inches are spelled. */
const FEET_INCHES = /\b(\d)\s*(?:'|feet|foot|ft\.?)\s*(\d{1,2})?\s*(?:"|''|in\.?|inches?)?\b/;
/** "178 cm", "178cm" -> HIGH. */
const HEIGHT_CM = /\b(\d{2,3}(?:\.\d+)?)\s*cm\b/;
/** A bare 2-3 digit number with no unit at all, only reached when nothing above matched and the
 *  number sits near the word "tall" — otherwise it is indistinguishable from any other number in
 *  the sentence and the fast path says nothing rather than guess (BRIEF.md: "never a silent
 *  guess"). In range, this is still only a GHOST: no unit word, so no auto-confirm. */
const HEIGHT_BARE = /\b(\d{2,3})\b(?=[^.?!]*\btall\b)|\btall\b[^.?!]*\b(\d{2,3})\b/;

function extractHeight(norm: string, out: FastPathFacts): void {
  const feetInches = FEET_INCHES.exec(norm);
  if (feetInches) {
    const feet = Number(feetInches[1]);
    const inches = feetInches[2] ? Number(feetInches[2]) : 0;
    if (feet >= 3 && feet <= 7 && inches < 12) {
      out.heightCm = Math.round((feet * 12 + inches) * 2.54 * 10) / 10;
      out.confidence.heightCm = HIGH_CONFIDENCE;
      return;
    }
  }
  const cm = HEIGHT_CM.exec(norm);
  if (cm) {
    const value = Number(cm[1]);
    if (value >= 120 && value <= 230) {
      out.heightCm = value;
      out.confidence.heightCm = HIGH_CONFIDENCE;
      return;
    }
  }
  const bare = HEIGHT_BARE.exec(norm);
  if (bare) {
    const value = Number(bare[1] ?? bare[2]);
    if (value >= 120 && value <= 230) {
      out.heightCm = value;
      out.confidence.heightCm = GHOST_CONFIDENCE;
    }
  }
}

// ---- Weight -------------------------------------------------------------------------------

const WEIGHT_KG = /\b(\d{2,3}(?:\.\d+)?)\s*(?:kgs?|kilograms?)\b/;
const WEIGHT_LB = /\b(\d{2,3}(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/;
const LB_PER_KG = 0.45359237;
/** A bare number near "weigh"/"weight" with no unit word at all: GHOST, assumed lb (the app's
 *  display default, lib/health/units.ts) only as a storage choice — never auto-confirmed either
 *  way, so a wrong unit assumption costs the user one tap, not a silently wrong target. */
const WEIGHT_BARE = /\bweigh(?:s|ed|ing)?\b[^.?!]*?\b(\d{2,3}(?:\.\d+)?)\b|\b(\d{2,3}(?:\.\d+)?)\b[^.?!]*?\bweight\b/;

function extractWeight(norm: string, out: FastPathFacts): void {
  const kg = WEIGHT_KG.exec(norm);
  if (kg) {
    const value = Number(kg[1]);
    if (value >= 20 && value <= 300) {
      out.weightKg = value;
      out.confidence.weightKg = HIGH_CONFIDENCE;
      return;
    }
  }
  const lb = WEIGHT_LB.exec(norm);
  if (lb) {
    const value = Number(lb[1]);
    if (value >= 40 && value <= 660) {
      out.weightKg = Math.round(value * LB_PER_KG * 10) / 10;
      out.confidence.weightKg = HIGH_CONFIDENCE;
      return;
    }
  }
  const bare = WEIGHT_BARE.exec(norm);
  if (bare) {
    const value = Number(bare[1] ?? bare[2]);
    if (value >= 40 && value <= 400) {
      out.weightKg = Math.round(value * LB_PER_KG * 10) / 10;
      out.confidence.weightKg = GHOST_CONFIDENCE;
    }
  }
}

// ---- Age / birth year -----------------------------------------------------------------------

/** "34 years old", "34 yo", "34 y.o." — the unit word ("years old") is the anchor: HIGH. The
 *  trailing \b sits only on the alternatives that need it: "y.o." already ends on a non-word
 *  character (the period), so a shared trailing \b after it never matches (Sol r1 NIT). */
/** Sol privacy-round BLOCK: the separator before "year" only allowed whitespace, so the
 *  hyphenated "34-year-old" never matched at all (slipping past redaction untouched) while
 *  "34 year old" did. `[\s-]*` on both sides of "year(s)" accepts either form. */
const AGE_WITH_UNIT = /\b(\d{1,2})[\s-]*(?:years?[\s-]*old\b|yo\b|y\.o\.)/;
/** "born in 1992", "born 1992" — "born" is the anchor: HIGH. */
const BORN_YEAR = /\bborn\s*(?:in|on)?\s*(\d{4})\b/;
/** A bare 4-digit year, no "born" context: still fairly unambiguous (nothing else in this
 *  schema is ever a 4-digit number) but no explicit anchor, so GHOST, not HIGH. */
const BARE_YEAR = /\b(19[0-9]{2}|20[0-4][0-9])\b/;
/** "I'm 34", "I am 34" with no unit word at all: GHOST — could be an age, could be anything. */
const BARE_AGE = /\bi'?m\s+(\d{1,2})\b|\bi\s+am\s+(\d{1,2})\b/;

function extractBirthYear(norm: string, now: Date, out: FastPathFacts): void {
  const currentYear = now.getUTCFullYear();
  const withUnit = AGE_WITH_UNIT.exec(norm);
  if (withUnit) {
    const age = Number(withUnit[1]);
    if (age >= 13 && age <= 100) {
      out.birthYear = currentYear - age;
      out.confidence.birthYear = HIGH_CONFIDENCE;
      return;
    }
  }
  const born = BORN_YEAR.exec(norm);
  if (born) {
    const year = Number(born[1]);
    if (year >= 1900 && year <= currentYear) {
      out.birthYear = year;
      out.confidence.birthYear = HIGH_CONFIDENCE;
      return;
    }
  }
  const bareAge = BARE_AGE.exec(norm);
  if (bareAge) {
    const age = Number(bareAge[1] ?? bareAge[2]);
    if (age >= 13 && age <= 100) {
      out.birthYear = currentYear - age;
      out.confidence.birthYear = GHOST_CONFIDENCE;
      return;
    }
  }
  const bareYear = BARE_YEAR.exec(norm);
  if (bareYear) {
    const year = Number(bareYear[1]);
    if (year >= 1900 && year <= currentYear) {
      out.birthYear = year;
      out.confidence.birthYear = GHOST_CONFIDENCE;
    }
  }
}

// ---- Goal -------------------------------------------------------------------------------------

/** Each pattern is an explicit, human-worded phrase (BRIEF.md §2's jargon-free pills) — presence
 *  of the phrase IS the anchor, so every goal match is HIGH. Order matters: "recomp"/"both"
 *  phrasing is checked before the single-direction ones so "lose fat and build muscle" resolves
 *  to recomp, not to whichever direction's regex happens to run first. */
const GOAL_PATTERNS: readonly [(typeof ONBOARDING_GOALS)[number], RegExp][] = [
  ["recomp", /\brecomp(?:osition)?\b/],
  ["recomp", /\b(lose|drop|cut).{0,20}\band\b.{0,20}(build|gain).{0,10}muscle\b/],
  ["recomp", /\bboth\b.{0,20}(lose|muscle)|\brecomposition\b/],
  ["lose_fat", /\b(lose|losing|drop|dropping|cut|cutting|shed)\s*(?:some\s*)?(?:body\s*)?(?:fat|weight)\b/],
  // "I want to drop 20 lb" proposes Lose weight (question set §1a); the user taps to confirm.
  ["lose_fat", /\b(?:lose|losing|drop|dropping|shed|shedding)\s+(?:about |around |like |another )?\d{1,3}(?:\.\d+)?\s*(?:lbs?|pounds?|kgs?|kilos?|kilograms?)\b/],
  ["gain_muscle", /\b(build|building|gain|gaining|add|adding|pack(?:ing)? on)\s*(?:some\s*)?(?:lean\s*)?muscle\b/],
  ["maintain", /\bmaintain\b|\bkeep what i have\b|\bkeep my weight\b|\bstay (?:the same|where i am)\b/],
];

function extractGoal(norm: string, out: FastPathFacts): void {
  for (const [goal, pattern] of GOAL_PATTERNS) {
    if (firstUnnegatedMatch(norm, pattern)) {
      out.goal = goal;
      out.confidence.goal = HIGH_CONFIDENCE;
      return;
    }
  }
}

// ---- Sex ----------------------------------------------------------------------------------

/** An explicit decline is its own anchor too (coordinator scope addition, 2026-10-06): the
 *  model-extraction prompt accepts the same "unspecified" value, so a user who says they'd
 *  rather not answer gets the midpoint BMR term instead of a dropped field that asks again.
 *  Checked only AFTER an explicit sex word (below): Sol r2 WARN caught "I am male; prefer not
 *  to say my weight" being overridden to "unspecified" by a decline that was about weight, not
 *  sex — an explicit, unambiguous sex word always wins over an unanchored decline phrase. */
const SEX_DECLINE_PATTERNS: readonly RegExp[] = [
  /\bprefer not to say\b/, /\brather not say\b/, /\bi'?d rather not (?:say|answer)\b/,
  /\bskip (?:that|this) one\b/, /\bnot (?:going to|gonna) say\b/,
];

/** An explicit word is its own anchor: HIGH, same as goal. No bare-number equivalent exists for
 *  sex, so there is no GHOST case here — it either matched a word or it didn't match at all. */
const SEX_PATTERNS: readonly ["male" | "female", RegExp][] = [
  ["male", /\b(male|man|guy)\b/],
  ["female", /\b(female|woman|girl)\b/],
];

function extractSex(norm: string, out: FastPathFacts): void {
  for (const [sex, pattern] of SEX_PATTERNS) {
    if (firstUnnegatedMatch(norm, pattern)) {
      out.sex = sex;
      out.confidence.sex = HIGH_CONFIDENCE;
      return;
    }
  }
  if (SEX_DECLINE_PATTERNS.some((pattern) => pattern.test(norm))) {
    out.sex = "unspecified";
    out.confidence.sex = HIGH_CONFIDENCE;
  }
}

// ---- Activity / cooking effort (optional fields; BRIEF.md §2) -------------------------------

/** "light"/"moderate" must be checked BEFORE the bare "active" pattern (Sol r1 WARN: "lightly
 *  active" and "moderately active" both contain the substring "active" and were being read as
 *  the generic `active` level before this file's own, more specific entries ever ran). */
const ACTIVITY_PATTERNS: readonly [(typeof ONBOARDING_ACTIVITIES)[number], RegExp][] = [
  ["sedentary", /\bsedentary\b|\bmostly sitting\b|\bdesk job\b/],
  ["very_active", /\bvery active\b|\btrain(?:ing)? (?:hard|a lot|twice a day)\b/],
  ["light", /\blight(?:ly)? active\b|\bsome days\b/],
  ["moderate", /\bmoderate(?:ly)? active\b/],
  ["active", /\bactive\b|\bon my feet\b/],
];

function extractActivity(norm: string, out: FastPathFacts): void {
  for (const [activity, pattern] of ACTIVITY_PATTERNS) {
    if (pattern.test(norm)) {
      out.activity = activity;
      out.confidence.activity = GHOST_CONFIDENCE;
      return;
    }
  }
}

const COOKING_PATTERNS: readonly [(typeof ONBOARDING_COOKING_EFFORTS)[number], RegExp][] = [
  ["none", /\b(don'?t|do not|never|can'?t|cannot) cook\b|\bno cooking\b/],
  ["full", /\blove (?:to )?cook\b|\bcook (?:a lot|every ?day|from scratch)\b/],
  ["minimal", /\bquick (?:cooking|meals?)\b|\bsimple cooking\b|\bminimal cooking\b/],
];

function extractCookingEffort(norm: string, out: FastPathFacts): void {
  for (const [effort, pattern] of COOKING_PATTERNS) {
    if (pattern.test(norm)) {
      out.cookingEffort = effort;
      out.confidence.cookingEffort = GHOST_CONFIDENCE;
      return;
    }
  }
}

/**
 * The fast path's one entry point: parses `text` for whichever onboarding fields it can find,
 * each with its own confidence band. Returns `{ confidence: {} }` (no fields) for text it reads
 * nothing out of — never throws, never guesses a field it found no anchor for.
 */
export function extractFastPath(text: string, now: Date = new Date()): FastPathFacts {
  if (typeof text !== "string" || text.trim().length === 0) return emptyResult();
  const full = normalize(text);
  const out = emptyResult();
  // Onboarding v2 G4: the plan answers first, then the body readers on the text with every pace,
  // goal-weight and change amount struck ("lose 30 pounds" is never the current weight).
  const plan = extractPlanFastPath(full);
  const { confidence: planConfidence, ...planFacts } = plan;
  Object.assign(out, planFacts);
  Object.assign(out.confidence, planConfidence);
  const norm = withoutPlanSpans(full);
  extractHeight(norm, out);
  extractWeight(norm, out);
  extractBirthYear(norm, now, out);
  extractGoal(full, out);
  extractSex(full, out);
  extractActivity(full, out);
  extractCookingEffort(full, out);
  return out;
}

/**
 * Standing privacy rule (tests/ai/no-demographics-payload.test.ts): no AI payload ever carries
 * sex or birth year/age. Those two fields are extracted ONLY by this module's own regexes
 * (above) — never by the one bounded model call. This function is the other half of that rule:
 * it strips every span THIS module's own age/sex patterns would recognize from `text` BEFORE the
 * model ever sees it (lib/server/onboarding-extract.ts calls this unconditionally, not only when
 * a caller remembers to), reusing the exact same patterns so the redaction can never drift from
 * what the fast path actually reads as age or sex. A struck span becomes one space, not nothing,
 * so words on either side of it don't glue together; repeated whitespace collapses at the end.
 *
 * Not exhaustive prose-rewriting — a sentence that still, after this, reads oddly is expected
 * and fine (the model only extracts goal/activity/cookingEffort/dietFlags from what is left); the
 * guarantee is narrower and absolute: none of THIS module's own age or sex anchors survive.
 */
const REDACT_PATTERNS: readonly RegExp[] = [
  AGE_WITH_UNIT, BORN_YEAR, BARE_YEAR, BARE_AGE,
  ...SEX_PATTERNS.map(([, pattern]) => pattern),
  ...SEX_DECLINE_PATTERNS,
];

export function redactAgeAndSex(text: string): string {
  if (typeof text !== "string") return "";
  let out = text;
  for (const pattern of REDACT_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags.includes("i") ? flags : `${flags}i`);
    out = out.replace(global, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** A string that could leak demographic content back into `dietFlags` were it ever accepted:
 *  a digit (an age, a year), or one of this module's own sex words. */
const LEAKY_DIET_FLAG = new RegExp(
  `\\d|${[...SEX_PATTERNS.map(([, pattern]) => pattern.source), ...SEX_DECLINE_PATTERNS.map((p) => p.source)]
    .join("|")}`,
  "i",
);

/**
 * Defense in depth on the OTHER direction from `redactAgeAndSex` (Sol privacy-round WARN): the
 * model's reply schema has no sex/birthYear fields to set, but `dietFlags` is free-form text the
 * model writes itself, and a hallucinated or confused reply could still echo an age or a sex
 * word into one of its entries. Drops (never rewrites) any flag that matches — a diet flag is
 * always a short, clean food word, so dropping an unexpectedly age/sex-shaped one costs nothing
 * a real flag would have needed. Called on every model reply before it is returned to the
 * caller (lib/server/onboarding-extract.ts).
 */
export function sanitizeDietFlags(flags: readonly string[] | undefined): string[] | undefined {
  if (flags === undefined) return undefined;
  const cleaned = flags.filter((flag) => !LEAKY_DIET_FLAG.test(flag));
  return cleaned.length > 0 ? cleaned : undefined;
}
