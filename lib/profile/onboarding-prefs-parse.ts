/**
 * Onboarding v2's three always-on preference questions (owner, 2026-10-08, overriding spec D2's
 * optional pilots): food practices, foods to stay away from, and favored cuisines. Each is typed
 * first and read HERE, on the phone, by keyword — no model call, ever. Pure, no I/O.
 *
 *  - Practices are asked as practices, never as a religion (D2). They map onto the existing
 *    deterministic rule flags (`PREFERENCE_FLAGS`, `diet_prefs.flags`, enforced through
 *    lib/policy/profiles/legacy-flags.ts), the same flags Settings and Foods › Avoids write.
 *    Allergens are NOT read here: the safety round owns them.
 *  - Stay-away foods are taste dislikes (`diet_prefs.taste.dislikes`, `f:<family>`): they lower a
 *    food's rank and never exclude it (lib/profile/taste.ts).
 *  - Cuisines are the 12-word vocabulary (the shared cuisine vocabulary, via lib/profile/cuisines), at most 6.
 */
import { baseFoodName } from "@/lib/foods/base-name";
import { CUISINES_MAX, type CuisineKey } from "@/lib/profile/cuisines";
import { TASTE_DISLIKES_MAX, tasteDislike, type TasteDislike } from "@/lib/profile/taste";
import type { PreferenceFlag } from "@/lib/profile/onboarding-state";
import type { ProfileDietPrefs } from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’‘`´]/g, "'").replace(/[^a-z0-9' -]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** "not vegan", "no longer vegetarian", "used to be pescatarian", "isn't kosher" before a word. */
function negatedAt(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 24), index);
  return /\b(?:not|never|no longer|used to be|n't|nt)\s+(?:a\s+|an\s+|really\s+|strictly\s+)?$/.test(before);
}

function hits(text: string, pattern: RegExp): boolean {
  const global = new RegExp(pattern.source, "g");
  for (const match of text.matchAll(global)) {
    if (!negatedAt(text, match.index ?? 0)) return true;
  }
  return false;
}

// ---- Practices --------------------------------------------------------------------------------

/** The practices offered, in tile order. Every id is an existing `PreferenceFlag`. */
export const PRACTICE_IDS = [
  "vegetarian", "vegan", "pescatarian", "halal", "kosher", "no_pork", "no_beef",
] as const satisfies readonly PreferenceFlag[];
export type PracticeId = (typeof PRACTICE_IDS)[number];

export const PRACTICE_LABELS: Readonly<Record<PracticeId, string>> = {
  vegetarian: "Vegetarian", vegan: "Vegan", pescatarian: "Pescatarian", halal: "Halal",
  kosher: "Kosher", no_pork: "No pork", no_beef: "No beef",
};

/** Keyword → practice ids. A word after "not", "never", "no longer" or "used to be" is not read. */
const PRACTICE_WORDS: readonly [RegExp, readonly PracticeId[]][] = [
  [/\bvegans?\b|\bplant[ -]based\b|\bno animal products?\b/, ["vegan"]],
  [/\bvegetarians?\b|\bveggie\b|\bmeatless\b|\bno meat\b|\bdon'?t eat meat\b/, ["vegetarian"]],
  [/\bpesc[ae]tarians?\b|\bfish but no meat\b|\bonly fish\b/, ["pescatarian"]],
  [/\bhalal\b|\bzabiha\b/, ["halal"]],
  [/\bkosher\b/, ["kosher"]],
  [/\bno pork\b|\bpork[ -]free\b|\bdon'?t eat pork\b|\bdon'?t eat beef (?:or|and|nor) pork\b|\bnot pork\b|\bno bacon\b|\bno ham\b/, ["no_pork"]],
  [/\bno beef\b|\bbeef[ -]free\b|\bdon'?t eat beef\b|\bdon'?t eat pork (?:or|and|nor) beef\b|\bnot beef\b/, ["no_beef"]],
  [/\bno red meat\b|\bdon'?t eat red meat\b/, ["no_beef", "no_pork"]],
];
/** "No", "none", "nothing", "no rules": answered, with no practice. */
const NONE_ANSWER = /^(?:no|nope|none|nothing|n a|na|no rules|none of these|no restrictions|i eat everything|everything|anything)$/;

export type PracticeReading = { practices: PracticeId[]; none: boolean };

/** The practices a typed answer names, in tile order. */
export function parsePractices(text: string): PracticeReading {
  const norm = normalize(text);
  if (NONE_ANSWER.test(norm)) return { practices: [], none: true };
  const found = new Set<PracticeId>();
  for (const [pattern, ids] of PRACTICE_WORDS) {
    if (hits(norm, pattern)) ids.forEach((id) => found.add(id));
  }
  return { practices: PRACTICE_IDS.filter((id) => found.has(id)), none: false };
}

// ---- Stay-away foods (taste dislikes) ---------------------------------------------------------

/** The tiles offered, each a canonical universe family (tests/profile/onboarding-prefs-parse.test.ts
 *  holds every one against `tasteFamilies()`). */
export const DISLIKE_FAMILIES = [
  "mushrooms", "olives", "cilantro", "onion", "tomato", "eggplant", "brussels sprouts",
  "cauliflower", "bell pepper", "beets", "celery", "avocado", "tofu", "cottage cheese",
  "blue cheese", "sardines",
] as const;

const DISLIKE_ALIASES: Readonly<Record<string, string>> = {
  mushroom: "mushrooms", olive: "olives", coriander: "cilantro", onions: "onion",
  tomatoes: "tomato", eggplants: "eggplant", aubergine: "eggplant", "brussel sprouts": "brussels sprouts",
  "brussels sprout": "brussels sprouts", sprouts: "brussels sprouts", peppers: "bell pepper",
  "bell peppers": "bell pepper", beet: "beets", avocados: "avocado", sardine: "sardines",
};
const DISLIKE_LEAD = /^(?:i\s+)?(?:really\s+)?(?:hate|dislike|can'?t stand|don'?t like|do not like|not a fan of|no|not|avoid|skip|without)\s+/;
const DISLIKE_ITEM = /^[a-z][a-z '-]{1,39}$/;

/** One typed item as a dislike key: a curated family, an alias of one, or the item's own name
 *  family when it is a plain food word. `null` for anything else. */
function dislikeFor(item: string): TasteDislike | null {
  let word = normalize(item).replace(DISLIKE_LEAD, "").replace(/^(?:the|any|all)\s+/, "").trim();
  word = DISLIKE_ALIASES[word] ?? word;
  if (!DISLIKE_ITEM.test(word)) return null;
  return tasteDislike(`f:${baseFoodName(word)}`);
}

/** "mushrooms, olives and cilantro" → `f:` keys, in typed order, no repeats. */
export function parseDislikes(text: string): { dislikes: TasteDislike[]; none: boolean } {
  const norm = normalize(text);
  if (NONE_ANSWER.test(norm)) return { dislikes: [], none: true };
  const items = text.split(/[,;\n/]+|\band\b|\bor\b|&/i).map((item) => item.trim()).filter(Boolean);
  const keys = items.map(dislikeFor).filter((key): key is TasteDislike => key !== null);
  return { dislikes: [...new Set(keys)], none: false };
}

/** The tile label for a dislike key: the family, first letter up. */
export function dislikeLabel(key: TasteDislike): string {
  const family = key.slice(2);
  return family.charAt(0).toUpperCase() + family.slice(1);
}

// ---- Cuisines ---------------------------------------------------------------------------------

/** Short tile words for the 12 cuisines (the long labels live in vocabulary.ts). */
export const CUISINE_TILE_LABELS: Readonly<Record<CuisineKey, string>> = {
  american: "American", latin_american: "Mexican & Latin", italian: "Italian",
  mediterranean: "Mediterranean", south_asian: "Indian", chinese: "Chinese", japanese: "Japanese",
  korean: "Korean", southeast_asian: "Thai & SE Asian", caribbean: "Caribbean", african: "African",
  european_other: "European",
};

const CUISINE_WORDS: readonly [RegExp, CuisineKey][] = [
  [/\bamerican\b|\bbbq\b|\bbarbecue\b|\bsouthern\b|\bsoul food\b|\bcajun\b|\bburgers?\b|\bdiner\b/, "american"],
  [/\bmexican\b|\blatin\b|\blatino\b|\btex[ -]?mex\b|\btacos?\b|\bperuvian\b|\bcolombian\b|\bbrazilian\b|\bsalvadoran\b|\bargentin\w*/, "latin_american"],
  [/\bitalian\b|\bpasta\b|\bpizza\b/, "italian"],
  [/\bmediterranean\b|\bgreek\b|\bmiddle eastern\b|\blebanese\b|\bturkish\b|\bpersian\b|\bisraeli\b/, "mediterranean"],
  [/\bindian\b|\bsouth asian\b|\bpakistani\b|\bbangladeshi\b|\bsri lankan\b|\bnepali\b|\bcurry\b/, "south_asian"],
  [/\bchinese\b|\bcantonese\b|\bszechuan\b|\bsichuan\b|\bdim sum\b|\btaiwanese\b/, "chinese"],
  [/\bjapanese\b|\bsushi\b|\bramen\b/, "japanese"],
  [/\bkorean\b/, "korean"],
  [/\bthai\b|\bvietnamese\b|\bfilipino\b|\bmalaysian\b|\bindonesian\b|\bsoutheast asian\b|\bpho\b/, "southeast_asian"],
  [/\bcaribbean\b|\bjamaican\b|\bcuban\b|\bpuerto rican\b|\bdominican\b|\bhaitian\b/, "caribbean"],
  [/\bafrican\b|\bethiopian\b|\bnigerian\b|\bmoroccan\b|\bwest african\b|\bsenegalese\b/, "african"],
  [/\beuropean\b|\bfrench\b|\bgerman\b|\bspanish\b|\bpolish\b|\bbritish\b|\birish\b|\beastern european\b/, "european_other"],
];

/** The cuisines a typed answer names, in the order typed, at most 6. */
export function parseCuisinesText(text: string): { cuisines: CuisineKey[]; none: boolean } {
  const norm = normalize(text);
  if (NONE_ANSWER.test(norm)) return { cuisines: [], none: true };
  const found: { key: CuisineKey; at: number }[] = [];
  for (const [pattern, key] of CUISINE_WORDS) {
    const match = new RegExp(pattern.source, "g").exec(norm);
    if (match && !negatedAt(norm, match.index)) found.push({ key, at: match.index });
  }
  found.sort((a, b) => a.at - b.at);
  return { cuisines: found.map((item) => item.key).slice(0, CUISINES_MAX), none: false };
}

// ---- Writing the answers ----------------------------------------------------------------------

/**
 * The settings with the cuisine and stay-away answers on them, for the onboarding save: cuisines
 * replace (at most 6), dislikes are added to any the account already holds (at most 50), and every
 * other `diet_prefs` key (flags, text, water, lifestyle) is kept. The settings sync turns each into
 * its set delta (lib/sync/settings-intents.ts). A null answer changes nothing.
 */
export function settingsWithPrefsAnswers(settings: Settings, answers: {
  cuisines: readonly CuisineKey[] | null; dislikes: readonly TasteDislike[] | null;
}): Settings {
  let next = settings;
  if (answers.cuisines) next = { ...next, cuisines: answers.cuisines.slice(0, CUISINES_MAX) };
  if (answers.dislikes && answers.dislikes.length > 0) {
    const prefs = (next.dietPrefs ?? { flags: [] }) as ProfileDietPrefs;
    const held = prefs.taste?.dislikes ?? [];
    const dislikes = [...held, ...answers.dislikes.filter((key) => !held.includes(key))].slice(0, TASTE_DISLIKES_MAX);
    next = { ...next, dietPrefs: { ...prefs, taste: { ...prefs.taste, dislikes } } as Settings["dietPrefs"] };
  }
  return next;
}
