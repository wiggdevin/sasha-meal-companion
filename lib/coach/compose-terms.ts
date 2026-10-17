import { splitWish } from "@/lib/coach/wish-negation";

/**
 * Words that are not foods. A wish is a short phrase, so a small stop list beats a parser: what
 * is left is searched, and a term the catalog does not know simply contributes nothing.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "with", "for", "of", "some", "my", "me", "give", "make", "build",
  "please", "that", "fits", "fit", "daily", "macros", "macro", "target", "targets", "recipe",
  "meal", "lunch", "dinner", "breakfast", "snack", "something", "want", "would", "like", "to",
  "in", "on", "it", "is", "can", "you", "i", "have", "has", "plus", "or", "into", "up",
  // How the meal should be, not what is in it: "High protein" searched "high" and "protein" as foods.
  "high", "low", "protein", "carb", "carbs", "fat", "fats", "healthy", "quick", "easy", "light",
  "filling", "big", "small", "kcal", "calories", "calorie", "idea", "ideas", "option",
  "grilled", "roasted", "baked", "fried", "cooked", "fresh", "spicy", "crispy", "hearty", "warm", "cold", "hot",
  "options", "today", "tonight", "now", "morning", "evening", "afternoon", "night",
]);

export const MAX_TERMS = 4;

/** The foods a wish asks for. A refused food ("no banana", "without chicken") is not one of them. */
export function wishTerms(wish: string): string[] {
  return allWishTerms(wish).slice(0, MAX_TERMS);
}

function allWishTerms(wish: string): string[] {
  const words = splitWish(wish).positive.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return [...new Set(words)];
}

/** Foods the wish named past the four-term cap (OD26): they are not searched, so the card says so. */
export function wishTermsOverCap(wish: string): string[] {
  return allWishTerms(wish).slice(MAX_TERMS);
}
