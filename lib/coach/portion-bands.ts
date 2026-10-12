/**
 * Plausible portions (2026-10-03, owner report: "Scallops 387 g", "Banana 77 g"). The composer
 * capped an item at twice its catalogue portion or 400 g, which let a lean anchor grow to whatever
 * the protein target asked for. Each food now has a band people actually serve — about one and a
 * half household servings at most: cooked meat or fish 85–250 g, eggs one to four, yogurt up to
 * about 300 g, a vegetable side 75–200 g, a spoon or so of oil — and the sizing stays inside it.
 * A large slot is met by adding a side, never by a 400 g portion.
 *
 * Also the name-only side roles the composer picks fillers by (no search needed to sort a list).
 *
 * Pure. No I/O.
 */

import { classifyWholeFood } from "@/lib/policy/whole-foods";
import { pairingFamily } from "@/lib/coach/meal-pairings";

export type SidePart = "starch" | "veg" | "fruit" | "fat";
/** "protein" is a second, smaller protein beside the anchor (yogurt beside eggs at breakfast). */
export type Part = "anchor" | "protein" | SidePart;
/** Grams: `min`/`max` bound the sizing, `typical` seeds it, `step` rounds it (an egg is 50 g). */
export type PortionBand = { min: number; max: number; typical: number; step: number };

const band = (min: number, typical: number, max: number, step = 5): PortionBand =>
  ({ min, typical, max, step });

/** `head`: the rule reads the name's head (`headOf`), not the whole name. */
type Rule = { test: RegExp; band: PortionBand; head?: true };

/**
 * The head of a lower-cased food name: the text before the first comma, without a parenthesis or
 * an "and / with / in / &" clause. "macaroni and cheese" → "macaroni", "tuna, canned in oil" →
 * "tuna", "cheese, cheddar" → "cheese". A fat or cheese band applies only when the head ENDS in
 * that word (audit 2026-10-10 A013, A017): "cheddar cheese" is cheese, "blue cheese dressing" and
 * "pizza, cheese" are not, and oil-packed fish keeps its own band.
 */
export function headOf(lower: string): string {
  return lower.split(",")[0].replace(/\(.*?\)/g, " ").replace(/\s+(?:and|with|in|&)\s.*$/, "")
    .replace(/\s+/g, " ").trim();
}

const HEAD_FAT = /\b(?:oils?|ghee|lard|butter|cheese)$/;

/** First match wins; tested against the lower-cased name, or its head for a `head` rule. */
const RULES: readonly Rule[] = [
  { test: /\b(?:oils?|ghee|lard)$/, band: band(5, 10, 15), head: true },
  { test: /\bmayo(?:nnaise)?$/, band: band(5, 15, 30), head: true },
  { test: /\b(?:almond|peanut|cashew|sunflower|nut|seed) butter\b|\btahini\b/, band: band(10, 16, 32) },
  { test: /\bbutter$/, band: band(5, 10, 15), head: true },
  { test: /\b(?:whey|casein|protein (?:powder|shake))\b/, band: band(20, 30, 50) },
  { test: /\begg whites?\b/, band: band(60, 120, 250, 10) },
  { test: /\begg(?:s)?\b(?!\s*(?:plant|noodle))/, band: band(50, 100, 200, 50) },
  { test: /\byog(?:h)?urt\b|\bskyr\b|\bquark\b/, band: band(100, 200, 300) },
  { test: /\bcottage cheese\b|\bcheese, cottage\b/, band: band(100, 200, 300) },
  { test: /\bcheese$/, band: band(15, 30, 60), head: true },
  { test: /\bsmoked salmon\b|\bsalmon, smoked\b|\blox\b/, band: band(40, 80, 120) },
  { test: /\b(?:sausages?|bacon|ham)\b/, band: band(40, 80, 120) },
  { test: /\bjerky\b/, band: band(15, 30, 60) },
  { test: /\b(?:milk|kefir)\b/, band: band(100, 250, 350, 10) },
  { test: /\bgranola\b|\bmuesli\b/, band: band(20, 45, 70) },
  { test: /\boat(?:s|meal)?\b/, band: band(30, 50, 90) },
  { test: /\b(?:bread|toast|bagel|english muffin|pita|naan|tortilla|wrap)\b/, band: band(30, 70, 120) },
  { test: /\b(?:crackers?|rice cakes?|pretzels?)\b/, band: band(15, 30, 50) },
  { test: /\b(?:almonds?|walnuts?|pecans?|cashews?|pistachios?|peanuts?|hazelnuts?|nuts|seeds?|chia|flax)\b/, band: band(10, 25, 45) },
  { test: /\bavocados?\b/, band: band(40, 75, 120) },
  { test: /\b(?:tofu|tempeh|seitan)\b/, band: band(85, 150, 250) },
  { test: /\b(?:lentils?|chickpeas?|garbanzo|beans)\b/, band: band(60, 150, 250) },
];

