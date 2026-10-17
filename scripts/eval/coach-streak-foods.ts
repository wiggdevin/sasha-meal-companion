/**
 * The coach-eval branch's catalog: every food the streak corpus names, seeded so the coach's
 * food-rule gate can reach a verdict on it (2026-10-17 live pass rerun, follow-up 1).
 *
 * The rerun's main failure was `reply_scan` holding foods back as unverified. Two causes:
 *   - every row was seeded as `fdc_branded`, which `isPackagedCatalogSource` reads as a packaged
 *     product, so even "Chicken breast, roasted" never got the plain whole-food clearance and
 *     stayed "Check the label" for gluten and apple;
 *   - spaghetti, sourdough, bacon, oatmeal and the rest were not in the branch catalog at all.
 *
 * So the rows are generic `fdc_sr_legacy` foods (no brand), and a prepared food carries a full
 * ingredient list as its label. The seed's account avoids gluten, dairy and apple; gluten and apple
 * are not FALCPA allergens, so a complete label alone cannot clear them (labels need not declare
 * them). For a prepared food that is free of them, the test user has checked the label
 * (`checked`, written to user_allergen_checks), exactly as a person does in the app. Foods that
 * contain an avoided allergen keep it in their label and stay blocked: blocked is a verdict too.
 * `tests/coach/streak-seed-foods.test.ts` holds every row to a verdict other than unverified.
 *
 * Branch seed only. Nothing here reaches production. The first seed after this change mints new
 * revision ids, so the Jev facet cache (the soy cases) needs one `scripts/warm-facets.ts --commit`
 * run on the branch afterwards; allergen and category verdicts never read it.
 */

export type StreakFood = {
  sourceId: string;
  description: string;
  role: "protein" | "carb" | "fat";
  per100g: Record<string, number>;
  list?: "eats" | "avoid";
  /** Legacy ingredient tags (catalog_ingredients.allergen_tags). */
  allergenTags?: string[];
  /** The full ingredient statement, stored as the label's verbatim text. */
  ingredients?: string;
  /** Allergens the test user has checked on this product's label (user_allergen_checks). */
  checked?: string[];
};

/** The catalog source the streak rows use: generic SR Legacy rows are not packaged products. */
export const STREAK_SOURCE = "fdc_sr_legacy";
/** The source earlier seeds used; its `streak-` rows are retired on every seed. */
export const LEGACY_STREAK_SOURCE = "fdc_branded";
export const STREAK_PREFIX = "streak-";

const m = (energy_kcal: number, protein: number, carbohydrate: number, fat_total: number) =>
  ({ energy_kcal, protein, carbohydrate, fat_total });

/**
 * The seed's avoided allergens, checked on the label of a prepared food free of all three. Gluten
 * and apple need it (labels need not declare them); dairy needs it where the label lexicon cannot
 * certify the list complete (an additive or a word it does not know).
 */
const LABEL_CHECKED = ["gluten", "dairy", "apple"];

