import { jevConfigured } from "@/lib/ai/provider-env";
import type { Answers, ChoiceAnswer } from "@/lib/ai/jev-types";
import { baseQuestions } from "@/lib/coach/intent-questions";
import { mayReachJev } from "@/lib/profile/taste-safety";
export { intentQuestions } from "@/lib/coach/intent-questions";
import type { Intent as BaseIntent } from "@/lib/coach/intent-types";
import type { SlotId } from "@/lib/coach/types";
import { ACTION_SPECS, actionSpecFor, type ActionIntentArgs } from "@/lib/coach/actions";
import {
  choiceConfidence, FAST_PATH_ARGUMENT_CONFIDENCE, type ExtractedNumber, type MissingArgs,
} from "@/lib/coach/intent-args";

export type { Intent } from "@/lib/coach/intent-types";
type ClassifiedIntent = BaseIntent | "show_chart";

/**
 * These are conservative launch thresholds, not permanent truth. Revisit them only after at least
 * 100 eligible production turns have privacy-safe outcome telemetry to review.
 */
export const FAST_PATH_CONFIDENCE_MUTATING = 0.95;
export const FAST_PATH_CONFIDENCE_SUGGEST = 0.90;
export { FAST_PATH_ARGUMENT_CONFIDENCE, type ExtractedNumber } from "@/lib/coach/intent-args";
export const UNSURE_FLOOR = 0.5;
export const MECHANICAL_INTENTS: readonly ClassifiedIntent[] = [
  // Deterministic composition code plus optional Jev ranking; no generative model is involved.
  "suggest_options",
  "show_chart",
  // Every action kind with a no-Gemini path: its spec's `fastPath` (lib/coach/actions/<kind>.ts).
  ...ACTION_SPECS.flatMap((spec) => (spec.fastPath ? [spec.kind as ClassifiedIntent] : [])),
];

type IntentArgs = ActionIntentArgs & {
  log_food: MissingArgs & { foodsMentioned?: string[] };
  plan_meal: MissingArgs;
  suggest_options: MissingArgs & {
    kind: "meal" | "snack" | "recipe";
    count: number;
    fitRemaining: boolean;
    slot?: SlotId;
  };
  update_profile: MissingArgs;
  set_targets: MissingArgs;
  use_shopping_list: MissingArgs;
  show_chart: MissingArgs & { chart?: "weight_trend" | "macros_today" | "kcal_week" };
  question: MissingArgs;
  other: MissingArgs;
};

type RawIntentAnswers = Answers<ReturnType<typeof baseQuestions>> & {
  which_number?: ChoiceAnswer<Record<string, string>>;
};

type IntentResultFor<I extends ClassifiedIntent> = {
  [K in I]: {
    intent: K;
    confidence: number;
    args: IntentArgs[K];
    /** Confidence for every action-determining argument; deterministic parses are recorded as 1. */
    argConfidence: Record<string, number>;
    raw: RawIntentAnswers;
  }
}[I];
export type IntentResult<I extends BaseIntent = BaseIntent> = IntentResultFor<I>;
export type ClassifiedIntentResult<I extends ClassifiedIntent = ClassifiedIntent> = IntentResultFor<I>;

const NUMBER_RE = /\b(?:half\s+an\s+hour|an\s+hour|a\s+cup|\d+(?:\.\d+)?(?:(?:\s*-\s*|\s+)(?:minutes?|mins?|min|hours?|hrs?|hr|h|cups?|ml|oz|kg|lbs?|pounds?))?)\b/gi;

function normalizedUnit(raw: string): ExtractedNumber["unit"] {
  const unit = raw.toLowerCase().replace(/^\d+(?:\.\d+)?(?:\s*-\s*|\s+)?/, "").trim();
  if (["minute", "minutes", "min", "mins"].includes(unit)) return "min";
  if (["hour", "hours", "hr", "hrs", "h"].includes(unit)) return "hour";
  if (["cup", "cups"].includes(unit)) return "cup";
  if (unit === "ml" || unit === "oz" || unit === "kg") return unit;
  if (["lb", "lbs", "pound", "pounds"].includes(unit)) return "lb";
  return null;
}

export function extractNumbers(message: string): ExtractedNumber[] {
  return Array.from(message.matchAll(NUMBER_RE), (match): ExtractedNumber => {
    const raw = match[0];
    const words = raw.toLowerCase();
    if (words === "half an hour") return { value: 30, unit: "min", raw };
    if (words === "an hour") return { value: 1, unit: "hour", raw };
    if (words === "a cup") return { value: 1, unit: "cup", raw };
    return { value: Number.parseFloat(raw), unit: normalizedUnit(raw), raw };
  });
}

