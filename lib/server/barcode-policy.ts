/**
 * What the policy is shown about a scanned product — the one place that decides it, for a match
 * read back out of the catalog and for a match built from the draft this request just wrote.
 *
 * Its own file so lib/server/barcode.ts stays under 400 lines, and one function on purpose: the
 * two paths answering differently is a real bug, not a cosmetic one — the same product read one
 * way said "not checked" and read the other said "fine to eat" (panel round 10, item 4). Every
 * rule about what the policy is shown therefore lives here, once.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  labelEvidence, mergeStoredEvidence, namedAllergenHints, withCrustaceanAllowance,
  type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { readAllergenChecks, readAllergenEvidence } from "@/lib/server/allergen-evidence";
import { policyCategoriesOf } from "@/lib/server/catalog";

export function policyEvidence(input: {
  foodRefId: string;
  prefStatus: "eats" | "avoid" | null;
  description: string;
  category: string | null;
  policyCategories: string[] | null | undefined;
  qualityFlags: string[];
  ingredientCount: number;
  allergenTags: string[];
}) {
  // finding #8: an empty allergenTags array can mean "confirmed no allergen" or "the text scan
  // missed non-English/vocabulary-gap ingredient text" — off-map.ts flags the latter case so it
  // reads as unconfirmed (null) rather than a false "allowed".
  const unconfirmedTextScan = input.allergenTags.length === 0 &&
    input.qualityFlags.includes("allergens_text_unconfirmed");
  return {
    foodRefId: input.foodRefId,
    allergenTags: input.ingredientCount > 0 && !unconfirmedTextScan ? input.allergenTags : null,
    // An un-annotated revision is judged by the mapper, not read as "none banned" — see
    // policyCategoriesOf in lib/server/catalog.ts.
    category: policyCategoriesOf(input.policyCategories,
      { description: input.description, category: input.category }),
    onEatsList: input.prefStatus === "eats",
    onAvoidList: input.prefStatus === "avoid",
  };
}

/**
 * Phase 13 §5: a scanned product's allergen evidence is read off its own ingredient list (complete
 * when it reads as a full English list), merged with this revision's STORED evidence
 * (food_allergen_evidence — a prior warm, possibly Jev-backed), plus this user's checks of that
 * exact revision.
 *
 * The merge matters: stored evidence can carry a `listed` this scan's own keyword-only read of
 * the label never sees (a synonym the fixed word list misses, later confirmed by Jev). Reading
 * only the live label here would let the barcode card and a coach attachment built from it answer
 * differently from search and the food detail sheet, which both merge the stored row — the same
 * two-paths-disagree bug this file's own header warns about.
 */
export type ScannedAllergenSources = {
  checks: Map<string, string[]>;
  stored: Map<string, Record<string, StoredAllergenEvidence>>;
};

/**
 * The two DB reads `scannedAllergenFacts` needs for one revision — split out from the profile-
 * dependent merge below it, so a caller that also needs `loadUserProfile` (which only the merge
 * step needs) can start every read in the SAME `Promise.all`, profile included, instead of
 * awaiting profile first (sol FIX, review round 1: coach-attachments.ts's `barcodeDraft` had
 * awaited `loadUserProfile` on its own before this Promise.all, turning two sequential DB waves
 * into three on the coach barcode-attachment hot path). Neither read here touches `profile`.
 */
export async function readScannedAllergenSources(
  client: SupabaseClient, userId: string, revisionId: number,
): Promise<ScannedAllergenSources> {
  const key = `catalog_revision:${revisionId}`;
  const [checks, stored] = await Promise.all([
    readAllergenChecks(client, userId, [key]),
    readAllergenEvidence(client, [key]),
  ]);
  return { checks, stored };
}

/**
 * The merge `scannedAllergenFacts` does once its two reads and the profile are all in hand — pure
 * and synchronous, so deferring it until `profile` resolves costs nothing.
 */
export function mergeScannedAllergenFacts(
  profile: ConstraintProfile, revisionId: number, ingredientsText: string | null,
  tags: readonly string[], sources: ScannedAllergenSources,
  /**
   * ORCHESTRATOR RULING (round 7), condition (a): true only when `ingredientsText` is the
   * revision's own single verbatim printed statement (lib/foods/catalog-ingredients.ts
   * completenessText's own flag) — never a joined fallback. Defaults to true for the direct
   * scanned-label callers this function predates.
   */
  verbatim = true,
): { allergenEvidence: Record<string, StoredAllergenEvidence>; checkedAllergens: string[];
  ingredientsText: string | null; ingredientsTextIsLabel: boolean } {
  const key = `catalog_revision:${revisionId}`;
  // r4 BLOCK #2: mergeStoredEvidence only merges the keys `live` already has, so `live` must
  // include `crustacean` whenever `shellfish` is avoided — otherwise a stored crustacean `listed`
  // (a legacy tag, an earlier warm) this scan's own text does not happen to repeat is silently
  // dropped instead of merged. See constraints.ts's own withCrustaceanAllowance for the matching
  // finding stage.
  const live = labelEvidence(withCrustaceanAllowance(profile.avoid_allergens), ingredientsText, tags,
    { verbatim });
  const allergenEvidence = mergeStoredEvidence(live, sources.stored.get(key) ?? {});
  // bug repro (round 13, item 1): this `verbatim` flag decided the merge above correctly, but never
  // reached the caller's own evaluatePolicy call, whose allergenFinding independently re-derives
  // live evidence from `ingredientsText` alone and defaults ITS OWN verbatim to true when unset —
  // silently re-clearing exactly what the merge above just correctly left `no_evidence`. Carrying
  // it through as `ingredientsTextIsLabel` (the field PolicyEvidence already defines for this) lets
  // every caller that spreads `...facts` into evaluatePolicy stop guessing.
  return {
    allergenEvidence, checkedAllergens: sources.checks.get(key) ?? [], ingredientsText,
    ingredientsTextIsLabel: verbatim,
  };
}

export async function scannedAllergenFacts(
  client: SupabaseClient, userId: string, profile: ConstraintProfile, revisionId: number,
  ingredientsText: string | null, tags: readonly string[], verbatim = true,
): Promise<{ allergenEvidence: Record<string, StoredAllergenEvidence>; checkedAllergens: string[];
  ingredientsText: string | null; ingredientsTextIsLabel: boolean }> {
  const sources = await readScannedAllergenSources(client, userId, revisionId);
  return mergeScannedAllergenFacts(profile, revisionId, ingredientsText, tags, sources, verbatim);
}

/**
 * bug repro (round 13, item 2): a scanned barcode's `allergenTags` used to come from the revision's
 * structured `allergen_tags` column alone — a later ingredient row parsed to a NAME with no tag of
 * its own (e.g. a split-off "peanut" row) was invisible to the policy check even though search and
 * detail (lib/server/catalog.ts) already scan parsed names for exactly this signal. Shares
 * `namedAllergenHints` (lib/policy/allergens.ts) with those two callers rather than a second copy:
 * it only ever ADDS `listed`, never certifies completeness, so combining it with the stored tags is
 * safe the same way it is there.
 */
export function scannedAllergenTags(
  ingredients: readonly { name: string; allergen_tags?: readonly string[] | null }[],
  avoidAllergens: readonly string[],
): string[] {
  const tags = ingredients.flatMap((i) => i.allergen_tags ?? []);
  const nameHints = namedAllergenHints(ingredients.map((i) => i.name).join(", "), avoidAllergens);
  return [...new Set([...tags, ...nameHints])];
}