export const STREAK_FOODS: StreakFood[] = [
  // Eats proteins.
  { sourceId: "streak-chicken", description: "Chicken breast, roasted", role: "protein",
    per100g: m(165, 31, 0, 3.6), list: "eats" },
  { sourceId: "streak-turkey", description: "Turkey breast, roasted", role: "protein",
    per100g: m(135, 30, 0, 1), list: "eats" },
  { sourceId: "streak-tuna", description: "Tuna, light, canned in water", role: "protein",
    per100g: m(116, 25.5, 0, 0.8), list: "eats",
    ingredients: "Light tuna, water, salt.", checked: LABEL_CHECKED },
  { sourceId: "streak-salmon", description: "Salmon, cooked", role: "protein",
    per100g: m(206, 22, 0, 12), list: "eats" },
  { sourceId: "streak-shrimp", description: "Shrimp, cooked", role: "protein",
    per100g: m(99, 24, 0.2, 0.3), list: "eats" },
  { sourceId: "streak-beef", description: "Sirloin steak, grilled", role: "protein",
    per100g: m(217, 27, 0, 12), list: "eats" },
  { sourceId: "streak-eggs", description: "Eggs, cooked", role: "protein",
    per100g: m(155, 12.6, 1.1, 10.6), list: "eats" },
  { sourceId: "streak-egg-whites", description: "Egg whites, cooked", role: "protein",
    per100g: m(52, 10.9, 0.7, 0.2), list: "eats" },
  { sourceId: "streak-pork", description: "Pork tenderloin, roasted", role: "protein",
    per100g: m(143, 26, 0, 3.5), list: "eats" },
  // Not on any list: the corpus adds and logs them.
  { sourceId: "streak-tofu", description: "Tofu, firm", role: "protein",
    per100g: m(144, 17.3, 2.8, 8.7),
    ingredients: "Soybeans, water, calcium sulfate.", checked: LABEL_CHECKED },
  { sourceId: "streak-smoked-tofu", description: "Smoked tofu", role: "protein",
    per100g: m(170, 19, 3, 9), ingredients: "Soybeans, water, salt.", checked: LABEL_CHECKED },
  { sourceId: "streak-greek-yogurt", description: "Greek yogurt, plain", role: "protein",
    per100g: m(97, 9, 3.9, 5), allergenTags: ["dairy"] },
  { sourceId: "streak-ground-beef", description: "Ground beef, cooked", role: "protein",
    per100g: m(217, 26, 0, 11.7) },
  { sourceId: "streak-bacon", description: "Bacon, pan-fried", role: "protein",
    per100g: m(541, 37, 1.4, 42),
    ingredients: "Pork, water, salt, sodium phosphate, sodium erythorbate, sodium nitrite.",
    checked: LABEL_CHECKED },
  { sourceId: "streak-cheddar", description: "Cheese, cheddar", role: "fat",
    per100g: m(403, 25, 1.3, 33),
    ingredients: "Pasteurized milk, cheese culture, salt, enzymes." },
  // Eats carbs and fats.
  { sourceId: "streak-rice", description: "Rice, white, cooked", role: "carb",
    per100g: m(130, 2.7, 28, 0.3), list: "eats" },
  { sourceId: "streak-sweet-potato", description: "Sweet potato, baked", role: "carb",
    per100g: m(90, 2, 20.7, 0.2), list: "eats" },
  { sourceId: "streak-banana", description: "Banana, raw", role: "carb",
    per100g: m(89, 1.1, 22.8, 0.3), list: "eats" },
  { sourceId: "streak-tortilla", description: "Corn tortilla", role: "carb",
    per100g: m(218, 5.7, 44.6, 2.9), list: "eats",
    ingredients: "Corn masa flour, water, lime.", checked: LABEL_CHECKED },
  { sourceId: "streak-avocado", description: "Avocado, raw", role: "fat",
    per100g: m(160, 2, 8.5, 14.7), list: "eats" },
  { sourceId: "streak-olive-oil", description: "Olive oil", role: "fat",
    per100g: m(884, 0, 0, 100), list: "eats" },
  // Named by the corpus and the off-plan probe, on no list.
  { sourceId: "streak-blueberries", description: "Blueberries, raw", role: "carb",
    per100g: m(57, 0.7, 14.5, 0.3) },
  { sourceId: "streak-tomato", description: "Tomatoes, raw", role: "carb",
    per100g: m(18, 0.9, 3.9, 0.2) },
  { sourceId: "streak-oats", description: "Oats, rolled, gluten-free", role: "carb",
    per100g: m(379, 13.2, 67.7, 6.5),
    ingredients: "Gluten-free whole grain rolled oats.", checked: LABEL_CHECKED },
  { sourceId: "streak-oatmeal", description: "Oatmeal, cooked with water", role: "carb",
    per100g: m(71, 2.5, 12, 1.5),
    ingredients: "Water, gluten-free whole grain rolled oats.", checked: LABEL_CHECKED },
  { sourceId: "streak-spaghetti", description: "Spaghetti, cooked", role: "carb",
    per100g: m(158, 5.8, 31, 0.9), ingredients: "Durum wheat semolina, water." },
  { sourceId: "streak-spaghetti-bolognese", description: "Spaghetti bolognese", role: "carb",
    per100g: m(151, 8.2, 18.6, 4.9),
    ingredients: "Cooked spaghetti (durum wheat semolina, water), ground beef, tomatoes, "
      + "olive oil, salt." },
  { sourceId: "streak-sourdough", description: "Bread, sourdough", role: "carb",
    per100g: m(272, 10.8, 51.9, 2.4), ingredients: "Wheat flour, water, salt." },
  { sourceId: "streak-croissant", description: "Croissant, butter", role: "carb",
    per100g: m(406, 8.2, 45.8, 21),
    ingredients: "Wheat flour, butter, water, sugar, yeast, milk, salt." },
  { sourceId: "streak-pizza", description: "Pizza, cheese", role: "carb",
    per100g: m(266, 11.4, 33, 9.7),
    ingredients: "Wheat flour, water, mozzarella cheese (milk), tomato, olive oil, yeast, salt." },
  // Two same-name rows: the C11 watermelon case marks every one of them.
  { sourceId: "streak-watermelon-a", description: "Watermelon, raw", role: "carb",
    per100g: m(30, 0.6, 7.6, 0.2) },
  { sourceId: "streak-watermelon-b", description: "Watermelon, raw", role: "carb",
    per100g: m(30, 0.6, 7.6, 0.2) },
];

/** The test account's food rules (constraint_profiles), shared with the verdict test. */
export const STREAK_RULES = {
  conditions: ["ulcerative colitis"],
  avoid_allergens: ["gluten", "dairy", "apple"],
  banned_categories: ["simple_sugars", "pouches", "ultra_processed", "onion_garlic", "legumes"],
};
