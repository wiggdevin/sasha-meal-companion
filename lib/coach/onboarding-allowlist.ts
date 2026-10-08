/**
 * Onboarding v2: the ALLOWLIST gate in front of the one bounded extraction call (same design as
 * Phase 18 W5b's `tasteTextRoute` / `mayReachJev`). Three final Sol reviews each found a new
 * medicine the deny lists in lib/coach/onboarding-safety.ts missed (aspirin, then amoxicillin): a
 * deny list can never be complete. This inverts the rule. Text may reach a model only when, after
 * normalisation, EVERY token is a reviewed onboarding word (goal, body measures and their units,
 * age, sex, activity and workout, weekday, meal and time, cooking effort, and plain function
 * words) or a plain number, and the text has the shape of a plain statement. Any other word — a
 * medicine, brand or generic, a condition, a symptom, a food, a diet or a typo — keeps the text on
 * the phone: the regex fast path still reads what it can, and nothing else does.
 *
 * The deny checks (`onboardingSafetyCheck`) stay as a second layer and run FIRST everywhere: they
 * pick the safety card for text that names a health detail. This gate only answers "may a model
 * read this", never "is this safe to show the safety card for".
 *
 * Words never on this list, on purpose: every health, body-part, symptom, medicine and clinician
 * word; every food, drink and diet name (diet flags come from the tap-only safety and Foods
 * steps); "take" in any form (how people name a medicine); "feel", "tired", "energy", "health";
 * vague nouns ("thing", "stuff", "issue"); words with a second, health meaning (final Sol review
 * r3: "I have a fit every week"): "fit" (a seizure), "mass" and "stone" (a growth), "back" (an
 * injury), "cycle" (menstrual), "fast" and "skip" (eating rules), "myself" (self-harm: "I cut
 * myself"), "heavy", "spin", "turn"; reason and condition joiners ("because", "since",
 * "unless", "except", "due"); "can't", "won't", "shouldn't", "avoid", "allowed" (rule forms).
 * tests/onboarding/allowlist-gate.test.ts pins that no word here matches a deny pattern.
 *
 * Pure. No I/O.
 */

const FUNCTION_WORDS = `a an the i i'm im i've ive i'd id me my we we're our us you your it it's its this that is am are was
were be been being do does did doing have has had having and or but so as at by for from in into of
on to with about than then too very really quite pretty just also still mostly usually always often
sometimes generally typically normally currently right now these days around roughly approximately
approx about maybe probably like ish what how much many more less most least some any all each every
both other another few lot lots little bit kind sort not no don't dont do never yes yeah yep ok okay
sure hi hello hey thanks thank please would will could should want wants wanted wanting need needs
needed hope hoping hoped trying try tried tries looking aim aiming plan planning planned goal goals
target targets get gets got getting go goes going went able here there up down out over under
between least start started starting begin again already well know think say said tell rather prefer
prefers one ones who which good better great`;

const NUMBER_WORDS = `zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen
fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety
hundred half quarter once twice thrice couple`;

const GOAL_WORDS = `lose losing lost drop dropping dropped cut cutting shed shedding gain gaining gained build building
built add adding pack packing put weight weights fat body muscle muscles muscular lean leaner
leaning tone toned toning bulk bulking recomp recomposition maintain maintaining maintenance keep
keeping stay staying same where steady stronger strong strength fitter fitness composition shape healthy
healthier slim slimmer trim smaller bigger size progress slowly slow quick gradual gradually
steadily pace rate per`;

const MEASURE_WORDS = `pounds pound lb lbs kg kgs kilo kilos kilogram kilograms ft foot feet in inch inches cm cms
centimeter centimeters centimetre centimetres m meter meters metre metres tall height weigh weighs
weighed weighing currently`;

const AGE_SEX_WORDS = `age aged old years year yrs yr yo born birthday turning turned turn male female man
woman guy girl boy lady gal dude men women`;

const ACTIVITY_WORDS = `active activity inactive sedentary lightly light moderate moderately very exercise exercises
exercising workout workouts work works working out train trains training trained gym lift lifts
lifting lifted weightlifting powerlifting bodybuilding strength cardio run runs running ran runner
jog jogs jogging walk walks walking walked hike hikes hiking swim swims swimming bike bikes biking
cycling ride riding yoga pilates crossfit hiit boxing climbing climb dance dancing sport sports play
plays playing basketball soccer football tennis volleyball baseball softball golf hockey rowing row
martial arts class classes session sessions steps step desk job office sit sits sitting seated stand
stands standing feet all day days week weeks weekly month months daily everyday hour hours minute
minutes mins min times time job jobs shift shifts physical  busy home school student
retired`;

