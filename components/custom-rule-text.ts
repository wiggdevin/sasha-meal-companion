/**
 * Client-side checks for a custom food rule's text, shared by Foods › Avoids (components/AvoidRules.tsx)
 * and onboarding's composer (components/Onboarding/DietaryProfilePicker.tsx) so the two cannot drift.
 */

export const MAX_RULE_LENGTH = 80;
/** Words that make the text a sentence or a clause rather than one food's name. */
const NOT_A_NAME = new Set([
  "i", "i'm", "im", "my", "me", "we", "our", "you",
  "no", "not", "never", "avoid", "avoiding", "without", "except", "unless", "only", "if", "when", "because",
  "don't", "dont", "can't", "cant", "cannot", "won't", "shouldn't",
  "allergic", "allergy", "allergies", "intolerant", "intolerance", "sensitive", "sensitivity",
  "reaction", "reactions", "react", "reacts",
  "eat", "eats", "eating", "ate", "is", "are", "am", "be", "get", "gets", "feel", "feels",
  "cause", "causes", "causing", "trigger", "triggers", "make", "makes", "give", "gives",
  "upset", "upsets", "bother", "bothers", "hate", "hates", "dislike", "like",
  "containing", "contains", "contain", "with", "anything", "everything", "something", "any", "all",
  "to", "from", "and", "or", "less", "than", "under", "over",
]);
/** Intent words also refused inside a hyphenated word ("avoid-garlic"). Kept narrow because real
 *  names join common words with hyphens ("all-purpose flour", "ready-to-eat meals"). */
const HYPHENATED_INTENT = new Set([
  "avoid", "avoiding", "without", "never", "allergic", "allergy", "allergies",
  "intolerant", "intolerance", "sensitive", "sensitivity", "reaction",
]);
/** Standalone diet labels: "free" or "-free" ending the text ("gluten free", "sugar-free"), and a
 *  two-word "low …" / "high …" ("low sugar"). A label that modifies a named food keeps it
 *  ("gluten-free bread", "low sodium soy sauce"). */
const LEVELS = new Set(["low", "high"]);
/** A name holds letters, digits, spaces, hyphens and apostrophes only; anything else (commas,
 *  slashes, bullets, pipes, dashes, sentence periods) separates a list or ends a clause. A short
 *  abbreviation's period ("St. John's wort") is allowed. */
const NAME_CHARACTERS = /^[\p{L}\p{M}\p{N}' -]+$/u;
const ABBREVIATION = /(^|\s)[a-z]{1,3}\.(?=\s)/gi;

/** An exclusion matches only its whole text (lib/policy/custom-rules.ts matchesRule), so a phrase
 *  ("allergic to garlic"), a list ("garlic, onion") or a clause ("garlic causes hives") saved as
 *  one would block nothing: exclusions must be one food's name. Words split on spaces, so
 *  "free-range eggs" and "crème fraîche" pass. */
export function isLiteralName(text: string): boolean {
  const normal = text.normalize("NFKC").toLocaleLowerCase("en")
    .replace(/[\u2010\u2011]/g, "-").replace(/\u2019/g, "'");
  if (!NAME_CHARACTERS.test(normal.replace(ABBREVIATION, "$1"))) return false;
  const words = normal.split(/\s+/).filter(Boolean);
  if (words.length === 2 && LEVELS.has(words[0])) return false;
  const last = words.at(-1) ?? "";
  if (last === "free" || last.endsWith("-free")) return false;
  return words.every((word) => !NOT_A_NAME.has(word)
    && word.split("-").every((part) => !HYPHENATED_INTENT.has(part)));
}

/** The text checks the server's rule validation makes (lib/policy/custom-rules.ts isCustomRule). */
export function isSavableText(text: string): boolean {
  return [...text].length >= 2 && text.length <= MAX_RULE_LENGTH && !/[\u0000-\u001f\u007f]/u.test(text);
}

export const LITERAL_NAME_MESSAGE =
  "Enter one literal ingredient or cuisine name per rule. Save a full sentence or a list as guidance only.";
