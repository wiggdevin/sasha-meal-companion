/**
 * Public search and candidate ranking share these non-dish request words. Meal words are not among
 * them: the occasion parser (lib/meals/occasion-phrase.ts) has already taken out every meal word
 * that names the occasion, so one still in the query is part of a dish name and ranks like any other
 * word ("breakfast burrito for dinner" ranks Breakfast burrito above Dinner burrito; O4a round 4).
 * Search never filters on query words, so a meal word cannot empty it.
 */
const requestWords = new Set(["a", "an", "some", "the", "find", "show", "me", "recipe",
  "recipes", "for", "please", "can", "you", "could", "would", "i", "eat", "want",
  "like", "search", "look", "suggest", "give", "amazing", "good", "great", "tasty",
  "idea", "ideas", "that", "to"]);

export function dishSearchTerms(query: string): string[] {
  return searchWords(query).filter((word) => !requestWords.has(word));
}

/** Lower-case letter and digit runs: the words a recipe is indexed by and a query is read as. */
export function searchWords(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether a query word names a recipe's word: the word itself, its plural, or (3+ letters) its start. */
export function namesTerm(term: string, word: string): boolean {
  return term === word || (word.length >= 3 && term.startsWith(word))
    || (word.endsWith("es") && term === word.slice(0, -2))
    || (word.endsWith("s") && term === word.slice(0, -1));
}