const DEFAULTS: Record<Part, PortionBand> = {
  // Cooked meat, fish and poultry: a deck-of-cards 85 g to a generous 250 g plate.
  anchor: band(85, 150, 250),
  protein: band(50, 100, 200),
  starch: band(50, 150, 300),
  veg: band(75, 150, 200),
  fruit: band(50, 120, 200),
  fat: band(10, 30, 50),
};

/** The band for a food in a role. A rule for the food itself wins over the role default. */
export function portionBand(name: string, part: Part): PortionBand {
  if (part === "veg") return DEFAULTS.veg;
  const lower = name.toLowerCase();
  const head = headOf(lower);
  const rule = RULES.find((row) => row.test.test(row.head ? head : lower));
  if (rule) return rule.band;
  return DEFAULTS[part];
}

/** The role an item's macros give it, read as a portion part. */
export function partFromRole(role: "protein" | "carb" | "fat"): Part {
  return role === "protein" ? "anchor" : role === "carb" ? "starch" : "fat";
}

const VEG_WORDS = /\b(?:broccoli|spinach|carrots?|cauliflower|kale|cabbage|zucchini|courgettes?|cucumbers?|lettuce|romaine|arugula|rocket|salad greens|mixed greens|greens|spring mix|pepper(?:s)?|onions?|tomato(?:es)?|celery|asparagus|green beans|string beans|snap peas|snow peas|peas|mushrooms?|brussels sprouts|bok choy|eggplant|aubergine|beets?|squash|edamame|okra|leeks?|radish(?:es)?|artichokes?|chard)\b/;
const FRUIT_WORDS = /\b(?:apples?|bananas?|oranges?|grapes?|strawberr(?:y|ies)|blueberr(?:y|ies)|raspberr(?:y|ies)|blackberr(?:y|ies)|berries|pears?|peach(?:es)?|plums?|mangos?|mangoes|pineapples?|kiwis?|kiwifruit|melons?|cantaloupe|honeydew|watermelon|cherr(?:y|ies)|nectarines?|apricots?|clementines?|tangerines?|figs?|dates|raisins|papaya)\b/;
const STARCH_WORDS = /\b(?:rice|potato(?:es)?|pasta|spaghetti|penne|noodles?|quinoa|couscous|bulgur|barley|farro|polenta|bread|toast|bagel|english muffin|pita|naan|tortillas?|wraps?|oats?|oatmeal|granola|muesli|cereal|crackers?|rice cakes?|pretzels?|corn|grits|risotto|arborio)\b/;
// Cheese and cream cheese are on the pairing table's fat lists (lib/coach/meal-pairings.ts), so
// they read as a fat side too; cottage cheese is a protein family and never reaches this line.
// Oil, butter, ghee and cheese count only as the name's head (`HEAD_FAT`): "Macaroni and cheese"
// and "Pizza, cheese" are dishes, not a cheese side (A017).
const FAT_WORDS = /\b(?:avocados?|almonds?|walnuts?|pecans?|cashews?|pistachios?|peanuts?|hazelnuts?|macadamias?|nuts|seeds?|chia|flax|tahini|olives?|(?:almond|peanut|cashew|sunflower|nut|seed) butter)\b/;
const FAT_FRUIT = /^(?:avocados?|coconuts?|olives?)\b/;
const NOT_A_SIDE = /\b(?:pouch(?:es)?|juice|soda|syrup|candy|cookies?|cake|pie|chips?|fries|ice cream|sauce|soup|ketchup|dressing)\b/;

/**
 * The side role a food's NAME gives it, or null when it is not a side (a protein, a drink, a
 * dessert). Vegetables are read first, so "Green beans" is a vegetable, not a legume starch.
 */
export function sidePartOf(name: string): SidePart | null {
  const lower = name.toLowerCase();
  if (NOT_A_SIDE.test(lower)) return null;
  if (pairingFamily(lower) && !/\bbeans\b/.test(lower)) return null;
  const label = classifyWholeFood({ foodName: name })?.label;
  if (label === "vegetables" || (VEG_WORDS.test(lower) && !STARCH_WORDS.test(lower.split(",")[0]))) {
    return "veg";
  }
  if (FAT_FRUIT.test(lower) || label === "plant oil" || label === "tree nuts" || label === "peanuts"
    || label === "seeds" || label === "sesame" || FAT_WORDS.test(lower) || HEAD_FAT.test(headOf(lower))) {
    return "fat";
  }
  if (label === "fruit" || FRUIT_WORDS.test(lower)) return "fruit";
  if (label === "grain" || label === "oats" || label === "potato" || label === "corn"
    || label === "legume" || STARCH_WORDS.test(lower)) return "starch";
  return null;
}
