/**
 * Which coach replies are notices rather than conversation (2026-10-04). The suggestion builder's
 * fixed lines (lib/coach/suggest-messages.ts) explain why there are no cards or fewer cards; the Plan
 * panel shows them in a `Notice` of the right tone instead of a bare paragraph. Anything else the
 * coach says stays its own words. Pure.
 */
import type { NoticeTone } from "@/components/ui/Notice";
import { CoachError } from "@/lib/coach-client";
import type { ComposedMeal } from "@/lib/coach/compose";
import {
  LABELS_HIDDEN_MESSAGE, NO_MEAL_FIT_MESSAGE, NO_SAVED_FOODS_MESSAGE, NO_SNACK_FIT_MESSAGE,
  NO_TARGET_SUGGEST_MESSAGE, NOTHING_LEFT_MESSAGE, REQUIRES_PREPARATION_MESSAGE,
  RULE_REVIEW_SUGGEST_MESSAGE, SUGGEST_RETRY_MESSAGE, SUGGEST_TIMEOUT_MESSAGE,
} from "@/lib/coach/suggest-messages";

const TONES: readonly [string, NoticeTone][] = [
  [LABELS_HIDDEN_MESSAGE, "attention"],
  [RULE_REVIEW_SUGGEST_MESSAGE, "attention"],
  [NO_TARGET_SUGGEST_MESSAGE, "attention"],
  [SUGGEST_RETRY_MESSAGE, "attention"],
  [SUGGEST_TIMEOUT_MESSAGE, "attention"],
  [NO_MEAL_FIT_MESSAGE, "neutral"],
  [NO_SNACK_FIT_MESSAGE, "neutral"],
  [NO_SAVED_FOODS_MESSAGE, "neutral"],
  [NOTHING_LEFT_MESSAGE, "neutral"],
  [REQUIRES_PREPARATION_MESSAGE, "neutral"],
];

/** The tone for a reply that carries one of the fixed notice lines; null for the coach's own words. */
export function replyTone(reply: string | undefined): NoticeTone | null {
  if (!reply) return null;
  return TONES.find(([line]) => reply.includes(line))?.[1] ?? null;
}

export const EMPTY_TITLE = "No ready meal options yet";
export const EMPTY_BODY = "Tap another pick or tell me what you’d like.";

/** An idea the panel may offer: grounded, inside the slot's room, and clear of the account's rules. */
export function selectable(meal: ComposedMeal): boolean {
  return meal.items.length > 0 && meal.fitsTarget && meal.flagged.length === 0 &&
    meal.items.every((item) => item.verdict === "allowed");
}

const NO_CONNECTION = "Couldn’t get meal ideas. Check your connection and try again.";
const UNAVAILABLE = "Meal ideas aren’t available right now.";

/** What a failed turn tells the person, and whether trying again can help. A request that reached
 *  the server carries its own words (a timeout, a rate limit); a 404 means the coach is switched off,
 *  so retrying cannot help; only a request that never arrived is a connection problem. */
export function planFailure(caught: unknown): { message: string; retryable: boolean } {
  if (!(caught instanceof CoachError) || caught.status === 0) return { message: NO_CONNECTION, retryable: true };
  if (caught.status === 404) return { message: UNAVAILABLE, retryable: false };
  return { message: caught.message || NO_CONNECTION, retryable: caught.status === 429 || caught.status >= 500 };
}
