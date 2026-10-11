/**
 * The pure argument readers the intent pre-pass and the action specs share: the numbers in a
 * message, which of them a Jev answer picked, and the unit conversions each mechanical action
 * needs. Split out of lib/coach/intent.ts so an action spec can read its own arguments without
 * importing the classifier.
 *
 * Pure. No I/O. It imports nothing from lib/ai: the capture flow reaches this module through the
 * action schemas and must not reach Jev code (tests/coach/sanity-integration.test.ts).
 */

export const FAST_PATH_ARGUMENT_CONFIDENCE = 0.90;

export type ExtractedNumber = {
  value: number;
  unit: "min" | "hour" | "cup" | "ml" | "oz" | "kg" | "lb" | null;
  raw: string;
};

export type MissingArgs = { missing?: string[] };

type Answer<T extends string> = { choice: T; confidence?: number };

/**
 * The Jev answers an argument reader looks at: a structural view of the coach-intent questions in
 * lib/coach/intent-questions.ts. lib/coach/intent.ts passes its full answer set here, so a change
 * to those questions that this view cannot read fails to compile there.
 */
export type IntentAnswers = {
  direction: Answer<"later" | "earlier">;
  scope: Answer<"all" | "remaining" | "one_slot">;
  which_number?: Answer<string>;
};

/** What an action spec's argument reader is handed for one classified message. */
export type IntentArgInput = {
  numbers: ExtractedNumber[];
  raw: IntentAnswers;
  foodsMentioned?: string[];
  /** The user's own words, for the deterministic day read (`statedDay`). */
  message?: string;
};

export type IntentArgOutput<A> = { args: A; argConfidence: Record<string, number> };

export function choiceConfidence(answer: { confidence?: number } | undefined): number {
  return typeof answer?.confidence === "number" ? answer.confidence : 0;
}

/** The one number in the message with a usable unit, or the one Jev picked among several. */
export function measuredNumber(
  units: readonly NonNullable<ExtractedNumber["unit"]>[],
  numbers: ExtractedNumber[],
  raw: IntentAnswers,
): { candidate: ExtractedNumber | undefined; confidence: number } {
  const candidates = numbers.filter((candidate) =>
    candidate.unit !== null && units.includes(candidate.unit));
  if (numbers.length === 1) {
    return { candidate: candidates[0], confidence: candidates.length === 1 ? 1 : 0 };
  }
  if (numbers.length < 2) return { candidate: undefined, confidence: 0 };
  const candidate = candidates.find((item) => item.raw === raw.which_number?.choice);
  return { candidate, confidence: candidate ? choiceConfidence(raw.which_number) : 0 };
}

export function minutesOf(candidate: ExtractedNumber | undefined): number | undefined {
  if (candidate?.unit === "min") return candidate.value;
  if (candidate?.unit === "hour") return candidate.value * 60;
  return undefined;
}

export function mlOf(candidate: ExtractedNumber | undefined): number | undefined {
  if (candidate?.unit === "ml") return candidate.value;
  if (candidate?.unit === "cup") return candidate.value * 240;
  if (candidate?.unit === "oz") return Math.round(candidate.value * 29.57 * 100) / 100;
  return undefined;
}

export function kgOf(candidate: ExtractedNumber | undefined): number | undefined {
  if (candidate?.unit === "kg") return candidate.value;
  if (candidate?.unit === "lb") return Math.round(candidate.value / 2.2046226218 * 100) / 100;
  return undefined;
}

/** "peanuts and shellfish", "eggs, milk", "beans & rice": more than one food, or one dish. */
const FOOD_LIST = /,|&|\+|\b(?:and|or|plus|with|also|then)\b/i;

/**
 * The one food a list-mark fast path may mark. A phrase that may name several foods, or a message
 * with several list clauses, is missing its name, so the model turn reads it and writes one mark
 * per food (audit 2026-10-10 A027): the fast path searched "peanuts and shellfish" as one name and
 * marked whichever single row ranked first.
 */
export function foodArgs(foodsMentioned: string[] | undefined): MissingArgs & { name?: string } {
  const names = (foodsMentioned ?? []).map((food) => food.trim()).filter((food) => food.length > 0);
  if (names.length !== 1 || FOOD_LIST.test(names[0])) return { missing: ["name"] };
  return { name: names[0] };
}

const WEEKDAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** Every way a message names a day; each read as an offset from today, or `null` when no fixed one. */
const DAY_WORDS: readonly { re: RegExp; offset: number | null }[] = [
  { re: /\b(?:yesterday|last\s+night)\b/i, offset: -1 },
  { re: /\btomorrow\b/i, offset: 1 },
  { re: new RegExp(`\\b${WEEKDAY}s?\\b`, "i"), offset: null },
  { re: /\b(?:\d+|a|one|two|three|four|five|six|seven)\s+(?:days?|weeks?)\s+(?:ago|from\s+now)\b/i, offset: null },
  { re: /\b(?:last|next)\s+(?:week|month)\b|\bday\s+(?:before|after)\b|\bthe\s+other\s+day\b/i, offset: null },
  { re: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\bon\s+(?:the\s+)?\d{1,2}(?:\/\d{1,2}|st|nd|rd|th)\b/i, offset: null },
  { re: new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "i"), offset: null },
];

/**
 * The day a message names (audit 2026-10-10 A024). `today`: none, or only today; `{ offset }`:
 * yesterday or tomorrow; `other`: any other day, or more than one — the model turn reads those.
 * A fast path that ignored "yesterday" logged the water, the weigh-in or the shift on today.
 */
export function statedDay(message: string): "today" | { offset: number } | "other" {
  const offsets = DAY_WORDS.filter((word) => word.re.test(message)).map((word) => word.offset);
  if (offsets.length === 0) return "today";
  if (offsets.length > 1 || offsets[0] === null) return "other";
  return /\b(?:today|tonight|this\s+morning)\b/i.test(message) ? "other" : { offset: offsets[0] };
}

/** A local `YYYY-MM-DD` date moved by whole days, on the calendar (no zone, no clock). */
export function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The date argument a dated fast-path kind reads: an allowed offset becomes `dayOffset`, any other
 * stated day is missing, so the turn takes the model path, which reads the date itself.
 */
export function dayArgs(
  message: string | undefined, allowed: readonly number[],
): { dayOffset?: number; missing?: string[]; argConfidence: Record<string, number> } {
  const day = statedDay(message ?? "");
  if (day === "today") return { argConfidence: {} };
  if (day !== "other" && allowed.includes(day.offset)) {
    return { dayOffset: day.offset, argConfidence: { date: 1 } };
  }
  return { missing: ["date"], argConfidence: {} };
}
