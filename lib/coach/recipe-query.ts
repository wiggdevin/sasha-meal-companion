import type { RecipeSearch } from "@/lib/recipe-catalog/types";
import { parseOccasionPhrase } from "@/lib/meals/occasion-phrase";

/** Effort phrases. One source for both the effort filter and the exclusion check, so "without
 *  any cooking" is read as no-cook, never as a one-off ingredient exclusion (audit 2026-10-01). */
const NO_COOK = String.raw`\b(?:(?:with\s+)?no[- ]cook(?:ing)?|without\s+(?:any\s+|needing\s+to\s+|having\s+to\s+)?cook(?:ing)?)\b`;
const MINIMAL_COOK = String.raw`\b(?:minimal|little|without\s+much)\s+cooking\b`;

/**
 * Extract only filters the shared service accepts; never treat an exclusion as optional. The meal
 * the request names ("salmon for a late dinner", "easy breakfast") is not a dish term: the shared
 * parser (lib/meals/occasion-phrase.ts) takes the whole phrase out and it becomes the search's
 * occasion, which ranks that meal's recipes first and filters nothing (Phase 17 O4, acceptance
 * 10). A meal word inside a dish name stays in the query ("breakfast burrito for dinner").
 */
export function recipeSearchFromWish(wish: string, count = 3): {
  search: RecipeSearch; unsupportedExclusion: boolean;
} {
  const effort = new RegExp(NO_COOK, "i").test(wish) ? "none" as const
    : new RegExp(MINIMAL_COOK, "i").test(wish) ? "minimal" as const : undefined;
  const rest = wish.replace(new RegExp(NO_COOK, "gi"), " ").replace(new RegExp(MINIMAL_COOK, "gi"), " ");
  const unsupportedExclusion = /\b(?:without|excluding|exclude|leave out)\b/i.test(rest)
    || /\b(?:with\s+no|but\s+no|no)\s+(?!time\b|preference\b|preferences\b)[a-z][\w-]*(?:\s+[a-z][\w-]*)?\b/i.test(rest);
  const time = /\b(?:under|within|in|less than|at most)\s+(\d{1,3})\s*(?:minutes?|mins?)\b/i.exec(wish);
  const { occasion, rest: dish } = parseOccasionPhrase(rest);
  const cuisine = /\b(italian|mexican|indian|thai|japanese|chinese|korean|french|greek|mediterranean|vietnamese)\b/i.exec(wish)?.[1]?.toLowerCase();
  const query = dish.replace(/\b(?:under|within|in|less than|at most)\s+\d{1,3}\s*(?:minutes?|mins?)\b/gi, " ")
    .replace(/\b(?:can you|could you|would you|i can eat|i could eat|i want|that i can eat|that i could eat)\b/gi, " ")
    .replace(/\b(?:find|search|look|show|suggest|give|me|you|can|could|would|i|eat|want|like|a|an|some|recipe|recipes|for|please|amazing|good|great|tasty|ideas?|that|to)\b/gi, " ")
    .replace(/\b(?:italian|mexican|indian|thai|japanese|chinese|korean|french|greek|mediterranean|vietnamese)\b/gi, " ")
    .replace(/[,:;]+/g, " ").replace(/\s+/g, " ").trim();
  return { search: { query, limit: Math.min(3, count),
    ...(time ? { maxMinutes: Number(time[1]) } : {}), ...(effort ? { effort } : {}),
    ...(cuisine ? { cuisine } : {}), ...(occasion ? { occasion } : {}) },
    unsupportedExclusion };
}
