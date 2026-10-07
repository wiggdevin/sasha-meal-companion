/**
 * The fast path's own copy and its one mechanical mapping: an eligible Jev intent becomes a
 * grounded action without Gemini, and the reply stays in the present tense ("Moving…") until the
 * action card carries the applied state. Each kind's `fastPath` lives in its spec.
 */

import {
  actionSpecFor, coachActionSchema, type CoachAction, type CoachActionInput,
} from "@/lib/coach/actions";
import type { ClassifiedIntentResult } from "@/lib/coach/intent";
import { NO_MEAL_FIT_MESSAGE, NOTHING_LEFT_MESSAGE } from "@/lib/coach/suggest-messages";
import type { SuggestionResult } from "@/lib/coach/suggest";

/**
 * Kinds that never take the fast path, whatever a spec says: a skip clears a meal only as the yes
 * to an offer on an earlier turn, which only the model turn's skip gate checks (re-audit r1 #3).
 */
const NEVER_FAST: ReadonlySet<string> = new Set(["skip_slot"]);

export function fastPathAction(result: ClassifiedIntentResult, today: string): CoachActionInput | null {
  if (NEVER_FAST.has(result.intent)) return null;
  const candidate = actionSpecFor(result.intent)?.fastPath?.candidate(result.args, today) ?? null;
  if (candidate === null) return null;
  const parsed = coachActionSchema.safeParse(candidate);
  return parsed.success && !NEVER_FAST.has(parsed.data.kind) ? parsed.data : null;
}

export function fastPathReply(action: CoachAction): string {
  return actionSpecFor(action.kind)?.fastPath?.reply(action) ?? "That change is ready.";
}

export function fastSuggestionReply(
  kind: "meal" | "snack" | "recipe",
  fitRemaining: boolean,
  result: SuggestionResult,
): string {
  const composed = [...result];
  // A message-only result IS the reply: no saved foods, no target for the day, or an expired
  // budget. The nothing-left sentence is the copy for a target with no calories left in it, not a
  // stand-in for "nothing was built" — a zero-card answer to "what should I eat for lunch?" said a
  // snack was impossible on a day with 1 700 kcal still to eat.
  if (composed.length === 0) return result.message
    ?? (kind === "snack" ? NOTHING_LEFT_MESSAGE : NO_MEAL_FIT_MESSAGE);
  if (result.partial && result.message) return result.message;
  const shortfall = composed.find((card) => card.shortfallNote)?.shortfallNote;
  if (shortfall) return shortfall;
  if (kind === "snack" && fitRemaining) {
    return `Here are ${composed.length} snacks that fit what you have left today.`;
  }
  const source = composed.every((card) => card.allItemsOnEats === true)
    ? "from your Eats list" : "built around your Eats foods";
  return `Here are ${composed.length} ${kind} options ${source}.`;
}
