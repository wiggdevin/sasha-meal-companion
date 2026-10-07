/**
 * One curated universe seed: the only fields a person types for an item (Phase 18 D1). Parts,
 * roles, allergen evidence and `policy_categories` are derived (./derive.ts), never typed.
 *
 * Pure. No I/O.
 */

import type { SensoryTag } from "@/lib/foods/universe/vocabulary";

export type UniverseSeed = {
  /** The bundled food id (lib/food-db.json). */
  id: string;
  /** Its SR Legacy FoodData Central id: the `fdc_sr_legacy` catalog food's `source_id`. */
  fdcId: number;
  /** Reviewed sensory tags (vocabulary.ts). */
  sensory: readonly SensoryTag[];
  /** False for foods that season rather than feed (herbs, citrus juice): they never count toward
   *  the taste profile and never fill a plate part. */
  countable: boolean;
};

export function seed(id: string, fdcId: number, sensory: readonly SensoryTag[] = [],
  countable = true): UniverseSeed {
  return { id, fdcId, sensory, countable };
}
