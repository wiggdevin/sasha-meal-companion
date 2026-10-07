/**
 * Onboarding v2 (BRIEF.md §3 "Local safety filter", §5 "classifyMedical / W5b fixed-corpus
 * filter"): the local check that runs BEFORE either extraction path (the regex fast path or the
 * one bounded model call) sees a byte of the user's text. A match here means zero model calls,
 * full stop — the model extraction call (lib/server/onboarding-extract.ts) refuses to even build
 * a payload for text this rejects.
 *
 * Reuses lib/coach/deflect.ts's `classifyMedical` outright: it is already the deterministic,
 * zero-model medical-question filter the rest of the coach runs ahead of every model call, and
 * it is well scoped (diagnosis, medication, dosage, clinical tests, referral — not ordinary
 * fitness words).
 *
 * It does NOT reuse Phase 18 W5b's `tasteTextRoute` (lib/profile/taste-safety.ts) wholesale: that
 * check's RULE_PATTERNS are deliberately broad (it also matches "weight", "only", "never",
 * "diet", every quantifier a free-text preference box might need to route to a human-reviewed
 * rule editor) and would reject nearly every ordinary onboarding-opener sentence outright
 * ("I want to lose weight" already contains "weight") — exactly the sentences this opener exists
 * to read. The allergy/condition patterns below are a separate, intentionally NARROWER list:
 * specific conditions, allergens and clinician/medication words, not general diet vocabulary.
 * The existing dietary free-text box keeps using the broader W5b check unchanged; this module
 * does not touch it.
 *
 * Pure. No I/O, no model call.
 */
import { classifyMedical } from "@/lib/coach/deflect";

/** A named condition, allergen reaction or clinician/medication word — narrow on purpose (see
 *  file header): this must never fire on "I want to lose weight" or "I'm trying to build
 *  muscle, mostly sitting at a desk job." */
const ALLERGY_OR_CONDITION_PATTERNS: readonly RegExp[] = [
  /allerg/, /anaphyla/, /epi-?pens?\b/, /intoleran/, /\bceliac\b|\bcoeliac\b/,
  /\bibs\b|\bibd\b|\bcrohn/, /\bcolitis\b|\bgerd\b|\bgout\b/,
  /diabet|\ba1c\b|\bblood sugar\b/,
  /cholesterol|hypertens|\bcardiac\b|\bkidney\b|\brenal\b|dialysis|hepat|cirrhos/,
  /\bcancer\b|\bchemo\b|\btumou?r\b/,
  /epilep|seizure|\basthma\b|psoria|autoimmun|\blupus\b|thyroid/,
  /pregnan|breast-? ?feed/,
  /\beating disorder\b|anorexi|bulimi|\barfid\b/,
  /\bdoctors?\b|\bdr\.\s|physician|dietitian|nutritionist|\bclinician\b|\bhospital\b/,
  /\bprescri\w*\b|\bmedications?\b|\bmedicine\b|\bmeds\b|\binsulin\b|\bmetformin\b|\bwarfarin\b|\bstatins?\b/,
];

/** A body effect or symptom, with no condition named — narrow on purpose: clear clinical
 *  language only, not words ("tired", "energy", "sore") that also describe an ordinary workout.
 *  Sol r1 BLOCK 1 added "I have migraines" and "dairy makes my stomach hurt" as misses: the
 *  first needed a direct symptom word (migraine/headache), the second needed the general
 *  cause-and-effect construction ("X makes/gives me Y") a food-safety statement like that uses,
 *  not only a fixed list of named symptoms. Sol r2 BLOCK 1 added "peanuts make my throat close"
 *  (an anaphylaxis description with no word from the r1 list at all) as a further miss: the
 *  body-effect word list the cause-and-effect construction checks against now also covers
 *  airway/throat words, not only digestive/skin ones. */
const SYMPTOM_PATTERNS: readonly RegExp[] = [
  /\bvomit/, /\bnause/, /\bdiarrh/, /\brash\b/, /\bhives\b/, /\bswelling\b|\bswollen\b/,
  /\bseizure\b/, /\bfaint(?:ed|ing)?\b/, /\bchest pain\b/, /\bblood in (?:my )?(?:stool|urine)\b/,
  /\brectal bleeding\b/, /\banaphylaxis\b/, /\banaphylactic\b/, /\bmigraines?\b/, /\bheadaches?\b/,
  /\bstomach\s*(?:ache|aches|hurts?|pain|cramps?)\b/, /\bcramp(?:s|ing)?\b/, /\bbloat(?:ed|ing)?\b/,
  /\bthroat\s+(?:close|closes|closing|closed|tighten\w*|swell\w*)\b/,
  /\bcan'?t breathe\b|\btrouble breathing\b|\bepi-?pens?\b/,
  // Cause-and-effect: "<food> makes/gives me <body effect>" — the construction a safety-relevant
  // statement about a food uses, independent of which specific symptom word follows. The
  // body-effect list spans digestive, skin AND airway words (r2: "make my throat close" was a
  // miss when this list was digestive/skin only).
  /\b(?:makes?|made|making|gives?|gave|giving)\s+(?:me|my\s+\w+)\b[^.?!]{0,25}\b(?:hurts?|aches?|ache|sick|nause\w*|bloat\w*|gassy|cramp\w*|pain\w*|itchy|dizzy|numb|swell\w*|close\w*|tighten\w*|choke\w*)\b/,
];

export type OnboardingSafetyVerdict =
  | { blocked: true; reason: "medical" | "allergy_or_condition" | "symptom" }
  | { blocked: false };

/**
 * The guard the extraction call (and the regex fast path's caller) must run first. A `blocked`
 * verdict means: stop, never build a model payload from this text, surface the existing
 * allergy/condition card or rule editor instead (BRIEF.md §3/§4) — never a model's judgment call.
 */
export function onboardingSafetyCheck(text: string): OnboardingSafetyVerdict {
  const value = typeof text === "string" ? text : "";
  if (classifyMedical(value).deflect) return { blocked: true, reason: "medical" };
  const normalized = value.toLowerCase();
  if (ALLERGY_OR_CONDITION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { blocked: true, reason: "allergy_or_condition" };
  }
  if (SYMPTOM_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { blocked: true, reason: "symptom" };
  }
  return { blocked: false };
}
