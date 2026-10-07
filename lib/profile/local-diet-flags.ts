/**
 * The phone's own suggester for the onboarding dietary text that the taste safety check keeps local
 * (Phase 18 W5b, Sol r5, r6): "Vegetarian", "No shellfish", "I only do quick cooking" are rule text,
 * so they are never sent to Jev or any model — but the field still suggests the flags main's Jev
 * classifier would. Keywords map onto the field's EXISTING vocabulary only: the 12 PREFERENCE_FLAGS
 * and the cooking-effort choice.
 *
 * - Symptom or medical text ANYWHERE (a condition, a medicine, a clinician, a body effect — "I avoid
 *   eggs because they make me nauseous") yields nothing; the field offers the rule editor instead.
 * - An exclusion flag is suggested only where the exclusion word directly governs that food in the
 *   same clause ("no X", "without X", "X-free", "allergic to X", "avoid X", "can't have X", "skip X").
 *   Clauses split on ; , . and "but", "and", "though", "however", "except". A positive statement
 *   ("I eat eggs", "I love dairy") never produces an exclusion.
 *
 * Deterministic. No Jev, no network. Pure.
 */
import type { PreferenceFlag } from "@/lib/profile/onboarding-state";
import { mentionsSymptom, normalizeTasteText } from "@/lib/profile/taste-safety";

export type CookingEffortChoice = "none" | "minimal" | "full";
export type LocalDietSuggestion = { flags: Partial<Record<PreferenceFlag, number>>; cookingEffort: CookingEffortChoice | null };

/** A condition, medicine, clinician or medical process: no flag is suggested from such text. */
const MEDICAL = /disease|disorder|syndrome|\bibs\b|\bibd\b|crohn|colitis|celiac|coeliac|diabet|\bdoctors?\b|\bdr\b|physician|dietit|nutritionist|medic|\bmeds\b|\bpills?\b|insulin|warfarin|statin|pregnan|cancer|chemo|kidney|renal|\bgout\b|cholesterol|blood|hypertens|surger|eating disorder|anorexi|bulimi|epilep|thyroid|diagnos|condition|prescri|hospital|therap|nause|vomit|sick|reaction|react|rash|hives|swell|cramp|bloat|pain|ache|stomach|tummy|gut|reflux|heartburn|diarrh|constipat/;

/** The food words each exclusion flag covers. */
const FOODS: readonly [PreferenceFlag, string][] = [
  ["no_pork", "pork|bacon|ham|prosciutto|pig"],
  ["no_beef", "beef|steak|veal"],
  ["no_shellfish", "shellfish|shrimps?|prawns?|crabs?|lobsters?|scallops?|clams?|mussels?|oysters?"],
  ["no_eggs", "eggs?"],
  ["no_soy", "soya?|tofu|edamame|tempeh"],
  ["no_peanuts", "peanuts?"],
];

/** Exclusion words that govern the food right after them ("no shellfish", "can't have pork"). */
const BEFORE = "(?:no|without|avoid|avoiding|avoids|skip|skipping|exclude|excluding|allergic to|allergy to|intolerant to|"
  + "can'?t (?:eat|have|do|touch)|cannot (?:eat|have)|can not (?:eat|have)|don'?t (?:eat|have)|do not (?:eat|have)|"
  + "won'?t (?:eat|have)|never (?:eat|have)|not eating|stay away from|staying away from|cut out|cutting out)";

function governed(clause: string, foods: string): boolean {
  const food = `(?:${foods})`;
  const list = `(?:(?:any|the|a|an) )?(?:[a-z'-]+ or )*${food}\\b`;
  return new RegExp(`\\b${BEFORE} ${list}`).test(clause)
    // "Egg-free" states a practice only on its own ("egg-free", "egg-free diet", "I'm egg-free"), never
    // as a description of a food ("I love egg-free cake"), and never in a clause that enjoys something.
    || (!ENJOYS.test(clause)
      && new RegExp(`\\b${food} ?-?free(?:$| (?:diet|lifestyle|please|only|for me|household)\\b)`).test(clause))
    || new RegExp(`\\b${food} (?:allerg(?:y|ies)|intoleran(?:ce|t))\\b`).test(clause);
}

const PRACTICES: readonly [PreferenceFlag, RegExp][] = [
  ["vegan", /\bvegan\b|plant-? ?based|no animal products/],
  ["vegetarian", /\bvegetarian\b|\bveggie\b(?! burgers?)|\b(no|without) meat\b|\bdon'?t eat meat\b|\bmeat-? ?free\b|\bmeatless\b/],
  ["pescatarian", /\bpesc[ae]tarian\b|\bonly (eat )?fish\b|\bfish but no (other )?meat\b|\bno meat (except|but) fish\b/],
  ["low_fodmap", /\blow[- ]?fodmap\b/],
  ["halal", /\bhalal\b/],
  ["kosher", /\bkosher\b/],
];

const CLAUSE_BREAK = /[;,.!?]|\b(?:but|and|though|however|except|although|while)\b/;
/** A clause that only enjoys a food or a cuisine ("I love vegan food") states no practice. */
const ENJOYS = /\b(love|loves|like|likes|enjoy|enjoys|prefer|prefers|adore)\b/;

function cookingEffort(text: string): CookingEffortChoice | null {
  if (/\b(no|zero) cook(ing)?\b|\b(don'?t|can'?t|won'?t|never|do not) cook\b|\bno time to cook\b|\bwithout cooking\b/.test(text)) return "none";
  if (/\b(quick|easy|simple|fast|minimal|little|light)\b.{0,20}\bcook|\b(quick|easy|simple|fast)( and (quick|easy|simple|fast))? (meals?|food|recipes?)\b|\b(10|15|20)[- ]?min(ute)?s?\b/.test(text)) return "minimal";
  if (/\b(love|like|enjoy|happy|willing|glad) to cook\b|\bcook (from scratch|full meals)\b|\bcook every (day|night)\b/.test(text)) return "full";
  return null;
}

/** The flags (probability 1) and cooking effort the text states, or none for medical or symptom text. */
export function localDietSuggestion(raw: string, kept: "rules" | "symptom" | "unsure"): LocalDietSuggestion {
  const text = normalizeTasteText(raw);
  // Symptom or medical anywhere wins over every clause.
  if (kept === "symptom" || mentionsSymptom(text) || MEDICAL.test(text)) return { flags: {}, cookingEffort: null };
  const flags: Partial<Record<PreferenceFlag, number>> = {};
  // "No meat except fish" spans the clause break it names.
  if (/\bno meat (except|but) fish\b/.test(text)) flags.pescatarian = 1;
  for (const clause of text.split(CLAUSE_BREAK).map((part) => (part ?? "").trim()).filter(Boolean)) {
    for (const [flag, pattern] of PRACTICES) if (pattern.test(clause) && !ENJOYS.test(clause)) flags[flag] = 1;
    for (const [flag, foods] of FOODS) if (governed(clause, foods)) flags[flag] = 1;
  }
  return { flags, cookingEffort: cookingEffort(text) };
}
