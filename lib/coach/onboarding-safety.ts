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
import { PROFILE_SYNONYMS } from "@/lib/coach/profile-synonyms.generated";

/**
 * Onboarding v2 G14: medicine names the word list above missed ("Ozempic", "Wegovy",
 * "semaglutide", …). Every brand and generic name of the offered `medication_interaction`
 * profiles (docs/research/dietary-profiles.draft.json, through the generated synonym snapshot),
 * plus the common U.S. weight-loss and diabetes medicines those profiles do not list. Matched as
 * whole words, so a name inside another word never trips it.
 */
const MEDICATION_PROFILE_IDS: ReadonlySet<string> = new Set([
  "insulin_or_sulfonylurea", "hypothyroid_levothyroxine", "glp1_medication", "warfarin", "maoi",
  "linezolid", "statin_grapefruit", "immunosuppressant_grapefruit", "lithium",
  "antibiotic_mineral_binding", "bisphosphonate", "ace_arb_spironolactone", "sglt2_inhibitor",
  "disulfiram", "metronidazole",
]);

export const US_MEDICINE_NAMES: readonly string[] = [
  // GLP-1 and GIP/GLP-1 medicines, brand and generic.
  "ozempic", "wegovy", "rybelsus", "mounjaro", "zepbound", "semaglutide", "tirzepatide",
  "liraglutide", "victoza", "saxenda", "dulaglutide", "trulicity", "exenatide", "byetta",
  "bydureon", "lixisenatide", "retatrutide", "compounded semaglutide",
  // Other prescription weight-loss medicines.
  "phentermine", "adipex", "qsymia", "contrave", "naltrexone", "bupropion", "orlistat", "xenical",
  "alli", "plenity", "setmelanotide", "imcivree",
  // Diabetes medicines beyond the profiles' own list.
  "januvia", "sitagliptin", "glucophage", "jentadueto", "janumet", "pioglitazone", "actos",
  "steglatro", "ertugliflozin", "canagliflozin",
  // Common U.S. prescriptions people name when they explain a food rule.
  "accutane", "isotretinoin", "xanax", "alprazolam", "lipitor", "crestor", "rosuvastatin",
  "adderall", "ritalin", "vyvanse", "zoloft", "sertraline", "prozac", "fluoxetine", "lexapro",
  "escitalopram", "wellbutrin", "eliquis", "xarelto", "plavix", "clopidogrel", "omeprazole",
  "prilosec", "nexium", "pantoprazole", "gabapentin", "topiramate", "topamax", "lamotrigine",
  "depakote", "seroquel", "abilify", "levothyroxine", "prednisone", "methotrexate", "humira",
];

const WEIGHT_LOSS_SHOT = /\b(?:weight[- ]loss|diet|skinny|fat[- ]loss)\s+(?:shots?|jabs?|injections?|pens?|drugs?|pills?|meds?)\b|\bglp[\s-]?1s?\b/;

function escapeWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MEDICINE_WORDS: RegExp = (() => {
  const names = new Set<string>(US_MEDICINE_NAMES);
  for (const { id, synonyms } of PROFILE_SYNONYMS) {
    if (!MEDICATION_PROFILE_IDS.has(id)) continue;
    for (const synonym of synonyms) names.add(synonym.toLowerCase().replace(/[’‘]/g, "'"));
  }
  const alternatives = [...names].filter((name) => name.trim().length >= 3)
    .sort((a, b) => b.length - a.length).map(escapeWord);
  return new RegExp(`(?<![a-z0-9])(?:${alternatives.join("|")})(?![a-z0-9])`);
})();

/** True when the text names a medicine the opener must never send to a model (G14). */
export function namesMedicine(text: string): boolean {
  const normalized = String(text).toLowerCase().replace(/[’‘]/g, "'");
  return WEIGHT_LOSS_SHOT.test(normalized) || MEDICINE_WORDS.test(normalized);
}

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

/**
 * Onboarding v2 G14 replay (the W5b keep-local corpus, tests/fixtures/taste-safety-*.ts|json, run
 * through this opener): body effects and care words the two lists above missed. Over-matching is
 * the safe error here: a blocked opener only shows the tap-only safety card and asks plainly.
 * Diet practices ("I'm vegan", "I keep kosher", "I do keto") stay readable on purpose: the model
 * may only suggest diet-hint chips the user confirms (`onboardingModelFactsSchema`).
 */
