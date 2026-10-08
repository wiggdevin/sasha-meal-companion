/**
 * Onboarding v2 G4: the fast path's readers for the plan answers the question set adds — training
 * weekdays, meals a day, first meal time, a spoken pace and a goal weight. Same rules as
 * lib/coach/onboarding-fast-path.ts: zero model calls, an anchor word earns HIGH, a bare or loose
 * match earns GHOST (one tap), a negated match reads as nothing. These fields never reach the
 * model's schema (`onboardingModelFactsSchema`); only this regex reader fills them.
 *
 * A spoken pace is kept as asked (`requestedPaceLbPerWeek`); lib/profile/pace.ts
 * `chipForRequestedPace` turns it into a preset after the cap, so the asked number is never stored
 * as if accepted. A goal weight is a draft value only and is never stored (question set §1a).
 *
 * Pure. No I/O.
 */

export const PLAN_HIGH = 0.9;
export const PLAN_GHOST = 0.6;

export type PlanFastPathFacts = {
  trainingWeekdays?: number[];
  mealsPerDay?: number;
  firstMealTime?: string;
  requestedPaceLbPerWeek?: number;
  targetWeightKg?: number;
  confidence: Partial<Record<
    "trainingWeekdays" | "mealsPerDay" | "firstMealTime" | "requestedPaceLbPerWeek" | "targetWeightKg",
    number>>;
};

const KG_PER_LB = 0.45359237;
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, half: 0.5,
};
const NEGATION = /\b(?:not|never|no|don'?t|do not|doesn'?t|can'?t|won'?t)\b[^.,;!?]{0,20}$/;

function negatedBefore(norm: string, index: number): boolean {
  return NEGATION.test(norm.slice(Math.max(0, index - 30), index));
}

// ---- Training weekdays ---------------------------------------------------------------------

const DAY_WORDS: readonly [number, RegExp][] = [
  [0, /^sun(?:day)?s?$/], [1, /^mon(?:day)?s?$/], [2, /^tue(?:s|sday)?s?$/],
  [3, /^wed(?:s|nesday)?s?$/], [4, /^thu(?:r|rs|rsday)?s?$/], [5, /^fri(?:day)?s?$/],
  [6, /^sat(?:urday)?s?$/],
];
const DAY_TOKEN = String.raw`(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)s?`;
const TRAINING_VERB = /\b(?:lift(?:ing)?|train(?:ing)?|work(?:ing)? ?out|workouts?|gym|exercis\w*|run(?:ning)?|cardio|yoga|pilates|crossfit|spin|swim(?:ming)?|cycle|cycling|class(?:es)?|practice)\b/;
const NO_TRAINING = /\b(?:don'?t|do not|never|not)\s+(?:currently\s+|really\s+)?(?:work ?out|exercise|train|lift|go to the gym)\b/;

function dayOf(word: string): number | null {
  for (const [day, pattern] of DAY_WORDS) if (pattern.test(word)) return day;
  return null;
}

/** True when `pattern` occurs in `clause` at least once with no negation just before it. */
function affirmed(clause: string, pattern: RegExp): boolean {
  for (const match of clause.matchAll(new RegExp(pattern.source, "g"))) {
    if (!negatedBefore(clause, match.index)) return true;
  }
  return false;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let day = from; ; day = (day + 1) % 7) {
    out.push(day);
    if (day === to || out.length === 7) return out;
  }
}

function extractWeekdays(norm: string, out: PlanFastPathFacts): void {
  const clauses = norm.split(/[.;!?]/);
  const days = new Set<number>();
  for (const clause of clauses) {
    if (!TRAINING_VERB.test(clause)) continue;
    if (affirmed(clause, /\bevery ?day\b|\bdaily\b|\b7 days a week\b/)) range(0, 6).forEach((d) => days.add(d));
    if (affirmed(clause, /\bweekdays\b/)) range(1, 5).forEach((d) => days.add(d));
    if (affirmed(clause, /\bweekends?\b/)) [0, 6].forEach((d) => days.add(d));
    const spans = new RegExp(String.raw`\b(${DAY_TOKEN})\s*(?:-|–|to|through|thru)\s*(${DAY_TOKEN})\b`, "g");
    for (const match of clause.matchAll(spans)) {
      const from = dayOf(match[1]);
      const to = dayOf(match[2]);
      if (from !== null && to !== null) range(from, to).forEach((d) => days.add(d));
    }
    for (const match of clause.matchAll(new RegExp(String.raw`\b${DAY_TOKEN}\b`, "g"))) {
      if (negatedBefore(clause, match.index)) continue;
      const day = dayOf(match[0]);
      if (day !== null) days.add(day);
    }
  }
  if (days.size > 0) {
    out.trainingWeekdays = [...days].sort((a, b) => a - b);
    out.confidence.trainingWeekdays = PLAN_HIGH;
  } else if (NO_TRAINING.test(norm)) {
    out.trainingWeekdays = [];
    out.confidence.trainingWeekdays = PLAN_HIGH;
  }
}