function result<I extends ClassifiedIntent>(
  intent: I,
  confidence: number,
  args: IntentArgs[I],
  argConfidence: Record<string, number>,
  raw: RawIntentAnswers,
): ClassifiedIntentResult<I> {
  return { intent, confidence, args, argConfidence, raw } as ClassifiedIntentResult<I>;
}

/** A Noul is a probability, so certainty is its distance from the undecided middle. */
function noulConfidence(answer: { noul?: number } | undefined): number {
  const value = answer?.noul;
  return typeof value === "number" ? Math.max(value, 1 - value) : 0;
}

function chartArgs(message: string): IntentArgs["show_chart"] {
  if (/\b(?:weight|weigh[- ]?in|body mass)\b/i.test(message)) return { chart: "weight_trend" };
  if (/\bmacros?\b/i.test(message)) return { chart: "macros_today" };
  if (/\b(?:week|weekly|calories|kcal)\b/i.test(message)) return { chart: "kcal_week" };
  return { missing: ["chart"] };
}

function namesSlot(message: string, slot: SlotId): boolean {
  const pattern: Record<SlotId, RegExp> = {
    coffee: /\bcoffee\b/i,
    "pouches-pre": /\b(?:pre[- ]training(?: carbs?)?|pouches?)\b/i,
    "post-refuel": /\b(?:post[- ](?:training|workout)(?: refuel)?|refuel)\b/i,
    "meal-1": /\b(?:meal\s*(?:1|one)|first meal|breakfast)\b/i,
    "meal-2": /\b(?:meal\s*(?:2|two)|second meal|lunch)\b/i,
    "meal-3": /\b(?:meal\s*(?:3|three)|third meal|dinner)\b/i,
    "meal-4": /\b(?:meal[-\s]*(?:4|four)|fourth meal)\b/i,
    "meal-5": /\b(?:meal[-\s]*(?:5|five)|fifth meal)\b/i,
    "meal-6": /\b(?:meal[-\s]*(?:6|six)|sixth meal)\b/i,
    "hot-chocolate": /\bhot chocolate\b/i,
  };
  return pattern[slot].test(message);
}

export async function classifyIntent(
  message: string,
  ctx: { now: string; userId?: string; foodsMentioned?: string[] },
): Promise<ClassifiedIntentResult | null> {
  if (!jevConfigured()) return null;
  // Phase 18 W5b (D9, Sol r1 BLOCK 2): a rule, symptom or unsure taste statement never reaches Jev;
  // the turn takes the model path, as when Jev is down.
  if (!mayReachJev(message)) return null;
  const modules = await Promise.all([import("@/lib/ai/typesafe"), import("@/lib/ai/payloads")])
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "unknown import failure";
      console.warn(`[coach] intent skipped: TypeSafe module unavailable (${reason.slice(0, 200)})`);
      return null;
    });
  if (!modules) return null;
  const [typesafe, payloads] = modules;
  const numbers = extractNumbers(message);
  const answers = await typesafe.systemOne(payloads.intentPayload({
    message, now: ctx.now, numbers,
    ...(ctx.foodsMentioned ? { foodsMentioned: ctx.foodsMentioned } : {}),
  }), { userId: ctx.userId, deadlineMs: 3_000 });
  if (!answers) return null;

  const raw = answers as RawIntentAnswers;
  const intent = raw.intent.choice;
  const confidence = raw.intent.confidence;

  switch (intent) {
    case "log_food":
      return result(intent, confidence, {
        ...(ctx.foodsMentioned?.length ? { foodsMentioned: ctx.foodsMentioned } : {}),
      }, ctx.foodsMentioned?.length ? { foodsMentioned: 1 } : {}, raw);
    case "suggest_options": {
      const slot = raw.suggest_slot?.choice;
      const parsedCount = numbers.some((candidate) => candidate.unit === null
        && candidate.value === Number(raw.suggest_count.choice));
      return result(intent, confidence, {
        kind: raw.suggest_kind.choice,
        count: Number(raw.suggest_count.choice),
        fitRemaining: raw.fit_remaining.noul > UNSURE_FLOOR,
        ...(slot && slot !== "none" && namesSlot(message, slot) ? { slot } : {}),
      }, {
        kind: choiceConfidence(raw.suggest_kind),
        count: parsedCount ? 1 : choiceConfidence(raw.suggest_count),
        fitRemaining: noulConfidence(raw.fit_remaining),
        mentionsSpecificFoods: noulConfidence(raw.mentions_specific_foods),
        mentionsSize: noulConfidence(raw.mentions_size),
        ...(slot && slot !== "none" && namesSlot(message, slot) ? { slot: 1 } : {}),
      }, raw);
    }
    case "show_chart": {
      const args = chartArgs(message);
      return result(intent, confidence, args, args.chart ? { chart: 1 } : {}, raw);
    }
    case "update_profile":
    case "set_targets":
    case "plan_meal":
    case "question":
    case "other":
      return result(intent, confidence, {}, {}, raw);
    default: {
      // Every other intent is an action kind whose spec reads its own arguments.
      const read = actionSpecFor(intent)?.intent?.extract({
        numbers, raw, ...(ctx.foodsMentioned ? { foodsMentioned: ctx.foodsMentioned } : {}),
      }) ?? { args: {}, argConfidence: {} };
      return result(intent, confidence, read.args as IntentArgs[typeof intent], read.argConfidence, raw);
    }
  }
}

