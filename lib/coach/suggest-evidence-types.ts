import type { FoodFacetJudgments } from "@/lib/foods/facets";
import type { StoredAllergenEvidence } from "@/lib/policy/allergens";
import type { FacetOutcome } from "@/lib/policy/facet-rules";

export type StoredMealRole = "protein" | "carb" | "fat";
export type SuggestionFoodEvidence = {
  allergenTags: string[] | null;
  /** Phase 13 §5: stored evidence per allergen for this revision, and this user's checks. */
  allergenEvidence?: Readonly<Record<string, StoredAllergenEvidence>>;
  checkedAllergens?: readonly string[];
  ingredientsText?: string | null;
  /** Whether `ingredientsText` is a genuine label, not a custom food's own text. */
  ingredientsTextIsLabel?: boolean;
  foodName?: string | null;
  /** 2026-10-02: the food's own brand, for lib/policy/whole-foods.ts's whole-food clearance. */
  foodBrand?: string | null;
  /**
   * 2026-10-02 DeepSeek audit (F2, MED): true for a branded/OFF catalog row or a stored
   * "label_scan" user food — packaged by definition, whether or not `foodBrand` above is set.
   */
  packaged?: boolean;
  policyCategories: string[] | null;
  facets: FoodFacetJudgments;
  /** Phase 18 W2c: a verified bundled starter's curated outcomes (lib/foods/starter-evidence.ts),
   *  the only facet-shaped evidence a rule decision reads. */
  attestedFacets?: Readonly<Partial<Record<string, FacetOutcome>>>;
  noCook: boolean | null;
  onEatsList: boolean;
  onAvoidList: boolean;
  role: StoredMealRole | null;
};
