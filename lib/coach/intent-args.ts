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

export function foodArgs(foodsMentioned: string[] | undefined): MissingArgs & { name?: string } {
  const name = foodsMentioned?.find((food) => food.trim().length > 0)?.trim();
  return name ? { name } : { missing: ["name"] };
}
