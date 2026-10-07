/**
 * Phase 13 slice 7 (§4 map adoption, "likes and dislikes"): deterministic detection of a soft
 * food preference in the user's own words — "I hate cilantro", "I love salmon" — the same spirit
 * as lib/coach/profile-detect.ts's synonym matcher (no model call, safe on every turn), but over
 * an open food name instead of a closed catalog-profile id, since a like or dislike can name any
 * food at all. At most one candidate per message, avoid checked before prefer so "I don't like X"
 * never also reads as "I like X" (review of AVOID_PATTERNS vs. PREFER_PATTERNS: a dislike phrase
 * never contains a bare prefer trigger word directly after "I").
 *
 * Pure: no I/O, no model call.
 */
import type { FoodPreferenceStrength } from "@/lib/policy/profiles/food-preference-rule";

export type FoodPreferenceCandidate = { foodName: string; strength: FoodPreferenceStrength };

const NAME = "([a-z][a-z '-]*)";
const AVOID_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\bi\\s+(?:can'?t|cannot|can not)\\s+stand\\s+${NAME}`, "i"),
  new RegExp(`\\bi\\s+don'?t\\s+like\\s+${NAME}`, "i"),
  new RegExp(`\\bi\\s+(?:really\\s+)?hate\\s+${NAME}`, "i"),
  new RegExp(`\\bi\\s+(?:really\\s+)?dislike\\s+${NAME}`, "i"),
];
const PREFER_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\bi\\s+(?:really\\s+)?love\\s+${NAME}`, "i"),
  new RegExp(`\\bi\\s+(?:really\\s+)?like\\s+${NAME}`, "i"),
];

// A captured name reads only up to the first clause break, so "I hate cilantro, but I love
// salmon" yields "cilantro" here, not "cilantro but i love salmon".
const CLAUSE_BREAK = /[,.!?;]| but | and | though | because | when | while | for /i;
const MAX_NAME_CHARS = 40;

function trimPhrase(raw: string): string {
  const cut = raw.search(CLAUSE_BREAK);
  const phrase = (cut === -1 ? raw : raw.slice(0, cut)).trim().replace(/\s+/g, " ");
  return phrase.slice(0, MAX_NAME_CHARS).trim();
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (!found) continue;
    const phrase = trimPhrase(found[1]);
    if (phrase.length >= 2) return phrase;
  }
  return null;
}

/** The first like/dislike the message states, or null — never a guess at a food the user did not
 *  actually name (mirrors detectProfileCandidates' own "never inferred" rule). */
export function detectFoodPreference(text: string): FoodPreferenceCandidate | null {
  const avoided = firstMatch(text, AVOID_PATTERNS);
  if (avoided) return { foodName: avoided, strength: "avoid" };
  const preferred = firstMatch(text, PREFER_PATTERNS);
  return preferred ? { foodName: preferred, strength: "prefer" } : null;
}