const REPLAY_PATTERNS: readonly RegExp[] = [
  // Body effects.
  /\b(?:doesn'?t|don'?t|does not|do not|never)\s+(?:agree|sit (?:right|well))\b|\bsits? (?:right|well) with me\b/,
  /\bupsets? my (?:stomach|tummy|gut|belly)\b|\bupset stomach\b/,
  /\bheartburn\b|\breflux\b|\bindigestion\b|\bulcers?\b|\bgerd\b/,
  /\bitch(?:y|es|ing)?\b|\btingl\w*\b|\bhives\b|\beczema\b|\bbreak(?:s)? out\b|\bswell\w*\b/,
  /\b(?:feel|feels|felt|feeling|get|gets|got|getting)\s+(?:really\s+|so\s+|very\s+|kind of\s+)?(?:sick|ill|queasy|awful|dizzy|jittery|sleepy|nauseous)\b/,
  /\bqueasy\b|\bnauseous\b|\bjittery\b|\bconstipat\w*\b|\bgassy\b|\b(?:gives?|gave)\s+me\s+(?:\w+\s+)?gas\b/,
  /\bthr(?:ow|ows|ew|owing)\s+up\b|\bgag\b|\bfood poisoning\b|\bpalpitations?\b/,
  /\bbloat\w*\b|\b(?:energy|sugar)\s+crash\w*\b|\bcrash(?:es)? my energy\b/,
  /\b(?:cause|causes|caused|have|get)\s+a reaction\b|\breactions?\b|\breact(?:s|ed)?\s+badly\b/,
  /\bburns? my (?:tongue|mouth|throat)\b|\b(?:belly|stomach|tummy|gut|chest|joint)\s+pain\b|\bpain in my\b/,
  /\bmy (?:gut|stomach|tummy|belly|bowels?)\b|\bgi issues?\b/,
  /🤢|🤮/u,
  // Care, treatment and procedures.
  /\bsurger(?:y|ies)\b|\bsurgical\b|\bpost-?op\b|\bmy op\b|\bbariatric\b|\bgastric (?:sleeve|bypass)\b/,
  /\bfeeding tube\b|\bclinic\b|\bthe er\b|\bemergency room\b|\bspecialist\b/,
  /\b(?:gastroenterologist|cardiologist|endocrinologist|nephrologist|oncologist|allergist|gastro|gp)\b/,
  /\bblood pressure\b|\bblood thinners?\b|\bantibiotics?\b|\bsulf?phites?\b|\bsulfites?\b/,
  // A rule or condition named without saying which.
  /\bhealth reasons?\b|\bmedical(?:ly)?\b|\ba condition\b|\bspecial diet\b|\bdietary restrictions?\b/,
  /\bissues? with (?:certain )?foods?\b|\bbad for me\b|\bhave to avoid\b|\bcan'?t be around\b/,
  /\bsend(?:s)? me to\b|\bfor my (?:son|daughter|kid|kids|child|children|baby)\b/,
  // A food that hurts, said as an idiom.
  /\bdoes a number on me\b|\bbackfires? on me\b|\brepeats on me\b|\brough on (?:me|my)\b|\bhard on my\b/,
  /\bregret it\b|\bpay(?:ing)? for (?:it|that)\b|\bgoes wrong\b|\bflare\w*\b|\brejects?\b/,
  /\bwrecks? (?:me|my)\b|\bdestroys me\b|\bkills? me\b|\bpoison\b|\bdangerous\b|\bhates me\b/,
  /\bnot friends\b|\bdon'?t get along\b|\bisn'?t my friend\b|\bcan'?t handle\b/,
  // Pregnancy and nursing words the condition list does not name.
  /\bexpecting\b|\bmorning sickness\b|\bnursing\b|\bconceiv\w*\b|\bttc\b|\btrimester\b|\bpostpartum\b/,
  // Eating-disorder signals, never read as a goal.
  /\bbinge\w*\b|\bpurg\w*\b|\brestrict(?:ing)? my eating\b|\bed (?:recovery|treatment)\b/,
  /\bskip meals\b[^.?!]{0,20}\bon purpose\b|\bscared of eating\b|\bobsessive\w*\b|\bpanic\w*\b/,
  /\bguilty\b|\bfood rules\b|\bunder \d{3,4} (?:calories|kcal|cals?)\b/,
  // Conditions and care in short forms and common misspellings.
  /\bt[12]d\b|\btype [12]\b|\bobes(?:e|ity)\b|\bfor my health\b|\bhealth-?wise\b|\bbp\b|\brx\b|\bdoc\b/,
  /\blow[- ]sodium\b|\bsodium\b|\bfodmap\b|\bceliac|\bdiar+h?e?a|\bstomache\b|\bglut[oi]n\b|\bnausi\w*|\bbloted\b/,
  /\bdr\b|\bmy body set\b|\bgi\b|\bdigestive\b|\bmy body (?:has|hates|rejects|and)\b|\bfor my body\b|\bin recovery\b|\baddiction\b|\brehab\b/,
  // "I have a dairy thing", "nuts are an issue for me": a rule said without naming it.
  /\b(?:have|has|there'?s|there is)\s+(?:a|an|some)\s+(?:little\s+|whole\s+|underlying\s+|special\s+)?(?:\w+\s+)?(?:thing|thng|stuff|issue|problem|situation|deal|ordeal|complication|predicament|circumstance|hassle)\b/,
  /\b(?:is|are)\s+(?:a|an|my)\s+(?:whole\s+|special\s+|sore\s+|real\s+)?(?:\w+\s+)?(?:thing|issue|problem|situation|ordeal|complication|circumstance|hassle|subject)\b/,
  /\b(?:thing|stuff|situation|issue|problem|deal|ordeal) (?:with|about|going on)\b|\bhave a deal\b/,
  /\bkryptonite\b|\bnemesis\b|\benemy\b|\bdownfall\b|\bat war\b|\bvillain\b|\bred flag\b|\bforbidden\b|\bfor safety\b|\bachilles\b/,
  /\bcertain (?:things|foods)\b|\bcomplicated with food\b|\bmy eating\b|\bnot lately\b/,
  /\bmy (?:kid|kids|son|daughter|child|toddler|niece|nephew|baby)\s+(?:has|is|can'?t|gets)\b/,
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
  if (classifyMedical(value).deflect || namesMedicine(value)) return { blocked: true, reason: "medical" };
  const normalized = value.toLowerCase();
  if (ALLERGY_OR_CONDITION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { blocked: true, reason: "allergy_or_condition" };
  }
  if (SYMPTOM_PATTERNS.some((pattern) => pattern.test(normalized))
    || REPLAY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { blocked: true, reason: "symptom" };
  }
  return { blocked: false };
}
