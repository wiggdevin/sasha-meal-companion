/**
 * The curated pairing table (moved here from lib/coach/meal-pairings.ts in Phase 17 O1; the coach
 * re-exports it, so suggest_options reads the same rows). Each protein family names the starches,
 * vegetables, fats and fruit people usually eat with it, by meal template, from common Western
 * and global meal patterns (chicken with rice or potatoes and broccoli; salmon with rice and
 * asparagus; eggs with toast and spinach; Greek yogurt with berries and granola; beef with
 * potatoes or tortillas and peppers; tofu with rice and stir-fry vegetables; scallops or shrimp
 * with rice, pasta or risotto and asparagus or peas).
 *
 * Every list is in order of how usual the pairing is. A word matches a food name at a word start
 * ("rice" matches "Rice, white, cooked" and "Brown rice", never "Licorice"). An empty list (NONE)
 * is curated evidence too: the family is not eaten with that part in that template (tuna has no
 * fruit). `usual` and `never` are the occasion priors (D6: soft, never a ban outside safety).
 * Cuisine-specific additions live in ./cuisine.ts, beside this table, so these rows stay
 * byte-for-byte what the coach has always read.
 *
 * Deterministic data. No I/O.
 */

import type { Occasion } from "@/lib/meals/occasion";

export type Sides = {
  starch: readonly string[];
  veg: readonly string[];
  fat: readonly string[];
  fruit: readonly string[];
};

export type PairingFamily = {
  key: string;
  /** Matched against the lower-cased food name; families are tried in table order. */
  match: RegExp;
  /** Meal types this family usually anchors. */
  usual: readonly Occasion[];
  /** Meal types it never anchors unless the person's own words ask for it. */
  never: readonly Occasion[];
  breakfast?: Sides;
  main?: Sides;
  snack?: Sides;
};

const NONE: readonly string[] = [];
const BERRIES = ["blueberr", "strawberr", "raspberr", "blackberr", "berries", "mixed berries"];
const BREAKFAST_FRUIT = [...BERRIES, "banana", "apple", "orange", "peach", "mango", "kiwi", "pear"];
const GREENS = ["salad", "lettuce", "mixed greens", "greens", "arugula", "spring mix", "romaine"];
const GREEN_VEG = ["broccoli", "green beans", "asparagus", "spinach", ...GREENS, "zucchini",
  "pepper", "carrot", "cauliflower", "brussels sprouts", "kale", "peas"];
const OILS = ["olive oil", "oil, olive", "avocado oil", "oil, avocado"];
const NUTS = ["almonds", "walnuts", "nuts", "pecans", "cashews", "pistachios", "peanuts",
  "chia", "flax", "pumpkin seeds", "seeds", "almond butter", "peanut butter"];
const EGG_VEG = ["spinach", "pepper", "tomato", "mushroom", "onion", "kale"];
const TOAST = ["toast", "bread", "english muffin", "bagel"];

const MAIN_GENERIC: Sides = {
  starch: ["rice", "potato", "pasta", "quinoa", "sweet potato", "couscous", "bread", "tortilla", "noodle"],
  veg: GREEN_VEG,
  fat: [...OILS, "avocado", "butter"],
  fruit: NONE,
};
const BREAKFAST_GENERIC: Sides = {
  starch: [...TOAST, "oats", "oatmeal", "potato", "granola", "tortilla"],
  veg: EGG_VEG,
  fat: ["avocado", "butter", ...NUTS],
  fruit: BREAKFAST_FRUIT,
};
const SNACK_GENERIC: Sides = {
  starch: ["rice cake", "crackers", "granola", "oats", "toast", "bread", "pretzels"],
  veg: ["carrot", "cucumber", "celery", "pepper", "snap peas"],
  fat: [...NUTS, "avocado", "cheese"],
  fruit: [...BREAKFAST_FRUIT, "grapes", "pineapple"],
};
const YOGURT_SIDES: Sides = {
  starch: ["granola", "oats", "oatmeal"],
  veg: NONE,
  fat: NUTS,
  fruit: [...BERRIES, "banana", "peach", "mango", "apple", "kiwi", "pineapple"],
};
const SEAFOOD_MAIN: Sides = {
  starch: ["rice", "pasta", "risotto", "arborio", "quinoa", "potato", "couscous", "noodle", "tortilla"],
  veg: ["asparagus", ...GREENS, "spinach", "peas", "zucchini", "green beans", "tomato", "broccoli", "pepper"],
  fat: ["butter", ...OILS, "avocado"],
  fruit: NONE,
};

