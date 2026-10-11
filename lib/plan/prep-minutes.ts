/**
 * Prep minutes for a generated plate, from a small curated component table ("Ready in 15 min").
 * The meal engine has no time data of its own; recipes carry `recipe_catalog.total_minutes`, a
 * generated plate does not. This table gives each component a typical hands-on-plus-cook time.
 *
 * Assumptions, stated so they can be argued with:
 *  - The quick, common method: eggs scrambled or fried, oats as instant porridge, frozen or fresh
 *    vegetables steamed or sautéed, canned beans and fish opened and warmed, bread toasted.
 *  - Words in the food's name decide; the first matching row wins, so specific rows ("instant
 *    rice", "rotisserie chicken", "canned salmon") sit above general ones ("rice", "chicken",
 *    "salmon"). "Cooked" in a catalog name describes the nutrition, not a ready-made food, and is
 *    not read.
 *  - A food marked no-cook by the person is 0 minutes, whatever its name.
 *  - Components cook side by side: a plate takes its longest component plus 2 minutes for each
 *    other component that needs work (cutting, plating). A ready component (0-1 min) adds nothing.
 *  - A name the table does not know is UNKNOWN_MINUTES (20), so it never passes a 15-minute cut by
 *    accident: the chip under-promises rather than over-promises.
 *
 * Pure. No I/O.
 */
import type { Food } from "@/lib/foods";

export const UNKNOWN_MINUTES = 20;
/** "Ready in 15 min": the Plan sheet's quick15 chip and a "Quick meals" date (A061). */
export const QUICK_MINUTES = 15;
const EXTRA_COMPONENT_MINUTES = 2;

/** [pattern, minutes], first match wins. */
const TABLE: readonly (readonly [RegExp, number])[] = [
  // Ready to eat or pour.
  [/\b(?:oil|butter|ghee|honey|syrup|jam|salsa|vinegar|dressing|mayo(?:nnaise)?)\b/, 0],
  [/\b(?:yog(?:h)?urt|skyr|kefir|cottage cheese|ricotta|cheese|milk|protein (?:shake|powder)|whey)\b/, 1],
  [/berr(?:y|ies)\b|\b(?:apple|banana|orange|grape|pear|peach|plum|mango|melon|kiwi|cherr(?:y|ies)|pineapple|clementine|dates?|raisins?|dried fruit|fruit)\b/, 1],
  [/\b(?:almond|walnut|cashew|pecan|pistachio|peanut|nut|seed|chia|flax|hemp|trail mix)s?\b/, 0],
  [/\b(?:nut|peanut|almond) butter\b|\bhummus\b|\bavocado\b|\bolives?\b/, 1],
  [/\b(?:granola|muesli|cereal|cornflakes|crackers?|rice cakes?)\b/, 1],
  [/\b(?:rotisserie|deli|smoked salmon|lox|jerky|ham|turkey slices|sliced turkey|prosciutto)\b/, 1],
  [/\b(?:canned|tinned)\b.*\b(?:tuna|salmon|sardines?|chicken|mackerel)\b|\btuna\b|\bsardines?\b/, 2],
  [/\b(?:tortilla|wrap|pita|bagel|bread|toast|roll|bun|english muffin|naan)\b/, 3],
  [/\b(?:lettuce|salad|spinach|arugula|cucumber|tomato|carrots?|celery|bell pepper|peppers?|radish|sprouts?)\b/, 3],
  // Quick to cook.
  [/\b(?:instant|microwave|minute) (?:rice|oats|noodles)\b|\bready rice\b/, 3],
  [/\b(?:canned|tinned)\b|\b(?:chickpeas?|black beans|kidney beans|pinto beans|cannellini|beans|lentils?)\b.*\bcanned\b/, 3],
  [/\b(?:oat(?:meal|s)?|porridge)\b/, 5],
  [/\bcouscous\b/, 6],
  [/\b(?:edamame|peas|corn|green beans|broccoli|cauliflower|zucchini|courgette|mushrooms?|asparagus|kale|cabbage|bok choy|brussels sprouts|mixed vegetables|vegetables?)\b/, 7],
  [/\beggs?\b|\bomelet(?:te)?\b|\begg whites?\b/, 8],
  [/\b(?:shrimp|prawns?|scallops?)\b/, 7],
  [/\b(?:noodles|ramen|udon|soba)\b/, 8],
  [/\b(?:tofu|tempeh|paneer)\b/, 10],
  [/\b(?:cod|tilapia|haddock|pollock|white fish|halibut|trout)\b/, 10],
  [/\b(?:salmon|tuna steak|fish)\b/, 12],
  [/\b(?:ground|minced) (?:beef|turkey|chicken|pork|lamb)\b|\bmince\b/, 12],
  [/\b(?:pasta|spaghetti|penne|macaroni|fusilli|linguine)\b/, 12],
  [/\b(?:steak|sirloin|beef strips)\b/, 12],
  [/\b(?:pork chop|pork loin|pork tenderloin|lamb chop)\b/, 15],
  [/\bquinoa\b|\bbulgur\b/, 15],
  [/\bchicken breast\b|\bchicken\b/, 20],
  [/\b(?:rice|barley|farro)\b/, 20],
  [/\b(?:lentils?|dal)\b/, 20],
  [/\b(?:sweet potato|potato(?:es)?|yam)\b/, 25],
  [/\bchicken thighs?\b|\bbeef\b|\bpork\b|\blamb\b/, 25],
  [/\b(?:dried|dry) (?:beans|chickpeas)\b/, 60],
];

/** One component's minutes (0 for a food the person marked no-cook). */
export function componentMinutes(food: Pick<Food, "name" | "noCook">): number {
  if (food.noCook) return 0;
  const name = food.name.toLowerCase();
  for (const [pattern, minutes] of TABLE) if (pattern.test(name)) return minutes;
  return UNKNOWN_MINUTES;
}

/** A plate's minutes: the longest component, plus 2 for each other component that needs work. */
export function plateMinutes(foods: readonly Pick<Food, "name" | "noCook">[]): number {
  if (foods.length === 0) return 0;
  const each = foods.map(componentMinutes).sort((a, b) => b - a);
  const extra = each.slice(1).filter((minutes) => minutes > 1).length * EXTRA_COMPONENT_MINUTES;
  return each[0] + extra;
}