const DAY_WORDS = `monday mondays tuesday tuesdays wednesday wednesdays thursday thursdays friday fridays
saturday saturdays sunday sundays mon tue tues wed thu thur thurs fri sat sun weekday weekdays weekend
weekends today tomorrow`;

const MEAL_TIME_WORDS = `meal meals breakfast breakfasts lunch lunches dinner dinners supper snack snacks
snacking eat eats eating ate first last morning mornings noon midday afternoon afternoons evening
evenings night nights late early am pm o'clock oclock clock usually around before after`;

const COOKING_WORDS = `cook cooks cooking cooked cook's chef kitchen prep prepping prepped meal-prep simple
easy minimal scratch effort fancy recipes recipe quick microwave time much enjoy enjoys love loves
hate hates mind`;

const SPLIT = /\s+/;

/** Every word the gate can read (tests pin that each is lowercase letters, an apostrophe or a hyphen). */
export const ONBOARDING_WORDS: ReadonlySet<string> = new Set(
  [FUNCTION_WORDS, NUMBER_WORDS, GOAL_WORDS, MEASURE_WORDS, AGE_SEX_WORDS, ACTIVITY_WORDS, DAY_WORDS,
    MEAL_TIME_WORDS, COOKING_WORDS]
    .flatMap((list) => list.split(SPLIT))
    .filter((word) => word.length > 0),
);

/** Longest text the gate reads; anything longer stays local. */
export const ONBOARDING_ALLOWLIST_MAX_CHARS = 300;
const MAX_TOKENS = 60;

/** Letters, digits, spaces and ordinary punctuation (with the foot and inch marks). Anything
 *  else — emoji, symbols, a non-Latin script — keeps the text local. */
