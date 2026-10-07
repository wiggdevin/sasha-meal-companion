/**
 * Which macro group (the Eats list's protein / carbs / fats dot) a food belongs to.
 *
 * Owner, 2026-10-04: "Make sure we don't have misplaced or miscategorized foods" — "Soup, beef"
 * showed the carbs dot. Two old rules caused it: a food with no stored role fell back to "carb"
 * (lib/store.ts), and the add paths picked the largest macro by GRAMS, so a fat-heavy food with a
 * few grams more carbohydrate than fat read as a carb, and a lean meat with more fat grams than
 * a soup's beef read as anything but protein.
 *
 * The rule, in order:
 *   1. a pure fat by name (oil, ghee, lard, tallow, "beef fat") is fat;
 *   2. a meat, poultry, fish, seafood, egg or plant-protein name is protein — whatever the dish
 *      (a beef soup or a chicken stew is where that meal's protein comes from); goat or buffalo
 *      beside a dairy word is the milk, not the meat;
 *   3. nuts, seeds, nut butters, avocado, olives, coconut, butter and mayonnaise are fat — but
 *      not a nut or coconut made into a milk, sugar, flour or water (the calories decide those);
 *   4. fruit, grains, starches and sweeteners are carbs;
 *   5. anything else (a soup or mixed dish with no named protein) goes by the macro that brings
 *      the most CALORIES (protein and carbs 4 kcal/g, fat 9 kcal/g).
 * A food with no name match and no nutrition has no judgment (`null`); the caller picks.
 *
 * Pure. No I/O. Word-bounded and case-insensitive, so "butternut squash" is not butter and
 * "buttermilk" is not either.
 */
import type { FoodRole } from "@/lib/foods";
import { macroKcal } from "@/lib/scaling";

export type RoleMacros = { protein: number; carbs: number; fat: number };

/** How the role was decided: a name rule is a confident call; calories decide the rest. */
export type RoleSource = "name" | "calories";

export type RoleJudgment = { role: FoodRole; source: RoleSource };

/** "packed in olive oil", "canned in water": how it is stored, not what it is. */
const PACKING = /\b(?:(?:packed|canned|stored|preserved)\s+)?in\s+(?:\w+\s+)?(?:oil|water|brine|juice|syrup)\b/g;
/** "reduced fat", "fat-free", "lean": descriptors, not a fat. */
const FAT_DESCRIPTOR = /\b(?:low|reduced|non|no|less|lean|light|lite|full)[\s-]?fat\b|\bfat[\s-]?free\b|\bnonfat\b/g;

const PURE_FAT = new RegExp([
  "\\b(?:oils?|ghee|lard|tallow|shortening|margarine|suet|drippings|schmaltz)\\b",
  "\\b(?:beef|pork|chicken|duck|goose|bacon|animal|lamb)\\s+fat\\b",
  "^fat\\b",
].join("|"));

const PROTEIN = new RegExp(`\\b(?:${[
  "beef", "steaks?", "sirloin", "brisket", "veal", "bison", "buffalo", "venison", "deer", "elk",
  "game meat", "lamb", "mutton", "goat", "pork", "ham", "prosciutto", "chicken", "turkey", "duck",
  "goose", "quail", "poultry", "meat", "meatballs?", "jerky",
  "fish", "salmon", "tuna", "albacore", "cod", "tilapia", "halibut", "trout", "sardines?",
  "anchov(?:y|ies)", "mackerel", "mahi(?:[\\s-]mahi)?", "snapper", "sea bass", "catfish", "pollock",
  "haddock", "swordfish", "shrimp", "prawns?", "crab", "lobster", "scallops?", "clams?",
  "mussels?", "oysters?", "squid", "calamari", "octopus",
  "eggs?", "egg whites?", "tofu", "tempeh", "seitan", "whey", "protein powder", "protein shake",
  "cottage cheese", "greek yogh?urt", "skyr",
].join("|")})\\b`);
/**
 * A protein word that names something else: an egg starch ("egg noodles"), a sauce named for a
 * meat or fish ("fish sauce", "buffalo sauce"), a fruit ("crab apple"), a mushroom ("oyster
 * mushrooms", "chicken of the woods"), a candy ("Swedish fish") or a drink ("egg nog"). The phrase
 * is taken out before the protein test only, so "chicken with fish sauce" is still chicken and
 * "crab apple" goes on to the carb rule; it was read as crab (2026-10-04 audit, MAJOR 6).
 */
const NOT_PROTEIN = new RegExp([
  "\\begg\\s+(?:noodles?|pasta|bread|rolls?|bagels?|nog)\\b",
  "\\b(?:fish|oyster|anchovy|buffalo|steak|duck)\\s+sauce\\b",
  "\\bcrab\\s*apples?\\b",
  "\\b(?:oyster|chicken)\\s+mushrooms?\\b",
  "\\bchicken\\s+of\\s+the\\s+woods\\b",
  "\\bswedish\\s+fish\\b",
].join("|"), "g");

const FAT_FOOD = new RegExp(`\\b(?:${[
  "butter", "nut butters?", "nuts?", "almonds?", "walnuts?", "pecans?", "cashews?", "pistachios?",
  "macadamias?", "hazelnuts?", "peanuts?", "seeds?", "tahini", "avocados?", "guacamole",
  "olives?", "coconut", "mayo", "mayonnaise", "aioli", "cream cheese", "heavy cream",
  "whipping cream", "sour cream",
].join("|")})\\b`);
/**
 * An animal word that names the milk, not the meat: goat or buffalo beside a dairy word ("Goat
 * cheese", "Buffalo mozzarella", "Milk, goat") is dairy. The animal word is dropped for the protein
 * test, so the rest of the name, or the calories, decide (2026-10-04 re-audit, MAJOR 3).
 */
