/**
 * Static, representative data for the newer composite pieces shown in `/design`
 * (app/design/DesignGallery.tsx). Pure data, no network and no device store, so the gallery stays
 * true to docs/design/KIT.md §12: these fixtures exist so each component can be mounted with
 * static props alone.
 */
import type { DocumentPlanResult } from "@/lib/plan/document-types";
import type { InspireResult } from "@/lib/plan/inspire-types";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

/** PhotoResult, plate branch: components/plan/PhotoResult.tsx. */
export const GALLERY_PLATE_RESULT: InspireResult = {
  kind: "plate",
  title: "Chicken, rice and broccoli",
  ingredients: ["chicken breast", "rice", "broccoli"],
  plate: {
    kcal: 480, protein: 42, carbs: 46, fat: 14,
    title: "Chicken, rice and broccoli",
    items: [
      { name: "Chicken breast", grams: 150 },
      { name: "Rice", grams: 180 },
      { name: "Broccoli", grams: 90 },
    ],
  },
};

/** PhotoResult, menu branch. */
export const GALLERY_MENU_RESULT: InspireResult = {
  kind: "menu",
  title: null,
  ingredients: [],
  menu: [
    { name: "Grilled salmon, greens", kcal: 520, protein: 38, carbs: 20, fat: 26,
      tip: "dressing on the side", check: null },
    { name: "Steak frites", kcal: 780, protein: 40, carbs: 55, fat: 38,
      tip: null, check: "Confirm the sauce has no dairy" },
  ],
};

/** DocumentPlan: components/plan/DocumentPlan.tsx — an uploaded 3-day plan matched to Lunch. */
export const GALLERY_DOCUMENT_PLAN: DocumentPlanResult = {
  kind: "meal_plan",
  title: "3-day reset",
  days: [
    { label: "Mon", meals: [{ name: "Oats and berries", time: "7:30 AM", foods: [{ name: "Oats", amount: "60 g" }] }] },
    { label: "Tue", meals: [{ name: "Chicken and rice", time: "12:30 PM", foods: [] }] },
    { label: "Wed", meals: [{ name: "Salmon and greens", time: "6:30 PM", foods: [] }] },
  ],
  match: {
    day: 0, meal: 0, title: "Oats and berries",
    items: [{ name: "Oats", grams: 60, foodRefId: "food-oats", catalogFoodRevisionId: null,
      kcalPer100g: 389, proteinPer100g: 17, carbsPer100g: 66, fatPer100g: 7, verdict: "allowed" }],
    left: [{ name: "Honey", amount: "1 tsp", reason: "Not in your foods yet" }],
    totals: { kcal: 320, protein: 12, carbs: 54, fat: 6 },
  },
};

const est = (value: number) => ({ status: "estimated" as const, value, sourceRevisionId: null });

/** A catalog recipe for the nutrition gallery's adopted card (the pilot's chicken skillet). */
export const GALLERY_RECIPE: RecipeCandidate = {
  sourceKind: "shared", recipeId: "gallery-skillet", revisionId: "gallery-skillet-1", publicationState: "published",
  withdrawalReason: null, name: "Chicken, carrot and quinoa skillet", cuisine: "American",
  dishTags: ["chicken", "quinoa", "dinner", "skillet"], activeMinutes: 15, totalMinutes: 25, effort: "minimal",
  servings: 3, yieldGrams: null, yieldStatus: "unknown", minServingFraction: 0.5, maxServingFraction: 2,
  ingredients: [
    { seq: 1, name: "carrots", foodRefId: "g1", catalogFoodRevisionId: 1, quantity: 300, unit: "g", grams: 300,
      state: "raw", required: true, purchaseGrams: 300, purchaseConversionStatus: "known",
      nutrition: { kcal: est(123), protein: est(3), carbs: est(29), fat: est(1) }, allergenEvidence: {} },
    { seq: 2, name: "roasted chicken breast", foodRefId: "g2", catalogFoodRevisionId: 2, quantity: 420, unit: "g", grams: 420,
      state: "cooked", required: true, purchaseGrams: 420, purchaseConversionStatus: "known",
      nutrition: { kcal: est(693), protein: est(130), carbs: est(0), fat: est(15) }, allergenEvidence: {} },
  ],
  steps: [{ seq: 1, text: "Cook the carrots in the oil for 10 minutes." }, { seq: 2, text: "Add the chicken and quinoa and heat through." }],
  nutritionPerServing: { kcal: est(508), protein: est(51), carbs: est(44), fat: est(13) },
  source: { author: "Gallery kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "gallery", sourceRevision: "1",
    kitchenTested: false },
  eligibility: { status: "eligible", reasons: [] },
};
