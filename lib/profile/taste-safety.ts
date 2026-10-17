/**
 * The conservative local safety-language check for the free taste text (Phase 18 D9 item 3, slice
 * W5b). It runs in code, before anything else, on the phone and again on the server, and decides
 * whether the text may be sent to Jev or any model:
 *
 *   rules    an allergen, a condition, a medicine, a clinician or a rule (a diet practice)
 *   symptom  a body effect or a symptom, even with no condition named, or a cause-and-effect form
 *            ("makes me", "gives me", "I get … after", "doesn't agree with me")
 *   unsure   more than 200 characters, a word the check does not know, a negation it cannot parse,
 *            or a change over time ("I can't do X anymore")
 *
 * Any of those keeps the text local: it is never sent to Jev or any model (the dietary field's raw
 * text is still saved to the user's own account, `diet_prefs.text`, as on main), and the phone offers the
 * rule editor (rules, symptom) or asks for plain likes and dislikes (unsure). Only plain likes,
 * dislikes and cuisine statements built from known words are `send`.
 *
 * It is biased to local on purpose: a mistake may only keep plain text local, never send health
 * text out. The zero-send corpus is tests/fixtures/taste-safety-corpus.ts.
 *
 * Pure. No I/O, no model call; safe to import on the phone.
 */
import { isCoachCommand } from "@/lib/profile/coach-commands";
import { TASTE_WORDS } from "@/lib/profile/taste-words";

export type TasteLocalReason = "rules" | "symptom" | "unsure";
export type TasteRoute = { route: "send" } | { route: "local"; reason: TasteLocalReason };

/** D9: text past this many characters is kept local unread. */
export const TASTE_TEXT_MAX = 200;

const LOCAL = (reason: TasteLocalReason): TasteRoute => ({ route: "local", reason });