// ---- Meals a day ---------------------------------------------------------------------------

const MEALS_PER_DAY = /\b([2-6]|two|three|four|five|six)\s+(?:meals?|times)\s+(?:a|per|each)\s+day\b/;
const MEALS_BARE = /\b([2-6]|two|three|four|five|six)\s+meals\b/;

function extractMeals(norm: string, out: PlanFastPathFacts): void {
  const anchored = MEALS_PER_DAY.exec(norm);
  const match = anchored ?? MEALS_BARE.exec(norm);
  if (!match || negatedBefore(norm, match.index)) return;
  const value = /^\d$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1]];
  if (!Number.isInteger(value) || value < 2 || value > 6) return;
  out.mealsPerDay = value;
  out.confidence.mealsPerDay = anchored ? PLAN_HIGH : PLAN_GHOST;
}

// ---- First meal time -----------------------------------------------------------------------

const FIRST_MEAL = /\b(?:breakfast|first meal|eat first|first eat|start eating|first thing i eat|first bite)\b[^.?!]{0,25}?\b(?:at|around|by|about|near)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/;

function extractFirstMeal(norm: string, out: PlanFastPathFacts): void {
  const match = FIRST_MEAL.exec(norm);
  if (!match) return;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (hour > 23 || minute > 59) return;
  const meridiem = match[3]?.replace(/\./g, "");
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  // No am/pm: a first meal from 1 to 4 reads as afternoon, anything else as stated; one tap.
  if (!meridiem && hour >= 1 && hour <= 4) hour += 12;
  out.firstMealTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  out.confidence.firstMealTime = meridiem || match[2] !== undefined ? PLAN_HIGH : PLAN_GHOST;
}

// ---- Pace and goal weight ------------------------------------------------------------------

export const PACE_SPAN = /\b(\d+(?:\.\d+)?|half a|half|a|an|one|two|three)\s*(lbs?|pounds?|kgs?|kilos?|kilograms?)\s*(?:a|per|each|every)\s*week\b/;
export const TARGET_SPAN = /\b(?:get(?:ting)? (?:down |back |up )?to|reach|goal(?: weight)?(?: is| of)?|target(?: weight)?(?: is| of)?|down to|up to)\s+(?:about |around )?(\d{2,3}(?:\.\d+)?)\s*(lbs?|pounds?|kgs?|kilos?|kilograms?)?\b/;
/** "lose 30 pounds": an amount to change, never the current weight. */
export const CHANGE_SPAN = /\b(?:lose|losing|drop|dropping|shed|gain|gaining|put on|cut)\s+(?:about |around |like |another )?\d{1,3}(?:\.\d+)?\s*(?:lbs?|pounds?|kgs?|kilos?|kilograms?)\b/;

const isKg = (unit: string | undefined) => !!unit && /^k/.test(unit);

function extractPace(norm: string, out: PlanFastPathFacts): void {
  const match = PACE_SPAN.exec(norm);
  if (!match || negatedBefore(norm, match.index)) return;
  const raw = match[1].replace(/\s+a$/, "");
  const amount = /^\d/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  if (!Number.isFinite(amount) || amount <= 0 || amount > 5) return;
  const lb = isKg(match[2]) ? amount / KG_PER_LB : amount;
  out.requestedPaceLbPerWeek = Math.round(lb * 10) / 10;
  out.confidence.requestedPaceLbPerWeek = PLAN_HIGH;
}

function extractTarget(norm: string, out: PlanFastPathFacts): void {
  const match = TARGET_SPAN.exec(norm);
  if (!match || negatedBefore(norm, match.index)) return;
  const value = Number(match[1]);
  const kg = isKg(match[2]) ? value : value * KG_PER_LB;
  if (kg < 30 || kg > 300) return;
  out.targetWeightKg = Math.round(kg * 10) / 10;
  out.confidence.targetWeightKg = match[2] ? PLAN_HIGH : PLAN_GHOST;
}

/** The plan answers in one utterance, each with its own band. Never throws. */
export function extractPlanFastPath(norm: string): PlanFastPathFacts {
  const out: PlanFastPathFacts = { confidence: {} };
  if (typeof norm !== "string" || norm.length === 0) return out;
  extractWeekdays(norm, out);
  extractMeals(norm, out);
  extractFirstMeal(norm, out);
  extractPace(norm, out);
  extractTarget(norm, out);
  return out;
}

/**
 * The text with every pace, goal-weight and change-amount span struck, so the body readers never
 * read "lose 30 pounds" or "get down to 180 lb" as the current weight.
 */
export function withoutPlanSpans(norm: string): string {
  let out = norm;
  for (const pattern of [PACE_SPAN, TARGET_SPAN, CHANGE_SPAN]) {
    out = out.replace(new RegExp(pattern.source, "g"), " ");
  }
  return out;
}