/** Table order matters: "smoked salmon" before "salmon", "turkey sausage" before "turkey". */
export const PAIRING_FAMILIES: readonly PairingFamily[] = [
  { key: "eggs", match: /\begg(?:s|\s+whites?)?\b(?!\s*(?:plant|nog|noodle))/, usual: ["breakfast", "lunch", "snack"],
    never: [],
    breakfast: { starch: [...TOAST, "potato", "oats", "tortilla"], veg: EGG_VEG,
      fat: ["avocado", "butter", "cheese", ...OILS], fruit: BREAKFAST_FRUIT },
    main: { starch: ["rice", "toast", "bread", "potato", "tortilla", "noodle"],
      veg: ["spinach", "pepper", "tomato", ...GREENS, "asparagus", "mushroom"],
      fat: ["avocado", ...OILS, "butter"], fruit: NONE } },
  { key: "greek yogurt", match: /\byog(?:h)?urt\b|\bskyr\b|\bquark\b/, usual: ["breakfast", "snack"],
    never: ["dinner"], breakfast: YOGURT_SIDES, snack: YOGURT_SIDES, main: YOGURT_SIDES },
  { key: "cottage cheese", match: /\bcottage cheese\b|\bcheese, cottage\b/, usual: ["breakfast", "snack", "lunch"],
    never: ["dinner"],
    breakfast: { ...YOGURT_SIDES, starch: ["toast", "bread", "granola", "oats", "crackers"],
      fruit: ["pineapple", "peach", ...BERRIES, "banana"] },
    snack: { ...YOGURT_SIDES, fruit: ["pineapple", "peach", ...BERRIES] } },
  { key: "protein shake", match: /\b(?:whey|casein|protein (?:powder|shake|drink)|shake)\b/,
    usual: ["breakfast", "snack"], never: ["lunch", "dinner"],
    breakfast: { starch: ["oats", "toast", "bread", "granola"], veg: NONE,
      fat: ["peanut butter", "almond butter", ...NUTS], fruit: ["banana", ...BERRIES] },
    snack: { starch: ["oats", "rice cake"], veg: NONE, fat: ["peanut butter", "almond butter", ...NUTS],
      fruit: ["banana", ...BERRIES, "apple"] } },
  { key: "smoked salmon", match: /\bsmoked salmon\b|\bsalmon, smoked\b|\blox\b/, usual: ["breakfast", "lunch"],
    never: [],
    breakfast: { starch: ["bagel", "toast", "bread", "english muffin", "crackers"],
      veg: ["cucumber", "tomato", "onion", "spinach", "arugula"], fat: ["avocado", "cream cheese"], fruit: NONE },
    main: { starch: ["bagel", "bread", "toast", "rice", "potato"], veg: ["cucumber", ...GREENS, "tomato"],
      fat: ["avocado", ...OILS], fruit: NONE } },
  { key: "breakfast sausage", match: /\b(?:sausages?|bacon|ham)\b/, usual: ["breakfast", "lunch"], never: [],
    breakfast: { starch: ["toast", "potato", "english muffin", "tortilla", "bread", "oats"],
      veg: EGG_VEG, fat: ["avocado"], fruit: BREAKFAST_FRUIT },
    main: { starch: ["potato", "rice", "pasta", "bread", "tortilla"],
      veg: ["pepper", "onion", "cabbage", "green beans", "broccoli", ...GREENS], fat: OILS, fruit: NONE } },
  { key: "tofu", match: /\b(?:tofu|tempeh|seitan)\b/, usual: ["breakfast", "lunch", "dinner"], never: [],
    breakfast: { starch: ["toast", "bread", "potato", "tortilla"], veg: EGG_VEG, fat: ["avocado", ...OILS], fruit: NONE },
    main: { starch: ["rice", "noodle", "quinoa", "potato"],
      veg: ["broccoli", "bok choy", "pepper", "snap peas", "carrot", "spinach", "mushroom", "cabbage", "edamame", "green beans"],
      fat: ["sesame oil", "oil, sesame", "peanuts", "cashews", ...OILS, "avocado"], fruit: NONE } },
  { key: "poultry", match: /\b(?:chicken|turkey|duck)\b/, usual: ["lunch", "dinner"], never: [],
    breakfast: { starch: ["toast", "bread", "potato", "tortilla", "english muffin"], veg: EGG_VEG, fat: ["avocado"],
      fruit: NONE },
    main: { starch: ["rice", "potato", "pasta", "quinoa", "tortilla", "sweet potato", "couscous", "bread", "noodle"],
      veg: ["broccoli", "green beans", ...GREENS, "pepper", "zucchini", "carrot", "asparagus", "spinach", "cauliflower"],
      fat: [...OILS, "avocado", "butter"], fruit: NONE } },
  { key: "salmon", match: /\b(?:salmon|trout|mackerel|arctic char|sardines?)\b/, usual: ["lunch", "dinner"], never: [],
    main: { starch: ["rice", "potato", "quinoa", "sweet potato", "couscous", "pasta", "noodle"],
      veg: ["asparagus", "spinach", "kale", ...GREENS, "broccoli", "green beans", "peas", "zucchini"],
      fat: [...OILS, "butter", "avocado"], fruit: NONE } },
  { key: "tuna", match: /\b(?:tuna|ahi)\b/, usual: ["lunch", "dinner"], never: ["breakfast"],
    main: { starch: ["rice", "bread", "pasta", "crackers", "potato", "quinoa", "noodle"],
      veg: [...GREENS, "cucumber", "tomato", "edamame", "pepper", "celery", "spinach", "green beans"],
      fat: ["avocado", ...OILS, "sesame oil"], fruit: NONE } },
  { key: "white fish", match: /\b(?:cod|tilapia|haddock|halibut|pollock|sole|flounder|sea bass|bass|snapper|mahi|catfish|whitefish|white fish|swordfish|fish)\b/,
    usual: ["lunch", "dinner"], never: ["breakfast", "snack"],
    main: { starch: ["potato", "rice", "quinoa", "couscous", "tortilla", "pasta"],
      veg: ["green beans", "asparagus", "peas", "spinach", "broccoli", "zucchini", ...GREENS, "tomato"],
      fat: [...OILS, "butter", "avocado"], fruit: NONE } },
  { key: "scallops", match: /\bscallops?\b/, usual: ["dinner", "lunch"], never: ["breakfast", "snack"],
    main: SEAFOOD_MAIN },
  { key: "shrimp", match: /\b(?:shrimp|prawns?)\b/, usual: ["dinner", "lunch"], never: ["breakfast", "snack"],
    main: { ...SEAFOOD_MAIN, starch: ["rice", "pasta", "noodle", "tortilla", "risotto", "arborio", "quinoa", "potato"],
      veg: [...SEAFOOD_MAIN.veg, "onion", "snap peas"] } },
  { key: "crab", match: /\b(?:crab|lobster|mussels?|clams?|oysters?|squid|calamari|octopus)\b/,
    usual: ["dinner", "lunch"], never: ["breakfast", "snack"], main: SEAFOOD_MAIN },
  { key: "beef", match: /\b(?:beef|steak|sirloin|ribeye|bison|veal|venison|brisket)\b/,
    usual: ["dinner", "lunch"], never: ["breakfast", "snack"],
    main: { starch: ["potato", "rice", "tortilla", "pasta", "sweet potato", "bread", "noodle", "beans"],
      veg: ["pepper", "onion", ...GREENS, "broccoli", "green beans", "mushroom", "asparagus", "spinach", "carrot"],
      fat: [...OILS, "avocado", "butter", "cheese"], fruit: NONE } },
  { key: "pork", match: /\bpork\b/, usual: ["dinner", "lunch"], never: ["breakfast", "snack"],
    main: { starch: ["potato", "rice", "sweet potato", "noodle", "tortilla"],
      veg: ["green beans", "cabbage", "broccoli", "carrot", "brussels sprouts", "pepper", ...GREENS],
      fat: OILS, fruit: NONE } },
  { key: "lamb", match: /\b(?:lamb|goat|mutton)\b/, usual: ["dinner"], never: ["breakfast", "snack"],
    main: { starch: ["couscous", "potato", "rice", "pita", "bread"],
      veg: ["green beans", "peas", "tomato", "cucumber", "spinach", "eggplant", ...GREENS],
      fat: OILS, fruit: NONE } },
  { key: "legumes", match: /\b(?:lentils?|chickpeas?|garbanzo|black beans|kidney beans|pinto beans|beans)\b/,
    usual: ["lunch", "dinner"], never: [],
    main: { starch: ["rice", "tortilla", "bread", "pita", "quinoa", "potato"],
      veg: ["spinach", "tomato", "pepper", "onion", "kale", "carrot", ...GREENS],
      fat: [...OILS, "avocado"], fruit: NONE } },
];

export const GENERIC_SIDES = { breakfast: BREAKFAST_GENERIC, main: MAIN_GENERIC, snack: SNACK_GENERIC };
