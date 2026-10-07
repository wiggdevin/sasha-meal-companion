/**
 * A skip_slot is applied only as the answer to a skip the coach OFFERED, with preview_skip's
 * numbers, on an earlier turn, and only after the person's explicit yes (2026-10-03 audit, MAJOR 4).
 * The prompt already says so; this is the server holding the model to it. A skip_slot emitted in
 * the turn that ran preview_skip is the offer turn itself, and one with no offer before it, or no
 * yes in the person's reply, is dropped with one sentence instead of clearing a meal.
 *
 * Re-audit r1 #2: an offer is a question (or "I can skip …" in a message that ends in one) with no
 * negation in front of the skip ("Don't skip Meal 2." is advice, not an offer). A yes is a reply
 * that leads with a yes and does not take it back ("yeah no", "yes, but…"), does not lead with a
 * bare "please" ("Please log a chicken salad"), and names no other meal.
 *
 * restore_slot is not gated: it only brings a skipped meal back, and Undo covers it.
 *
 * Pure. No I/O.
 */

import type { CoachAction } from "@/lib/coach/actions";
import { slotName } from "@/lib/coach/actions/copy";

/** The reply starts with a yes, or with the offer's own "Skip and rebalance" choice. */
const YES = /^\W*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please\s+do|do it|go ahead|sounds good|confirm(?:ed)?|skip(?:\s+(?:it|that|and|meal|dinner|lunch|breakfast|supper)\b)?)\b/i;
/** A yes that is really a no ("yes, leave it", "sure, don't skip", "yeah no", "yes but wait"). */
const BUT_NO = /\b(?:don['’]?t|do not|leave (?:it|my plan)|keep (?:it|my plan)|no skip|no(?! (?:problem|worries)\b)|nope|nah|not|but|instead|wait|cancel)\b/i;
/** Meal words a reply may use for a slot; one the offer never used names a different meal. */
const MEAL_WORDS = /\b(?:breakfast|lunch|dinner|supper)\b/gi;
/** Words in front of a skip that turn it into advice against skipping. */
const NEGATED = /\b(?:don['’]?t|do not|not|never|no need to|won['’]?t|wouldn['’]?t|shouldn['’]?t|can['’]?t|cannot|rather not|avoid|instead of)\b/i;
/** Words in front of a skip that make a statement into an offer. */
const OFFER_VERB = /\b(?:I can|I could|I['’]ll|I will|I['’]d|let me|want me to|shall I|should I|happy to)\b/i;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

/** Whether the reply names a meal other than `slot` ("skip lunch" after a dinner offer). */
function namesOtherMeal(text: string, slot: string, offer: string | null): boolean {
  const own = slotName(slot).toLowerCase();
  for (const match of text.matchAll(/\bmeal\s*(\d)\b/gi)) {
    if (`meal ${match[1]}` !== own) return true;
  }
  // Any meal word the offer did not itself use names a different meal — including when the offer
  // used no meal word at all ("Skip Meal 5…?" offers no "lunch", so "yes, skip lunch" is not a yes
  // to that offer). A reply with no meal word (a bare "yes") still confirms (2026-10-05 audit,
  // BLOCKER 2).
  const offered = new Set([...(offer ?? "").matchAll(MEAL_WORDS)].map((m) => m[0].toLowerCase()));
  return [...text.matchAll(MEAL_WORDS)].some((m) => !offered.has(m[0].toLowerCase()));
}

export function isExplicitYes(text: string): boolean {
  return YES.test(text) && !BUT_NO.test(text);
}

/** The person's reply accepts the skip of `slot` the coach offered in `offer`. */
export function confirmsSkip(text: string, slot: string, offer: string | null): boolean {
  return isExplicitYes(text) && !namesOtherMeal(text, slot, offer);
}

/**
 * Whether a coach message offered to skip THIS slot: "Want me to skip Meal 5?", "I can skip Meal 5
 * for you. Want that?". A slot named only as the one that grows ("move it into Meal 4"), a skip
 * advised against ("Don't skip Meal 2."), and a statement ("Skipping Meal 2 will leave you
 * short.") were not offered.
 */
export function offeredSkip(message: string | null, slot: string): boolean {
  if (!message) return false;
  const mention = new RegExp(`\\bskip(?:ping)?\\s+(?:your\\s+|the\\s+)?${escaped(slotName(slot))}\\b`, "i");
  const endsInQuestion = /\?\s*$/.test(message.trim());
  return message.split(/(?<=[.!?])\s+/).some((sentence) => {
    const match = mention.exec(sentence);
    if (!match) return false;
    const clause = sentence.slice(0, match.index).split(/[,;:—–]/).at(-1) ?? "";
    if (NEGATED.test(clause)) return false;
    // An offer needs an offer verb ("I can", "want me to", "should I", …) or an imperative that
    // leads the sentence ("Skip Meal 2 and move…?"). A sentence that only mentions skipping
    // ("Skipping Meal 2 will leave you short?") has neither and is a statement, not an offer
    // (2026-10-05 audit, MAJOR 3).
    const isImperative = /^skip\b/i.test(sentence.trim());
    // The imperative's own sentence must end in "?" — "Skip Meal 2. Want a snack?" is an
    // imperative statement followed by an unrelated question, not an offer, and the message-level
    // endsInQuestion must not paper over that (2026-10-06 re-audit, regression on MAJOR 3's fix).
    if (isImperative) return /\?\s*$/.test(sentence);
    if (!OFFER_VERB.test(clause)) return false;
    return /\?\s*$/.test(sentence) || endsInQuestion;
  });
}

export type SkipGateInput = {
  actions: CoachAction[];
  /** The person's message this turn. */
  userText: string;
  /** The coach's last message before it, from the thread history. */
  lastCoachMessage: string | null;
  /** Whether preview_skip ran in THIS turn (this turn is the offer). */
  previewedThisTurn: boolean;
};

export const SKIP_NOT_CONFIRMED =
  "I have not skipped that meal. I skip one only after you say yes to the skip I offer with its numbers.";

/** Prose that says a meal was already skipped or cleared. */
const SKIP_CLAIM =
  /(?:^\s*|\bI(?:['’]ve| have| just)?\s+|\b(?:has|have|is|was)\s+(?:been\s+|now\s+)?)(?:skipped|cleared)\b/i;

export function claimsSkip(text: string): boolean {
  return SKIP_CLAIM.test(text);
}

/** The actions with every unconfirmed skip_slot removed, and whether one was. */
export function gateSkips(input: SkipGateInput): { actions: CoachAction[]; dropped: boolean } {
  const confirmed = (action: Extract<CoachAction, { kind: "skip_slot" }>) => !input.previewedThisTurn
    && offeredSkip(input.lastCoachMessage, action.slot)
    && confirmsSkip(input.userText, action.slot, input.lastCoachMessage);
  const actions = input.actions.filter((action) => action.kind !== "skip_slot" || confirmed(action));
  return { actions, dropped: actions.length !== input.actions.length };
}