/** Allergens, conditions, medicines, clinicians and rules (diet practices and religious food rules). */
const RULE_PATTERNS: readonly RegExp[] = [
  /allerg/, /anaphyla/, /epi-?pens?\b/, /intoleran/, /sensitiv/, /celiac|coeliac/, /gluten/, /lactose/,
  /casein/, /fodmap/, /histamine/, /tyramine/, /sulph?ite/, /oxalate/, /purine/, /potassium/, /phosph/,
  /sodium/, /\bkosher\b/, /\bhalal\b/, /\bharam\b/, /\btre[iy]f/, /\bvegan/, /vegetarian/, /pesc[ae]tarian/,
  /plant-? ?based/, /\bketo/, /\bpaleo\b/, /whole ?30/, /carnivore/, /\bdiet/, /religio/, /\bjewish\b/,
  /\bmuslim/, /\bislam/, /\bhindu/, /\bjain/, /buddhis/, /\bsikh/, /\bcatholic/, /\blent\b/, /ramadan/,
  /passover/, /\bfasting\b/, /\bfast(s|ed)?\b(?! food)/, /sabbath|shabbat/, /\bdoctors?\b/, /\bdr\b/,
  /physician/, /dietit|dietic/, /nutritionist/, /\bgastro/, /cardiolog/, /\bnurses?\b/, /clinic/,
  /hospital/, /prescri/, /medic/, /\bmeds\b/, /\bpills?\b/, /tablets?\b/, /\bdrugs?\b/, /insulin/,
  /metformin/, /warfarin|coumadin/, /statin/, /thinners?\b/, /\bmaois?\b/, /\bssris?\b/, /antibiotic/,
  /supplement/, /therap/, /treatment/, /surger/, /operation/, /bariatric/, /gastric/, /diagnos/,
  /condition/, /disease/, /disorder/, /syndrome/, /\bibs\b/, /\bibd\b/, /crohn/, /colitis/, /\bgerd\b/,
  /\bgout/, /\bkidneys?\b(?!\s+beans?)/, /\brenal\b/, /dialysis/, /hepat/, /cirrhos/, /diabet/, /\ba1c\b/,
  /glucose/, /blood/, /hypertens/, /cholesterol/, /triglycer/, /cardiac/, /pregnan/, /breast-? ?feed/,
  /lactat/, /cancer/, /chemo/, /tumou?r/, /\bpku\b/, /phenylketon/, /epilep/, /seizure/, /eczema/,
  /asthma/, /psoria/, /autoimmun/, /lupus/, /thyroid/, /hashimoto/, /an(a)?emi/, /deficien/, /anorexi/,
  /bulimi/, /\bbinge/, /\bpurg/, /\barfid\b/, /\bavoid/, /allowed/, /forbid/, /\bbann/, /restrict/,
  /\brules?\b/, /\bstrict/, /\bmust\b/, /\bhave to\b/, /\bhas to\b/, /supposed to/, /\bshould(n'?t)?\b/,
  /\b(can'?t|cannot|can not|won'?t|don'?t|do not|never) (eat|have|touch|digest|tolerate|process)\b/,
  /stay away/, /\bcut (out|back)/, /\bg(a|i)ve up\b/, /giving up/, /\bfree\b/,
  /\blow[- ](carb|fat|sodium|salt|sugar|fodmap|residue|fib(er|re)|protein|purine|oxalate|histamine)/,
  /\bweight\b/, /\balcohol/, /\bsober/, /recover/, /addict/,
  // Sol r1 BLOCK 1: any statement that restricts what the person eats or drinks is a rule
  // ("I only eat fish", "I always have it plain", "I stopped drinking milk"), whatever it names.
  /\b(only|just|mostly|mainly|primarily|largely|usually|typically|never|always|must|mustn'?t|can'?t|cannot|can not|won'?t|wont|don'?t|dont|do not|doesn'?t|didn'?t|no longer|avoid(s|ing)?|stay(ing)? away|cut(ting)? out|give up|gave up|giving up|quit|stopp?(ed|ing)?|limit(ed|ing)?|exclusively|strictly|except)\b[\w\s',-]{0,30}?\b(eat|eats|eating|ate|drink|drinks|drinking|drank|have|has|having|had|touch|consume|consuming|take|taking|allow|allowed)\b/,
  /\b(only|exclusively|except|nothing but|solely|no|without|limit(s|ed|ing)?|cut(ting)? (down|back))\b/,
  // "chicken is the one meat I eat", "beans and rice make up most meals" (red-team round 3).
  /\bthe (one|single|lone|sole)\b/, /\bmakes? up (most|all|the bulk|nearly all|almost all)\b/,
  /\bmost (nights|days|meals|mornings|evenings|dinners|lunches|breakfasts|of the time|weeks)\b/,
  /\bskipp?(ing|ed|s)?\b/, /\bcarbs?\b/, /\bdry\b/,
  // Named diets and practices, and the "<x>-free" and "low-<x>" forms of any of them.
  /\b(flexitarian|lacto|ovo|pollo|macrobiotic|atkins|dash|south beach|zone diet|raw food|raw vegan|fruitarian|aip|gaps|scd|elimination|detox|cleanse|juice fast|omad|intermittent|meatless|teetotal|abstain|abstinent|navratri|ekadashi|yom kippur|kashrut|treyf|jain)\b/,
  /\w-free\b/, /\blow[- ]?\w+/, /\bhigh[- ](protein|fib(er|re)|fat|calorie)/, /\b(calorie|calories|kcal|macros|carbs? count)/,
  /\b(bulk|bulking|cutting|shred|shredding)\b/
];

/** A body effect or symptom, or a cause-and-effect form, with or without a condition named. */
const SYMPTOM_PATTERNS: readonly RegExp[] = [
  /vomit/, /\bthr(ow|ew|owing|ows) up\b/, /\bpuk/, /nause/, /queas/, /\bsick/, /\bill\b/, /unwell/,
  /cramp/, /bloat/, /\bgas\b|gassy/, /\bfart/, /flatul/, /\bburp/, /belch/, /\brash/, /\bhives?\b/,
  /itch/, /swell|swollen/, /inflam/, /\bpain/, /\b(ache|aches|aching|ached)\b/, /\bhurt/, /\bsore\b/,
  /reflux/, /heartburn/, /indigest/, /\bacid(ic|ity)?\b/, /ulcer/, /diarrh/, /constipat/, /\bstools?\b/,
  /\bpoop/, /bathroom/, /toilet/, /\bthe runs\b/, /stomach/, /tumm(y|ies)/, /bell(y|ies)/, /\bguts?\b/,
  /bowel/, /intestin/, /digest/, /\bdizz/, /\bfaint/, /lightheaded/, /tingl/, /\bnumb/, /throat/,
  /tongue/, /\blips?\b/, /mouth/, /breath/, /wheez/, /cough/, /sneez/, /congest/, /mucus|phlegm/,
  /react/, /flare/, /upset/, /agree(s|d)? with/, /\b(make|makes|made|making) me\b/,
  /\b(gives|gave|giving) me\b/, /\bcause/, /trigger/,
  /\b(i|i'?ve|we) (get|got|gets|feel|felt)\b.*\b(after|when|from|if)\b/,
  /\bafter (eating|i eat|having|i have|i ate)\b/, /\b(every ?time|whenever|when) i (eat|have|drink|ate)\b/,
  /\bfeel(s|ing)?\b/, /\bfelt\b/, /tired|fatigue|exhaust|sluggish|sleepy|drowsy/, /\benergy\b/,
  /jitter|shak(y|ing)/, /\bsweat/, /palpitat/, /\bheart\b/, /migraine/, /headache/, /\bacne\b/,
  /break(s)? me out/, /pimple/, /\bskin\b/, /swallow/, /\bchok(e|ed|es|ing)\b/, /\bgag/, /anxi/, /panic/,
  /trauma/, /\bptsd\b/, /symptom/, /side effect/, /\b(bad|good|better|worse) for me\b/, /health/,
  /\bbody\b/, /\bprobl[e]?ms?\b/, /\bissues?\b/, /trouble/, /hangover/,
  /\b(face|cheeks?|eyes?|ears?|nose|neck|chest|hands?|fingers?|feet|joints?|knees?|head)\b/,
  /\b(goes|go|went|turns?|turned|gets?|got) (red|blotchy|puffy|hot|flushed|pale|itchy|numb)\b/, /\bflush/,
  /[\u{1F922}\u{1F92E}\u{1F637}\u{1F912}\u{1F915}\u{1F927}\u{1F48A}\u{1FA7A}\u{1F489}]/u,
];

/** Negations the check can read: plain dislikes. Every other negation is unsure. */
const PLAIN_NEGATIONS: readonly RegExp[] = [
  /\b(don'?t|do not|didn'?t|never) (really )?(like|love|enjoy|care for)\b/g,
  /\b(can'?t|cannot|can not) stand\b/g,
  /\bnot (a |the )?(big |huge )?fan of\b/g, /\bnot (really )?(into|big on|crazy about)\b/g,
  /\bnot (for me|my thing)\b/g, /\bnever been a fan of\b/g,
];
const NEGATION = /^(not|no|never|nor|none|nothing|without|cannot|neither)$|n't$|nt$/;

/** Everything else about a phrase that the check cannot read with confidence. */
const UNSURE_PATTERNS: readonly RegExp[] = [/\bany ?more\b/, /\bno longer\b/, /\bthese days\b/, /\blately\b/,
  /\brecently\b/, /\bused to\b/, /\banymore\b/,
  // A food acting on the person ("dairy hates me", "eggs and I don't get along"): only "for me" and
  // "my favorite"-style phrases are plain.
  /\bme\b(?<!\bfor me)/, /\bmy\b(?!\s+(favou?rite|fave|comfort|go-to|thing|weakness)\b)/, /\band i\b/, /\bus\b/];

/** Letters, spaces and ordinary punctuation; anything else (digits, symbols, emoji) is unsure. */
const PLAIN_CHARS = /^[a-z' \-.,!?;:&()/]*$/;

export function normalizeTasteText(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[‘’`´]/g, "'").replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ").trim();
}

/** A listed word, or a plain inflection of one; a stem shorter than 4 letters never counts ("thing" is not "the"). */
function known(word: string): boolean {
  if (TASTE_WORDS.has(word)) return true;
  const stems = [word.replace(/'s$/, ""), word.replace(/s$/, ""), word.replace(/es$/, ""),
    word.replace(/ies$/, "y"), word.replace(/ed$/, ""), word.replace(/ed$/, "e"), word.replace(/ing$/, ""),
    word.replace(/ing$/, "e"), word.replace(/y$/, "")];
  return stems.some((stem) => stem !== word && stem.length >= 4 && TASTE_WORDS.has(stem));
}

/** True when every word is one the check knows and every negation is a plain dislike. */
function readable(norm: string): boolean {
  let rest = norm;
  for (const pattern of PLAIN_NEGATIONS) rest = rest.replace(pattern, " dislike ");
  const words = rest.split(/[^a-z'-]+/).map((word) => word.replace(/^['-]+|['-]+$/g, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0) return false;
  return words.every((word) => !NEGATION.test(word)
    && (known(word) || (word.includes("-") && word.split("-").every((part) => part === "" || known(part)))));
}

/**
 * The check's finding, finer than its route (an unsure PATTERN versus an unknown word).
 */
type Finding = "send" | "rules" | "symptom" | "unsure_pattern" | "unknown";

function finding(text: string): Finding {
  const norm = normalizeTasteText(typeof text === "string" ? text : "");
  if (RULE_PATTERNS.some((pattern) => pattern.test(norm))) return "rules";
  if (SYMPTOM_PATTERNS.some((pattern) => pattern.test(norm))) return "symptom";
  if (norm.length === 0 || text.length > TASTE_TEXT_MAX) return "unsure_pattern";
  if (UNSURE_PATTERNS.some((pattern) => pattern.test(norm))) return "unsure_pattern";
  if (!PLAIN_CHARS.test(norm)) return "unknown";
  return readable(norm) ? "send" : "unknown";
}

/** True when a symptom or body-effect pattern matches anywhere in the text. */
export function mentionsSymptom(text: string): boolean {
  const norm = normalizeTasteText(typeof text === "string" ? text : "");
  return SYMPTOM_PATTERNS.some((pattern) => pattern.test(norm));
}

/** Where the taste text may go: `send` only for plain likes, dislikes and cuisines. */
export function tasteTextRoute(text: string): TasteRoute {
  const found = finding(text);
  if (found === "send") return { route: "send" };
  return LOCAL(found === "rules" || found === "symptom" ? found : "unsure");
}

/** A message that may state a taste or a food preference: the coach's taste card looks no further. */
export const TASTE_WORD = /\b(like|likes|love|loves|hate|hates|dislike|dislikes|stand|enjoy|prefer|adore|fan|grew up|favou?rite|texture|textures|flavou?rs?|cuisine|food)\b/i;

/**
 * Whether a coach message may reach a Jev classifier (Sol r1 BLOCK 2, r2 BLOCK 1, r3 BLOCK 1): text
 * the check sends, or a message that is WHOLLY one of the app's command forms with allowed arguments
 * (lib/profile/coach-commands.ts). Anything else the check did not clear makes no intent Jev call.
 * Scope (coordinator decision): this gates the taste/preference purposes and the intent pre-pass.
 * OD12 (lib/ai/jev-health.ts) also uses it for the `suggest-options` wish, and treats every
 * `coach-verify` reply as health text; both stay off Jev while `JEV_HEALTH_GATE=1`.
 */
export function mayReachJev(text: string): boolean {
  if (tasteTextRoute(text).route === "send") return true;
  return isCoachCommand(normalizeTasteText(typeof text === "string" ? text : ""));
}
