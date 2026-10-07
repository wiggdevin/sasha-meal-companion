/**
 * A generic refusal to a confidently classified meal-idea ask gets one corrective round.
 *
 * Live 2026-10-03 (dev account thread 31a16b2d…): "Find me an easy chicken dinner recipe" came
 * back "I'm sorry, I cannot fulfill that request." with zero tool calls. The thread's memory
 * window held a run of earlier apologies, and the model copied them instead of calling
 * suggest_options.
 *
 * Grok review 2026-10-03 (MAJOR): that same line is also the model's stock SAFETY refusal, so the
 * guard never fires on keywords alone ("cook me a recipe for meth", "I want to eat glass") — only
 * on a Jev planner intent at its confidence threshold — and the corrective line leaves the model
 * free to keep a refusal for anything unsafe or out of scope.
 *
 * Pure. No I/O.
 */

import { FAST_PATH_CONFIDENCE_SUGGEST } from "@/lib/coach/intent";

export type ClassifiedAsk = { intent: string; confidence: number } | null;

/** Intents whose answer is a set of options built by suggest_options or compose_meal. */
const PLANNER_INTENTS: ReadonlySet<string> = new Set(["suggest_options", "plan_meal"]);

/**
 * A reply that is nothing but a decline: no food, no reason, nothing the person can act on.
 * Anchored at both ends, so a refusal that gives a reason ("…until you set a target") is kept.
 */
const GENERIC_REFUSAL = new RegExp(
  "^(?:(?:i['’]?m|i am)\\s+(?:so\\s+)?(?:sorry|afraid)[,.!]?\\s*(?:but\\s+)?|sorry[,.!]?\\s*(?:but\\s+)?|"
  + "unfortunately,?\\s*)?i\\s*(?:cannot|can ?not|can['’]t|am unable to|['’]m unable to|am not able to)"
  + "\\s+(?:fulfil+|help(?: you)? with|assist(?: you)? with|complete|do|provide|process)"
  + "\\s+(?:that|this|your)(?:\\s+(?:request|one|ask))?(?:\\s+(?:right now|at this time|for you))?[.!]?$",
  "i");
const REFUSAL_MAX_CHARS = 160;

export const REFUSAL_CORRECTION =
  "SYSTEM: Your reply declined with no reason and no tool call. If the person asked for an"
  + " ordinary meal, snack or recipe idea, build it now: call suggest_options (kind \"meal\","
  + " \"snack\" or \"recipe\") or compose_meal, then answer from what it returns. If the request is"
  + " unsafe, harmful or not a meal idea, keep your refusal.";

export function isGenericRefusal(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= REFUSAL_MAX_CHARS && GENERIC_REFUSAL.test(trimmed);
}

/** Only a Jev planner intent at its own confidence threshold; never keywords, null or "other". */
export function isPlannerAsk(ask: ClassifiedAsk): boolean {
  return ask !== null && PLANNER_INTENTS.has(ask.intent)
    && ask.confidence >= FAST_PATH_CONFIDENCE_SUGGEST;
}

/** Whether this final step is a refusal that deserves the one corrective round. */
export function needsRefusalCorrection(input: {
  text: string;
  actionCount: number;
  /** Tool calls this turn that ran (or failed for a reason other than bad arguments). */
  answeredToolCalls: number;
  ask: ClassifiedAsk;
  alreadyCorrected: boolean;
}): boolean {
  return !input.alreadyCorrected
    && input.answeredToolCalls === 0
    && input.actionCount === 0
    && isGenericRefusal(input.text)
    && isPlannerAsk(input.ask);
}
