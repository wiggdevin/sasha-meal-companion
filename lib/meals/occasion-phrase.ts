/**
 * The meal a request names, and the request with that whole phrase removed (Phase 17 O4a,
 * docs/specs/phase-17-meal-occasion.md). One parser for every path that reads a meal out of free
 * text: recipe search (lib/coach/recipe-query.ts, the parsing part of lib/recipes/occasion.ts)
 * now, and the compose_meal rebuild (O4b) when it lands.
 *
 * Three readings, strongest first:
 *   1. An explicit phrase: "for", "at" or "as", an optional determiner, up to three modifiers and
 *      a meal word ("salmon at lunch", "for a late dinner", "as a quick snack", "for my
 *      post-workout snack", "for lunch today", "for lunch and dinner"). The whole phrase leaves
 *      the request: "salmon for a late dinner" searches "salmon".
 *   2. A bare meal word ("easy breakfast", "salmon tonight", "brunch ideas"). It leaves the request
 *      together with any time-of-day word and determiner just before it ("late night snack", "an
 *      early lunch"). A quality word ("easy") stays, because it describes the food.
 *   3. A meal word inside a dish name: a meal word followed by another dish word ("breakfast
 *      burrito", "snack bar"). It names the meal only when nothing else does, and it STAYS in the
 *      request, because it is part of the dish.
 *
 * So "breakfast burrito for dinner" is dinner and searches "breakfast burrito". When an explicit
 * phrase wins, a bare word for a different meal describes the food and stays ("breakfast for
 * dinner"); a bare word for the same meal leaves ("dinner ideas for tonight").
 *
 * Pure. No I/O.
 */

import type { Occasion } from "@/lib/meals/occasion";

/** The meals a request can name; "other" (overnight) is a slot's clock, never a word. */
export type MealWord = Exclude<Occasion, "other">;

export type OccasionPhrase = {
  /** The meal the request names, or null when it names none. */
  occasion: MealWord | null;
  /** The request without the phrase that named the meal, whitespace collapsed. */
  rest: string;
};

/** Every word that names a meal. "Tonight" asks for dinner as plainly as "dinner" does. */
const MEAL_OF: Readonly<Record<string, MealWord>> = {
  breakfast: "breakfast", brunch: "breakfast",
  lunch: "lunch", lunchtime: "lunch",
  dinner: "dinner", dinnertime: "dinner", supper: "dinner", suppertime: "dinner", tonight: "dinner",
  snack: "snack", snacks: "snack", snacktime: "snack",
};

/**
 * The parser's whole meal vocabulary. Recipe search reads it as non-dish words
 * (lib/recipe-catalog/query.ts), so a word the parser takes as a meal can never become a hard
 * search term there (review round 1 BLOCK 3).
 */
export const MEAL_WORDS: readonly string[] = Object.freeze(Object.keys(MEAL_OF));

/** Longest first, so "lunchtime" is read whole before "lunch". */
const MEAL = `(?:${[...MEAL_WORDS].sort((a, b) => b.length - a.length).join("|")})`;
const DETERMINER = String.raw`(?:a|an|my|the|this|our|your|today'?s|tonight'?s|tomorrow'?s)`;
/** Words that say WHEN the meal is, not what is in it: they leave with the meal word. */
const WHEN = String.raw`(?:(?:late|mid)[- ]?(?:night|morning)|(?:post|pre)[- ]?workout|after[- ]?school|late|early|morning|afternoon|evening|midnight|weekday|weekend|work|school|second)`;
/** Words that say what the meal is like. Inside an explicit phrase they leave with it. */
const LIKE = String.raw`(?:quick|easy|light|simple|healthy|hearty|big|small|large|fast|lazy|filling|proper|little|nice|good)`;
const SEP = String.raw`(?:\s*,\s*|\s+and\s+|\s+)`;
/** "for lunch and dinner", "for lunch or dinner", "for lunch/dinner": one phrase, the first meal. */
const MORE_MEALS = String.raw`(?:(?:\s*[,/&]\s*|\s+(?:and|or)\s+)${MEAL})*`;
const DAY = String.raw`(?:mon|tues|wednes|thurs|fri|satur|sun)days?`;
/**
 * Words that say WHEN, on either side of a meal phrase ("for dinner tomorrow night", "later today",
 * "this evening", "on friday"). They leave with the meal phrase; left behind they would become dish
 * terms and filter every recipe out (review round 1 BLOCK 2).
 */
const TIME_WORD = String.raw`(?:today|tonight|tomorrow|tmrw|night|morning|afternoon|evening|later|now|soon|`
  + String.raw`(?:this|next)\s+(?:morning|afternoon|evening|week(?:end)?|${DAY})|(?:on\s+)?${DAY})`;
const TIME_RUN = String.raw`${TIME_WORD}(?:\s+${TIME_WORD}){0,2}`;
/** After the meal word: "time" ("at lunch time"), then any run of time words, captured. */
const TAIL = String.raw`(?:\s+time)?(?<tail>\s+${TIME_RUN})?`;