const SUGGESTION_SIZE_RE = /\b(?:small|light|large|big|mini|single|double|half[- ]size|\d+(?:\.\d+)?\s*(?:kcal|calories?|g|grams?|oz|ounces?|servings?))\b/i;
const SPECIFIC_SUGGESTION_RE = /^\s*(?:(?:please\s+)?(?:suggest|make|give|build)(?:\s+me)?\s+)?(?:a|an)\s+(?!(?:meal|snack|recipe|few|couple)\b)/i;

function suggestionHasWish(value: IntentResult<"suggest_options">, message: string): boolean {
  // The shared recipe catalog accepts a dish query directly. A named dish is the input to this
  // read-only search, unlike composed meal wishes that need another model turn to interpret.
  if (value.args.kind === "recipe") return false;
  return (value.raw.mentions_specific_foods?.noul ?? 0) > UNSURE_FLOOR
    || (value.raw.mentions_size?.noul ?? 0) > UNSURE_FLOOR
    || SUGGESTION_SIZE_RE.test(message)
    || SPECIFIC_SUGGESTION_RE.test(message);
}

export function isFastPathEligible(value: ClassifiedIntentResult, message = ""): boolean {
  return MECHANICAL_INTENTS.includes(value.intent)
    && value.confidence >= (value.intent === "suggest_options" || value.intent === "show_chart"
      ? FAST_PATH_CONFIDENCE_SUGGEST : FAST_PATH_CONFIDENCE_MUTATING)
    && minArgumentConfidence(value) >= FAST_PATH_ARGUMENT_CONFIDENCE
    && !(value.args.missing?.length)
    && (value.intent !== "suggest_options" || !suggestionHasWish(value, message));
}

export function minArgumentConfidence(value: ClassifiedIntentResult): number {
  const confidences = Object.values(value.argConfidence ?? {});
  return confidences.length === 0 ? 1 : Math.min(...confidences);
}

export type IntentFallbackReason = "none" | "below_threshold" | "missing_arg" | "grounding"
  | "jev_down" | "clarifying";

export function intentFallbackReason(value: ClassifiedIntentResult, message = ""): IntentFallbackReason {
  if (!MECHANICAL_INTENTS.includes(value.intent)) return "clarifying";
  if (value.args.missing?.length) return "missing_arg";
  const threshold = value.intent === "suggest_options" || value.intent === "show_chart"
    ? FAST_PATH_CONFIDENCE_SUGGEST : FAST_PATH_CONFIDENCE_MUTATING;
  if (value.confidence < threshold || minArgumentConfidence(value) < FAST_PATH_ARGUMENT_CONFIDENCE) {
    return "below_threshold";
  }
  if (value.intent === "suggest_options" && suggestionHasWish(value, message)) return "clarifying";
  return "none";
}

export function hintLine(value: ClassifiedIntentResult): string {
  const detail = Object.entries(value.args).map(([key, item]) =>
    `${key}=${Array.isArray(item) ? item.join("|") : String(item)}`);
  return `Likely intent: ${value.intent} (${value.confidence.toFixed(2)})${
    detail.length ? `, ${detail.join(", ")}` : ""
  }.`;
}
