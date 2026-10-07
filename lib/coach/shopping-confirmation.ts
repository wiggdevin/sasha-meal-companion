/**
 * The reply's own "added X to your list" sentences, taken out before the hard-rule scan (Grok and
 * DeepSeek audits, 2026-10-02, BLOCK): exempting a shopping item's NAME let the model recommend a
 * food the account avoids and add it to the list in the same reply. Only a sentence that is
 * nothing but the confirmation, once the turn's own item names are removed, is dropped; any other
 * word keeps the sentence in the scan, which then fails closed.
 */
const CONFIRMATION = new RegExp(
  "^\\W*(?:(?:done|got it|sure|okay|ok|all set)\\W+)?(?:i(?:'ve| have)?\\s+)?(?:just\\s+)?" +
  "(?:added|put)\\s+(?:(?:and|&|,|both|also)\\s*)*(?:on|to|onto)\\s+(?:your|the)\\s+" +
  "(?:shopping\\s+)?list\\W*$", "i");

/** Words that make an item name advice rather than a thing to buy. */
const ADVICE = /\b(?:safe|fine|ok|okay|good|great|healthy|allowed|recommend\w*|should|perfect|suits?|compliant|free of)\b/i;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type ActionLike = { kind: string; names?: unknown };

/** The names this turn's `add_to_shopping_list` actions put on the list, once each. */
export function shoppingItemNames(actions: readonly ActionLike[]): string[] {
  const names = actions.flatMap((action) => action.kind === "add_to_shopping_list"
    && Array.isArray(action.names) ? action.names : [])
    .filter((name): name is string => typeof name === "string" && name.trim() !== "");
  return [...new Map(names.map((name) =>
    [name.trim().toLowerCase().replace(/\s+/g, " "), name.trim()])).values()];
}

/**
 * The sentences only drop out of the scan; every item is still judged on its own (DeepSeek audit
 * round 9, HIGH): lib/server/reply-check.ts looks each one up, and checkReply below checks it
 * against the turn's evidence.
 */
export function withoutShoppingConfirmations(text: string, actions: readonly ActionLike[]): string {
  const names = shoppingItemNames(actions).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  // The names are the model's own words (Grok audit round 10): one that reads as advice, or that
  // carries sentence punctuation, keeps every sentence in the scan.
  if (names.some((name) => ADVICE.test(name) || /[.!?;:]/.test(name))) return text;
  const items = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => {
    const rest = sentence.replace(items, " ").replace(/\s+/g, " ").trim();
    return !CONFIRMATION.test(rest);
  }).join(" ");
}

/**
 * A suggestion card that only mirrors an item this turn put on the shopping list (live 2026-10-02:
 * "eggs" and "oat milk" came back as cards beside the add). The scan judges every shopping item
 * itself (lib/server/reply-check.ts, DeepSeek audit round 9), so the mirror card adds nothing.
 */
export function withoutShoppingMirrors<T extends { name: string }>(
  suggestions: readonly T[], actions: readonly ActionLike[],
): T[] {
  const listed = new Set(shoppingItemNames(actions).map((name) => name.toLowerCase()));
  return listed.size === 0 ? [...suggestions]
    : suggestions.filter((card) => !listed.has(card.name.trim().toLowerCase()));
}

