/**
 * The reply's own "added X to your Favored list" sentences, taken out before the hard-rule scan,
 * the same way lib/coach/shopping-confirmation.ts takes out a shopping add's (W087).
 *
 * An Eats or Avoid mark is the person's own instruction about a food, and its grounding does not
 * hold a mark back for a blocked verdict (lib/coach/actions/food-lists.ts). In the 2026-10-17 live
 * pass the confirming sentence ("Adding Greek yogurt to your Favored list") turned the turn into a
 * re-ask that also dropped the mark, while the fast path answered the same sentence with the mark.
 *
 * Only the confirmation leaves the scan, never the food's NAME: a sentence that is anything more
 * than the confirmation once the marked names are removed ("have two slices with lunch") stays in,
 * and every other mention of the food is still judged.
 */

import { LIST_MARK_KINDS } from "@/lib/coach/actions/food-lists";

const CONFIRMATION = new RegExp(
  "^\\W*(?:(?:done|got it|sure|okay|ok|all set)\\W+)?(?:i(?:'ve|’ve| have|'m|’m| am)?\\s+)?"
  + "(?:just\\s+)?(?:now\\s+)?"
  + "(?:added|adding|put|putting|marked|marking|moved|moving|removed|removing|took|taking|taken)"
  + "\\s+(?:(?:and|&|,|both|also|back)\\s*)*(?:on|to|onto|from|off|off of|back on|back to)\\s+"
  + "(?:your|the)\\s+(?:favou?red|favou?rites|eats|avoid)(?:\\s+list)?\\W*$", "i");

/** "Greek yogurt is now on your Avoid list." */
const STATE = new RegExp(
  "^\\W*(?:(?:and|&|,|both)\\s*)*(?:is|are)\\s+(?:now\\s+)?(?:back\\s+)?(?:on|off)\\s+(?:of\\s+)?"
  + "(?:your|the)\\s+(?:favou?red|favou?rites|eats|avoid)(?:\\s+list)?(?:\\s+now)?\\W*$", "i");

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type ActionLike = { kind: string; name?: unknown };

/** A name short and plain enough to be a food's name, not a clause ("rice, then try shrimp"). */
const MAX_NAME_WORDS = 4;

/**
 * The names this turn's list marks carry, as the head before any comma: the catalog's "Greek
 * yogurt, plain" is "Greek yogurt". A raw action's name is the model's own free text, so a head
 * of more than four words, or with a digit or sentence punctuation in it, is not used at all and
 * its sentence stays in the scan. Used only to recognise a confirmation sentence or a card that
 * mirrors the mark, never to exempt a mention of the food.
 */
export function listMarkNames(actions: readonly ActionLike[]): string[] {
  const names = actions.flatMap((action) =>
    (LIST_MARK_KINDS as readonly string[]).includes(action.kind) && typeof action.name === "string"
      ? [action.name.split(",")[0]] : [])
    .map((name) => name.trim().replace(/\s+/g, " "))
    .filter((name) => name !== "" && !/[.!?;:\d]/.test(name)
      && name.split(" ").length <= MAX_NAME_WORDS);
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
}

/** The text without the sentences that only confirm this turn's Eats or Avoid marks. */
export function withoutListMarkConfirmations(text: string, actions: readonly ActionLike[]): string {
  const names = listMarkNames(actions).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const items = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => {
    if (!items.test(sentence)) return true;
    items.lastIndex = 0;
    const rest = sentence.replace(items, " ").replace(/\s+/g, " ").trim();
    return !(CONFIRMATION.test(rest) || STATE.test(rest));
  }).join(" ");
}

/** A suggestion card that only mirrors a food this turn marked: the action's own card shows it. */
export function withoutListMarkMirrors<T extends { name: string }>(
  suggestions: readonly T[], actions: readonly ActionLike[],
): T[] {
  const marked = new Set(listMarkNames(actions).map((name) => name.toLowerCase()));
  return marked.size === 0 ? [...suggestions]
    : suggestions.filter((card) => !marked.has(card.name.trim().toLowerCase()));
}