const PLAIN_CHARS = /^[a-z0-9' .,!?;:&()/"%-]*$/;

/** A plain number: an age, a measure, a count, a clock time. */
const NUMBER = /^\d{1,4}(?:\.\d{1,2})?$/;

/**
 * Clause shapes outside a plain statement about goals, body and routine. A question, a reason or
 * condition clause, or a cause-and-effect form keeps the text local even when its words are known.
 */
const SHAPE_PATTERNS: readonly RegExp[] = [
  /\?/,
  /\b(?:makes?|made|gives?|gave)\s+me\b/,
  /\b(?:after|before|when|whenever|every ?time)\s+(?:i\s+)?(?:eat|eating|ate)\b/,
  // An eating rule ("I don't eat after 7", "I only eat dinner"): a rule, read by the tap-only steps.
  /\b(?:don'?t|do not|never|not|no|only|stop|stopped|can'?t|cannot|won'?t)\s+(?:\w+\s+)?(?:eat|eats|eating|ate)\b/,
  // A calorie or intake ceiling ("eat under 800"): an eating-disorder signal, never a goal.
  /\b(?:eat|eats|eating|ate)\b[^.!;]{0,20}\b(?:under|below|less than|no more than|at most)\s+\d/,
  // "I'm 20 weeks", "about 5 months in": a pregnancy said without the word.
  /\b(?:i'?m|i am|im)\s+(?:about\s+|around\s+|almost\s+|nearly\s+)?\d{1,2}\s+(?:weeks?|months?)\b/,
  /\b\d{1,2}\s+(?:weeks?|months?)\s+(?:along|in|pregnant|postpartum)\b/,
  /\brun down\b|\bworn out\b/,
  // Final Sol review r4: one meal a day is an eating rule, not a meal count.
  /\b(?:one|1|a single|single)\s+meals?\s+(?:a|per|each)\s+day\b|\b(?:eat|eats|eating|ate)\s+once\b|\bonce\s+(?:a|per)\s+day\b[^.!;]{0,20}\beat/,
];

/** Things a person "has" that are plain onboarding facts. Any other "have a …" names a thing the
 *  vocabulary cannot tell from an injury or a health event (final Sol review r4: "I have a cut"). */
const HAVE_NOUNS = new Set(["desk", "job", "goal", "goals", "target", "gym", "office", "busy", "plan",
  "physical", "active", "very", "pretty", "kitchen", "shift", "shifts", "lot", "little", "few", "couple",
  "trainer", "class", "session", "home"]);
const HAVE_A = new Set(["have", "has", "had", "having", "got", "get", "gets", "getting"]);

/** The goal phrases "get fit" and "stay fit" are read as "fitness"; "fit" alone is never a word
 *  here ("I have a fit every week" is a seizure). */
const FIT_PHRASE = /\b(get|getting|got|stay|staying|keep|keeping|be|more|very|super)\s+fit\b/g;

/** A body word only in its measurement or goal use: "5 foot 6", "on my feet all day", "body fat".
 *  Anything else ("my foot", "drop foot", "my body is…") keeps the text local. */
function bodyWordsInPlace(words: readonly string[]): boolean {
  return words.every((word, i) => {
    if (word === "foot" || word === "feet" || word === "ft") {
      return NUMBER.test(words[i - 1] ?? "") || (words[i - 2] === "on" && (words[i - 1] === "my" || words[i - 1] === "your"));
    }
    if (word === "body") return ["fat", "weight", "composition", "recomp", "recomposition"].includes(words[i + 1] ?? "");
    // "have a cut", "got a pull": a noun after "have a" must be a plain onboarding fact.
    if ((word === "a" || word === "an") && HAVE_A.has(words[i - 1] ?? "")) {
      return HAVE_NOUNS.has(words[i + 1] ?? "");
    }
    // "cut" only as the goal verb or the season ("cut fat", "on a cut"), never an injury.
    if (word === "cut" || word === "cutting" || word === "cuts") {
      return ["fat", "weight", "body", "some", "down", "back"].includes(words[i + 1] ?? "")
        || NUMBER.test(words[i + 1] ?? "") || (words[i - 1] === "a" && words[i - 2] === "on");
    }
    return true;
  });
}

/** Lowercased, accents folded, quote marks unified, digits split from their unit
 *  ("5'6\"" → "5 ' 6 \"", "170lbs" → "170 lbs", "7am" → "7 am", "y.o." → "yo"). */
export function normalizeOnboardingText(text: string): string {
  return String(text).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[‘’′`´]/g, "'").replace(/[“”″]/g, "\"")
    .replace(/[‐-―]/g, "-")
    .replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/\by\.\s?o\.?/g, "yo")
    .replace(/(\d)\s*('{1,2}|")/g, "$1 $2 ")
    .replace(/\s+/g, " ").trim();
}

function tokens(norm: string): string[] {
  return norm.split(/[\s.,!;:&()/"%]+/)
    .map((token) => token.replace(/^['-]+|['-]+$/g, ""))
    .filter((token) => token.length > 0);
}

function knownToken(token: string): boolean {
  if (NUMBER.test(token) || ONBOARDING_WORDS.has(token)) return true;
  // "meal-prep", "5-day", "twice-a-week": every part known.
  return token.includes("-") && token.split("-").every((part) => part === ""
    || NUMBER.test(part) || ONBOARDING_WORDS.has(part));
}

export type OnboardingAllowlistVerdict =
  | { send: true }
  | { send: false; reason: "empty" | "too_long" | "characters" | "shape" | "unknown_word" };

/**
 * Whether `text` may reach the onboarding extraction model. Callers run `onboardingSafetyCheck`
 * first (the safety card); this decides only whether a model may read what that check let through.
 */
export function onboardingAllowlistVerdict(text: string): OnboardingAllowlistVerdict {
  const raw = typeof text === "string" ? text : "";
  if (raw.length > ONBOARDING_ALLOWLIST_MAX_CHARS) return { send: false, reason: "too_long" };
  const norm = normalizeOnboardingText(raw).replace(FIT_PHRASE, "$1 fitness");
  if (norm.length === 0) return { send: false, reason: "empty" };
  if (!PLAIN_CHARS.test(norm)) return { send: false, reason: "characters" };
  if (SHAPE_PATTERNS.some((pattern) => pattern.test(norm))) return { send: false, reason: "shape" };
  const words = tokens(norm);
  if (words.length === 0) return { send: false, reason: "empty" };
  if (words.length > MAX_TOKENS) return { send: false, reason: "too_long" };
  if (!words.every(knownToken)) return { send: false, reason: "unknown_word" };
  return bodyWordsInPlace(words) ? { send: true } : { send: false, reason: "shape" };
}

export function onboardingMayReachModel(text: string): boolean {
  return onboardingAllowlistVerdict(text).send;
}
