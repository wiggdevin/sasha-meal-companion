/**
 * The shopping list's quick paths (2026-10-02): type several items at once, add a Favorite in one
 * tap, and copy the list as plain text for a store, a partner or Notes. Pure. No I/O.
 */
import { RULE_MARK_LABEL, ruleMarkReason } from "@/lib/rule-mark";
import type { ShoppingLine } from "@/lib/shopping/types";

/** One add, at most: a pasted list is welcome, a pasted essay is not. */
export const MAX_QUICK_ITEMS = 20;
const MAX_NAME = 160;
const MAX_CHIPS = 8;

const key = (name: string) => name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
/** "Eggs, large" and "eggs" are one item on a list. */
const head = (name: string) => key(name.split(",")[0] ?? name);

/** Items typed as "2 avocados, eggs; oat milk" or one per line. "and" never splits an item. */
export function parseQuickAdd(text: string, existing: readonly ShoppingLine[] = []): string[] {
  const seen = new Set(existing.map((line) => key(line.name)));
  const items: string[] = [];
  for (const raw of text.split(/[,;\n]+/)) {
    const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
    if (!name || seen.has(key(name))) continue;
    seen.add(key(name));
    items.push(name);
    if (items.length === MAX_QUICK_ITEMS) break;
  }
  return items;
}

/** How a food is cooked, cut or sized: not part of what you buy. */
const DESCRIPTOR = new RegExp("^(?:cooked|raw|fresh|frozen|drained|peeled|boiled|baked|roasted|grilled|" +
  "steamed|broiled|poached|pan-fried|large|medium|small|creamy|crunchy|chopped|sliced|diced|lower sodium|" +
  "peeled & cooked|peeled & boiled|for use on a sandwich)$", "i");

/** "Sirloin steak, cooked" is bought as "Sirloin steak"; "Fat, beef tallow" stays whole. */
export function boughtName(name: string): string {
  const segments = name.split(",").map((part) => part.trim()).filter(Boolean);
  return [segments[0] ?? "", ...segments.slice(1).filter((part) => !DESCRIPTOR.test(part))].join(", ");
}

/** Favorites not on the list yet, in the order given, named as bought. */
export function favoriteChips(favorites: readonly string[], lines: readonly ShoppingLine[]): string[] {
  const listed = new Set(lines.flatMap((line) => [key(line.name), head(line.name)]));
  const chips: string[] = [];
  for (const name of favorites) {
    const bought = boughtName(name);
    if (!bought || listed.has(key(bought))) continue;
    listed.add(key(bought));
    chips.push(bought);
    if (chips.length === MAX_CHIPS) break;
  }
  return chips;
}

function amount(line: ShoppingLine): string {
  const grams = line.buyGrams ?? line.needGrams;
  return grams === null ? "" : ` — ${Math.round(grams)} g`;
}

/** A marked line keeps its mark when the list leaves the app: " (Off your rules: …)". */
function markNote(line: ShoppingLine): string {
  return line.ruleMark ? ` (${RULE_MARK_LABEL[line.ruleMark.verdict]}: ${ruleMarkReason(line.ruleMark)})` : "";
}

/** The list as plain text: still to buy first, then what is already in the cart. */
export function listAsText(title: string, lines: readonly ShoppingLine[]): string {
  const open = lines.filter((line) => !line.checked).map((line) => `☐ ${line.name}${amount(line)}${markNote(line)}`);
  const done = lines.filter((line) => line.checked).map((line) => `☑ ${line.name}${markNote(line)}`);
  return [title, "", ...open, ...(done.length ? ["", "In cart", ...done] : [])].join("\n");
}