const DAIRY = /\b(?:cheeses?|milks?|mozzarella|ricotta|feta|yogh?urts?|kefir|cream|curds?|paneer|halloumi|burrata|butter)\b/;
const DAIRY_ANIMAL = /\b(?:goat|buffalo)(?:'s)?\b/g;

/** Names that contain a fat word but are not a fat. Taken out before the fat test only. */
const NOT_FAT = /\b(?:butter\s+(?:beans?|lettuce)|coconut\s+water|seeded\s+bread|pomegranate\s+seeds?)\b/g;
/**
 * A nut, seed or coconut made into a drink, sugar, flour or sauce ("Almond milk", "Coconut sugar",
 * "Milk, cashew", "Coconut aminos") is not a fat by name. Some are (canned coconut milk), most are
 * not, so the name decides nothing and the calories do (2026-10-04 re-audit, MAJOR 3).
 */
const NUT_SOURCE = /\b(?:nuts?|almonds?|walnuts?|pecans?|cashews?|pistachios?|macadamias?|hazelnuts?|peanuts?|seeds?|coconut)\b/g;
const NUT_PRODUCT = /\b(?:milks?|beverages?|drinks?|water|sugars?|syrups?|nectar|flour|aminos)\b/;

const CARB = new RegExp(`\\b(?:${[
  "fruits?", "apples?", "crabapples?", "applesauce", "bananas?", "berr(?:y|ies)", "strawberr(?:y|ies)",
  "blueberr(?:y|ies)", "raspberr(?:y|ies)", "blackberr(?:y|ies)", "cranberr(?:y|ies)",
  "cherr(?:y|ies)", "grapes?", "grapefruits?", "oranges?", "mandarins?", "clementines?",
  "tangerines?", "lemons?", "limes?", "mangos?", "mangoes", "melons?", "cantaloupe", "honeydew",
  "watermelon", "pears?", "peach(?:es)?", "plums?", "prunes?", "nectarines?", "apricots?",
  "pineapples?", "papayas?", "kiwis?", "kiwifruit", "figs?", "dates", "raisins", "pomegranates?",
  "rice", "oats?", "oatmeal", "porridge", "granola", "bread", "bagels?", "buns?", "rolls?",
  "muffins?", "pancakes?", "waffles?", "toast", "pasta",
  "noodles?", "spaghetti", "macaroni", "tortillas?", "cereal", "crackers?", "quinoa", "couscous",
  "barley", "farro", "bulgur", "millet", "polenta", "grits", "potato(?:es)?", "sweet potato(?:es)?",
  "yams?", "squash", "pumpkin", "corn", "flour", "honey", "maple syrup", "syrup", "sugar", "jam",
  "jelly", "juice",
].join("|")})\\b`);

function plainName(name: string): string {
  return name.toLowerCase().replace(PACKING, " ").replace(FAT_DESCRIPTOR, " ")
    .replace(/\s+/g, " ").trim();
}

/** The role a name alone settles, or null when the name says nothing confident. */
export function roleFromName(name: string): FoodRole | null {
  const lower = plainName(name);
  if (!lower) return null;
  if (PURE_FAT.test(lower)) return "fat";
  const proteinText = lower.replace(NOT_PROTEIN, " ");
  if (PROTEIN.test(DAIRY.test(lower) ? proteinText.replace(DAIRY_ANIMAL, " ") : proteinText)) return "protein";
  const fatText = lower.replace(NOT_FAT, " ");
  if (FAT_FOOD.test(fatText)) {
    if (!NUT_PRODUCT.test(lower) || FAT_FOOD.test(fatText.replace(NUT_SOURCE, " "))) return "fat";
    return null; // a nut drink, sugar or flour: ambiguous, the calories decide
  }
  if (CARB.test(lower)) return "carb";
  return null;
}

/** The macro that brings the most calories; ties go protein, then carbs. Null with no calories. */
export function roleFromCalories(macros: RoleMacros): FoodRole | null {
  const value = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const protein = macroKcal({ protein: value(macros.protein), carbs: 0, fat: 0 });
  const carbs = macroKcal({ protein: 0, carbs: value(macros.carbs), fat: 0 });
  const fat = macroKcal({ protein: 0, carbs: 0, fat: value(macros.fat) });
  if (protein + carbs + fat <= 0) return null;
  if (protein >= carbs && protein >= fat) return "protein";
  return carbs >= fat ? "carb" : "fat";
}

/** The role and how it was decided, or null when neither the name nor the numbers say. */
export function judgeFoodRole(name: string, macros: RoleMacros): RoleJudgment | null {
  const byName = roleFromName(name);
  if (byName) return { role: byName, source: "name" };
  const byCalories = roleFromCalories(macros);
  return byCalories ? { role: byCalories, source: "calories" } : null;
}

/** The role a food should carry. `fallback` only when the name and numbers are both silent. */
export function inferFoodRole(name: string, macros: RoleMacros, fallback: FoodRole = "carb"): FoodRole {
  return judgeFoodRole(name, macros)?.role ?? fallback;
}
