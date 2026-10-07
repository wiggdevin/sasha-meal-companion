/**
 * The fixed vocabularies of the Phase 18 universe (docs/specs/phase-18-open-world-foods.md D1):
 * the 12 cuisines, their tiers, the reviewed sensory tags, and the table that maps each cuisine
 * onto the six pairing groups of lib/meals/data/cuisine.ts. A manifest entry may use only these
 * words (tests/foods/universe-data.test.ts).
 *
 * The cuisine list is the one the dietary-profile research reviewed for its `cuisine` facet
 * (docs/research/dietary-profiles.draft.json), without its "none/basic ingredient" option.
 *
 * Pure data. No I/O.
 */

import type { Cuisine as PairingGroup } from "@/lib/meals/data/cuisine";

export const CUISINES = [
  "american", "latin_american", "italian", "mediterranean", "south_asian", "chinese", "japanese",
  "korean", "southeast_asian", "caribbean", "african", "european_other",
] as const;

export type CuisineKey = (typeof CUISINES)[number];

/** The words a person reads ("Mexican and Latin American"). */
export const CUISINE_LABELS: Readonly<Record<CuisineKey, string>> = {
  american: "American",
  latin_american: "Mexican and Latin American",
  italian: "Italian",
  mediterranean: "Mediterranean and Middle Eastern",
  south_asian: "Indian and South Asian",
  chinese: "Chinese",
  japanese: "Japanese",
  korean: "Korean",
  southeast_asian: "Southeast Asian",
  caribbean: "Caribbean",
  african: "African",
  european_other: "European (other)",
};

/** D1: the fixed table from a cuisine onto the pairing groups the meal engine already knows. */
export const CUISINE_PAIRING_GROUP: Readonly<Record<CuisineKey, PairingGroup>> = {
  american: "north-american-european",
  latin_american: "latin-american",
  italian: "mediterranean",
  mediterranean: "mediterranean",
  south_asian: "south-asian",
  chinese: "east-asian",
  japanese: "east-asian",
  korean: "east-asian",
  southeast_asian: "east-asian",
  caribbean: "latin-american",
  african: "global",
  european_other: "north-american-european",
};

/** How central a food is to a cuisine: a defining staple, an everyday food, or now and then. */
export const TIERS = ["core", "common", "occasional"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Reviewed sensory tags (D1). They describe how a food eats, for later taste-dislike matching
 * (W5b); none of them is a rule, and none ever reaches the policy.
 */
export const SENSORY_TAGS = [
  "soft", "slimy", "spicy_hot", "strong_fish", "bitter", "crunchy", "chewy", "pungent", "sour",
  "creamy", "gamey", "organ_meat",
] as const;
export type SensoryTag = (typeof SENSORY_TAGS)[number];
