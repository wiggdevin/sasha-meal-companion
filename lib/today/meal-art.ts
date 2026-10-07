import { MEAL_ART_RULES, photoFits } from "./meal-art-rules";

/**
 * Illustrative stock/generated photo for a meal card, selected from the meal and ingredient names,
 * only when those names support the photo's subject (DESIGN.md meal card rule): a photo that shows a
 * protein needs the meal to name that protein and no other. Null — the app's own olive art
 * (components/ui/MealPhoto.tsx) — for a meal no photo fits, or no meal at all.
 */
export function illustrativeMealImage(name: string, items: readonly { name: string }[]): string | null {
  // After an edit, the actual ingredients take precedence over the old title.
  const words = (items.length > 0 ? items.map((item) => item.name).join(" ") : name).toLowerCase();
  if (!words.trim()) return null;
  for (const rule of MEAL_ART_RULES) {
    if (photoFits(rule, words)) return rule.image;
  }
  return null;
}

/** Each photo's width over its height (public/meal-art), so a card can crop it to any box and still
 *  only ever scale it evenly while the card changes shape. Generated photos all share one 1100x1467
 *  portrait frame (mealArtAspect's fallback); only the five original stock photos differ. */
const MEAL_ART_ASPECT: Record<string, number> = {
  "/meal-art/scallops.webp": 1100 / 1650,
  "/meal-art/chicken.webp": 1100 / 733,
  "/meal-art/shake.webp": 1100 / 733,
  "/meal-art/yogurt.webp": 600 / 900,
};

export function mealArtAspect(src: string): number {
  return MEAL_ART_ASPECT[src] ?? 1100 / 1467;
}