const EXPLICIT = new RegExp(String.raw`(?<![\w-])(?:${TIME_RUN}\s+)?(?:for|at|as)\s+(?:${DETERMINER}\s+)?`
  + String.raw`(?:(?:${WHEN}|${LIKE})${SEP}){0,3}(?<meal>${MEAL})${MORE_MEALS}${TAIL}(?![\w-])`, "gi");
const BARE = new RegExp(String.raw`(?<![\w-])(?:${TIME_RUN}\s+)?(?:${DETERMINER}\s+)?(?:${WHEN}\s+){0,2}`
  + String.raw`(?<meal>${MEAL})${TAIL}(?![\w-])`, "gi");
/** Any meal word, a hyphenated dish name included ("breakfast-style"). */
const ANY = new RegExp(String.raw`(?<![\w-])(?<meal>${MEAL})(?!\w)`, "i");

/**
 * Words that may follow a meal word without making it part of a dish name: request words,
 * function words, times. Any other word after a meal word ("burrito", "bar", "rolls") is a dish.
 */
const NOT_DISH = new Set([
  "idea", "ideas", "recipe", "recipes", "option", "options", "suggestion", "suggestions", "meal",
  "meals", "food", "foods", "dish", "dishes", "menu", "plan", "please", "pls", "thanks", "today",
  "tonight", "tomorrow", "yesterday", "now", "later", "soon", "again", "too", "also", "only",
  "just", "maybe", "instead", "then", "so", "this", "that", "these", "those", "which", "who",
  "with", "without", "under", "over", "in", "within", "less", "more", "at", "for", "as", "and",
  "or", "but", "nor", "no", "not", "using", "to", "on", "after", "before", "around", "about",
  "from", "of", "like", "by", "near", "into", "than", "via", "plus", "if", "when", "while",
  "because", "since", "until", "is", "are", "was", "be", "will", "would", "could", "should",
  "can", "i", "we", "you", "they", "it", "me", "us", "them", "my", "our", "your",
  "some", "any", "something", "anything", "every", "each", "here", "there", "ok", "okay",
]);

const FOLLOWER = /^\s+([\p{L}\p{N}][\p{L}\p{N}'’]*)/u;

/** Whether the word right after `end` (same clause, no punctuation between) makes a dish name. */
function namesDish(text: string, end: number): boolean {
  if (text[end] === "-") return true;
  const next = FOLLOWER.exec(text.slice(end))?.[1]?.toLowerCase();
  return next !== undefined && !/^\d/.test(next) && !NOT_DISH.has(next);
}

/** A match's span, and whether its meal word is really part of a dish name. A time word right
 *  after the meal word ("dinner tomorrow") says it is not. */
function read(text: string, match: RegExpMatchArray): { span: Span; meal: MealWord; dish: boolean } {
  const at = match.index ?? 0;
  const span: Span = [at, at + match[0].length];
  return { span, meal: mealOf(match.groups?.meal ?? ""), dish: !match.groups?.tail && namesDish(text, span[1]) };
}

type Span = readonly [number, number];
const inside = (span: Span, cuts: readonly Span[]) =>
  cuts.some(([from, to]) => span[0] < to && span[1] > from);

function without(text: string, cuts: readonly Span[]): string {
  let out = "";
  let at = 0;
  for (const [from, to] of [...cuts].sort((a, b) => a[0] - b[0])) {
    if (from < at) { at = Math.max(at, to); continue; }
    out += `${text.slice(at, from)} `;
    at = to;
  }
  return (out + text.slice(at)).replace(/\s+([,;:.!?])/g, "$1").replace(/([,;:])[,;:]+/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.!?&/-]+|[\s,;:.!?&/-]+$/g, "");
}

const mealOf = (word: string): MealWord => MEAL_OF[word.toLowerCase()];

/** The meal a request names and the request without that phrase; see the module note. */
export function parseOccasionPhrase(text: string | null | undefined): OccasionPhrase {
  const source = text ?? "";
  const cuts: Span[] = [];
  let explicit: MealWord | null = null;
  for (const match of source.matchAll(EXPLICIT)) {
    const { span, meal, dish } = read(source, match);
    if (dish) continue;
    explicit ??= meal;
    cuts.push(span);
  }
  const bare: { span: Span; meal: MealWord }[] = [];
  for (const match of source.matchAll(BARE)) {
    const { span, meal, dish } = read(source, match);
    if (inside(span, cuts) || dish) continue;
    bare.push({ span, meal });
  }
  if (explicit) {
    cuts.push(...bare.filter((row) => row.meal === explicit).map((row) => row.span));
    return { occasion: explicit, rest: without(source, cuts) };
  }
  if (bare.length) {
    return { occasion: bare[0].meal, rest: without(source, bare.map((row) => row.span)) };
  }
  const dish = ANY.exec(source);
  return { occasion: dish ? mealOf(dish.groups?.meal ?? "") : null, rest: without(source, []) };
}
