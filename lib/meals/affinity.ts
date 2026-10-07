/**
 * Occasion affinity and side pairing (Phase 17). Every score carries its source.
 *
 * Affinity of an anchor at an occasion follows the evidence ladder (principle 2):
 *   explicit (O4) > the account's own history (O2, from the snapshot) > curated
 *   > calibrated Jev facets v2 (O3, from the snapshot; lib/meals/facet-affinity.ts) > neutral.
 * History that qualifies (lib/meals/history.ts: 3 distinct days in 90, recency-weighted) sets the
 * score to the larger of the history score and the curated one, with source "history": the
 * account's behaviour can make tuna a breakfast for this person, and never makes eggs less of one.
 * History never touches pairing (D6): tuna at breakfast still takes its sides from tuna's own
 * curated list, so banana stays below the floor unless curated evidence pairs them.
 *
 * Curated affinity (D6: soft, never zero):
 *   curated usual 1.0 · curated neither 0.6 · curated never 0.15 · unknown food 0.5 (neutral)
 *   An overnight ("other") slot is neutral (0.5) for every food. A slot with no known time
 *   prefers a family that suits every meal (0.8) over one some meal refuses (0.5).
 *
 * Pairing of a side with an anchor, per part and template:
 *   listed for the anchor's family 0.7–1.0 (earlier in the list is higher)
 *   the family's list for that part is empty (tuna has no fruit) 0.1 — below the floor
 *   the family has a list and this side is not on it: 0.5 if the generic table lists it, else 0.4
 *   unknown anchor family: 0.65 when the generic table lists the side, else 0.5 (neutral)
 *   a second protein: 0.8 if usual at the occasion, 0.1 if never, else 0.45
 * A plate is coherent only when every side scores at least PAIR_FLOOR.
 *
 * Pure. No I/O.
 */

import type { Food } from "@/lib/foods";
import { pairingRank } from "@/lib/coach/meal-pairings";
import { GENERIC_SIDES, type PairingFamily, type Sides } from "@/lib/meals/data/pairings";
import { CUISINE_SIDES } from "@/lib/meals/data/cuisine";
import type { Occasion } from "@/lib/meals/occasion";
import { foodKey, mealFamily, type Part } from "@/lib/meals/parts";
import type { MealEvidence } from "@/lib/meals/snapshot";
import { withFacetPrior } from "@/lib/meals/facet-affinity";
import type { TemplateKey } from "@/lib/meals/templates";

/** "facets": a calibrated Jev v2 judgment (O3, lib/meals/facet-affinity.ts), read below curated. */
export type EvidenceSource = "history" | "curated" | "facets" | "neutral";
export type Scored = { score: number; source: EvidenceSource };

export const PAIR_FLOOR = 0.3;
export const NEUTRAL = 0.5;

/** How well a food suits an occasion as the anchor of a plate, from the best evidence held. */
export function affinity(food: Food, occasion: Occasion, untimed = false,
  evidence?: MealEvidence | null): Scored {
  // Ladder (principle 2): history > curated > facets v2 (O3, only where curated is neutral) > neutral.
  const key = foodKey(food);
  const prior = withFacetPrior(curatedAffinity(food, occasion, untimed), evidence?.facets?.[key]?.[occasion],
    occasion, untimed);
  // A slot with no known time has no occasion for history to speak to.
  const own = untimed ? undefined : evidence?.history[key]?.[occasion];
  return own === undefined ? prior : { score: Math.max(own, prior.score), source: "history" };
}

/** The curated prior alone (O1): the cuisine-tagged table, else neutral. */
export function curatedAffinity(food: Food, occasion: Occasion, untimed = false): Scored {
  const family = mealFamily(food.name);
  if (!family) return { score: NEUTRAL, source: "neutral" };
  if (untimed) return { score: family.never.length === 0 ? 0.8 : NEUTRAL, source: "curated" };
  if (occasion === "other") return { score: NEUTRAL, source: "neutral" };
  if (family.usual.includes(occasion)) return { score: 1, source: "curated" };
  if (family.never.includes(occasion)) return { score: 0.15, source: "curated" };
  return { score: 0.6, source: "curated" };
}

type SidePart = Exclude<Part, "anchor" | "protein">;

function familySides(family: PairingFamily, template: TemplateKey): Sides | null {
  return family[template] ?? (template === "snack" ? family.breakfast : undefined)
    ?? family.main ?? family.breakfast ?? null;
}

function extras(familyKey: string, template: TemplateKey, part: SidePart): string[] {
  return CUISINE_SIDES.filter((row) => row.family === familyKey && row.template === template)
    .flatMap((row) => row.sides[part] ?? []);
}

/** The side words for an anchor family (or the generic table) in a template and part. */
export function sideWords(family: PairingFamily | null, template: TemplateKey, part: SidePart): string[] {
  if (!family) return [...GENERIC_SIDES[template][part], ...extras("*", template, part)];
  const own = familySides(family, template);
  const base = own ? [...own[part]] : [];
  // A family's empty list is a curated "not with this"; additions never reopen it.
  return base.length || !own ? [...base, ...extras(family.key, template, part)] : base;
}

/** A word's singular stem also names a food ("oats" names "Oatmeal, cooked"). */
function rankIn(name: string, words: readonly string[]): number {
  const rank = pairingRank(name, words);
  if (rank >= 0) return rank;
  return pairingRank(name, words.map((word) =>
    word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word));
}

/** How well a side goes with an anchor in a template. */
export function pairScore(
  anchor: Food | null, side: Food, part: Part, template: TemplateKey, occasion: Occasion,
): Scored {
  if (part === "anchor") return { score: 1, source: "curated" };
  if (part === "protein") {
    const own = mealFamily(side.name);
    if (!own) return { score: 0.45, source: "neutral" };
    if (own.never.includes(occasion)) return { score: 0.1, source: "curated" };
    return { score: own.usual.includes(occasion) ? 0.8 : 0.45, source: "curated" };
  }
  const generic = sideWords(null, template, part);
  const genericListed = rankIn(side.name, generic) >= 0;
  const family = anchor ? mealFamily(anchor.name) : null;
  if (!family || !familySides(family, template)) {
    return genericListed ? { score: 0.65, source: "curated" } : { score: NEUTRAL, source: "neutral" };
  }
  const words = sideWords(family, template, part);
  if (words.length === 0) return { score: 0.1, source: "curated" };
  const rank = rankIn(side.name, words);
  if (rank >= 0) return { score: 0.7 + 0.3 * (1 - rank / words.length), source: "curated" };
  return { score: genericListed ? 0.5 : 0.4, source: "curated" };
}
