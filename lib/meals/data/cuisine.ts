/**
 * Cuisine-tagged additions to the curated pairing table (Phase 17 O1, D6). The table in
 * ./pairings.ts was written from mostly Western plates; these rows add the dishes it missed —
 * dal with rice or roti, paneer with spinach, eggs with rice and bok choy, black beans with
 * tortilla and avocado, chickpeas with pita and feta — so an account whose Eats are South Asian,
 * East Asian, Latin American or Mediterranean gets usual pairings too, not only neutral ones.
 *
 * They are read only by lib/meals (the layout and the swap sheet). The coach's suggest_options
 * still reads ./pairings.ts alone until O4 moves it onto lib/meals, so its cards do not change in
 * this slice. Words are appended after a family's own list: the table's order stays the "most
 * usual" order, and an addition is usual but listed later.
 *
 * Deterministic data. No I/O.
 */

import type { PairingFamily, Sides } from "@/lib/meals/data/pairings";
import type { TemplateKey } from "@/lib/meals/templates";

export type Cuisine =
  | "global" | "north-american-european" | "south-asian" | "east-asian" | "latin-american"
  | "mediterranean";

const NONE: readonly string[] = [];
const FLATBREADS = ["roti", "chapati", "naan", "paratha", "pita"];
const GHEE_OILS = ["ghee", "mustard oil", "olive oil", "oil, olive", "avocado oil", "oil"];

/** Families the original table has no row for. Tried after the table's own rows. */
export const EXTRA_FAMILIES: readonly (PairingFamily & { cuisines: readonly Cuisine[] })[] = [
  { key: "dal", cuisines: ["south-asian"],
    match: /\b(?:dal|dhal|daal|sambar|chana|rajma|chole)\b/, usual: ["lunch", "dinner"], never: [],
    breakfast: { starch: [...FLATBREADS, "rice", "idli", "dosa", "bread", "toast"],
      veg: ["spinach", "tomato", "onion", "pepper"], fat: ["ghee", "butter", "oil"], fruit: NONE },
    main: { starch: ["rice", ...FLATBREADS, "quinoa", "bread"],
      veg: ["spinach", "cauliflower", "okra", "peas", "tomato", "onion", "carrot", "cabbage",
        "green beans", "eggplant", "pepper"], fat: GHEE_OILS, fruit: NONE } },
  { key: "paneer", cuisines: ["south-asian", "mediterranean"],
    match: /\b(?:paneer|halloumi)\b/, usual: ["lunch", "dinner"], never: [],
    breakfast: { starch: ["paratha", "roti", "chapati", "toast", "bread", "pita"],
      veg: ["tomato", "pepper", "onion", "spinach", "cucumber"], fat: ["ghee", "butter", "olive oil"],
      fruit: NONE },
    main: { starch: [...FLATBREADS, "rice", "bread", "couscous"],
      veg: ["spinach", "peas", "pepper", "tomato", "onion", "cauliflower", "eggplant", "zucchini",
        "cucumber"], fat: GHEE_OILS, fruit: NONE } },
];

/** Extra usual sides for one family (`"*"` = a food the table does not know) in one template. */
export type CuisineSides = {
  family: string; template: TemplateKey; cuisines: readonly Cuisine[]; sides: Partial<Sides>;
};

export const CUISINE_SIDES: readonly CuisineSides[] = [
  { family: "eggs", template: "breakfast", cuisines: ["east-asian", "south-asian", "latin-american", "mediterranean"],
    sides: { starch: ["rice", ...FLATBREADS, "arepa", "black beans", "beans", "noodle", "congee"],
      veg: ["bok choy", "scallion", "green onion", "cucumber"], fat: ["feta", "olive oil", "ghee", "sesame oil"] } },
  { family: "eggs", template: "main", cuisines: ["east-asian", "south-asian", "latin-american"],
    sides: { starch: [...FLATBREADS, "black beans", "beans"], veg: ["bok choy", "scallion", "green onion", "cabbage"] } },
  { family: "tofu", template: "breakfast", cuisines: ["east-asian"],
    sides: { starch: ["rice", "noodle", "congee"], veg: ["bok choy", "scallion", "spinach"], fat: ["sesame oil"] } },
  { family: "tofu", template: "main", cuisines: ["east-asian"],
    sides: { veg: ["scallion", "green onion"] } },
  { family: "greek yogurt", template: "breakfast", cuisines: ["mediterranean", "south-asian"],
    sides: { starch: ["pita", "bread", "paratha", "roti"], veg: ["cucumber", "tomato"],
      fruit: ["dates", "figs", "pomegranate"] } },
  { family: "legumes", template: "main", cuisines: ["south-asian", "latin-american", "mediterranean"],
    sides: { starch: [...FLATBREADS, "arepa", "plantain", "couscous", "bulgur", "injera"],
      veg: ["cauliflower", "eggplant", "cucumber", "cabbage", "okra", "zucchini"],
      fat: ["feta", "ghee", "tahini", "cheese", "queso", "olive"] } },
  { family: "legumes", template: "breakfast", cuisines: ["latin-american", "mediterranean", "south-asian"],
    sides: { starch: ["tortilla", "pita", "bread", "toast", "arepa", "plantain", ...FLATBREADS, "rice"],
      veg: ["tomato", "onion", "pepper", "spinach", "cucumber"],
      fat: ["avocado", "feta", "olive oil", "oil, olive", "tahini", "cheese", "queso", "ghee"] } },
  { family: "poultry", template: "main", cuisines: ["south-asian", "latin-american", "mediterranean", "east-asian"],
    sides: { starch: [...FLATBREADS, "arepa", "plantain", "bulgur"], veg: ["bok choy", "cabbage", "okra", "eggplant"] } },
  { family: "beef", template: "main", cuisines: ["latin-american", "east-asian", "south-asian"],
    sides: { starch: ["plantain", "arepa", "roti", "naan"], veg: ["bok choy", "cabbage"] } },
  { family: "salmon", template: "main", cuisines: ["east-asian"], sides: { veg: ["bok choy", "cabbage"] } },
  { family: "white fish", template: "main", cuisines: ["east-asian", "latin-american", "south-asian"],
    sides: { starch: ["plantain", "roti"], veg: ["bok choy", "cabbage", "okra"] } },
  { family: "*", template: "main", cuisines: ["south-asian", "east-asian", "latin-american", "mediterranean"],
    sides: { starch: [...FLATBREADS, "plantain", "arepa", "bulgur"],
      veg: ["bok choy", "okra", "eggplant", "cabbage", "cucumber", "tomato"],
      fat: ["ghee", "sesame oil", "tahini", "feta", "cheese"] } },
  { family: "*", template: "breakfast", cuisines: ["south-asian", "east-asian", "latin-american", "mediterranean"],
    sides: { starch: ["roti", "paratha", "rice", "pita", "arepa"], veg: ["cucumber", "tomato"],
      fat: ["ghee", "feta", "olive oil"] } },
];

/**
 * The foods each stated cuisine (`user_settings.cuisines`, the 12-word list) leans on, as name
 * words matched at a word start (lib/meals/cuisine.ts ranks with them, onb3). `core` is a defining
 * staple, `common` an everyday food. Written from the reviewed cuisine packs' food lists, as words
 * so the meal engine can read them for any account; a ranking signal only, never a rule.
 */
export const CUISINE_STAPLES: Readonly<Record<string, { core: readonly string[]; common: readonly string[] }>> = {
  american: {
    core: ["chicken breast", "ground beef", "turkey", "egg", "potato", "white rice", "whole wheat bread", "bread",
      "broccoli", "green beans", "banana", "apple", "peanut butter", "oatmeal", "corn on the cob", "cheddar"],
    common: ["steak", "pork chop", "salmon", "tuna", "greek yogurt", "cottage cheese", "sweet potato", "carrot",
      "lettuce", "tomato", "strawberries", "blueberries", "orange", "grapes", "almonds", "butter", "pasta",
      "spaghetti", "black beans", "pinto beans"],
  },
  latin_american: {
    core: ["black beans", "pinto beans", "tortilla", "white rice", "avocado", "tomato", "onion", "chicken thigh",
      "egg", "lime", "cilantro", "queso"],
    common: ["ground beef", "pork shoulder", "steak", "tilapia", "shrimp", "pepper", "corn on the cob", "plantain", "mango",
      "papaya", "refried beans", "cabbage", "zucchini", "sweet potato"],
  },
  italian: {
    core: ["spaghetti", "pasta", "tomato", "olive oil", "garlic", "parmesan", "mozzarella", "basil", "zucchini",
      "chicken breast", "white bread", "ricotta"],
    common: ["sourdough", "white beans", "chickpeas", "eggplant", "pepper", "spinach", "arugula", "mushroom",
      "cod", "shrimp", "steak", "olives", "lemon", "lentils"],
  },
  mediterranean: {
    core: ["chickpeas", "lentils", "pita", "olive oil", "tomato", "cucumber", "feta", "greek yogurt", "hummus",
      "tahini", "bulgur", "lemon", "eggplant"],
    common: ["couscous", "lamb", "chicken thigh", "fava", "olives", "zucchini", "pepper", "spinach", "dates",
      "figs", "pomegranate", "pistachios", "almonds", "walnuts", "sea bass", "yogurt", "white rice"],
  },
  south_asian: {
    core: ["basmati", "lentils", "dal", "chickpeas", "roti", "chapati", "naan", "ghee", "yogurt", "spinach",
      "cauliflower", "potato", "chicken thigh"],
    common: ["kidney beans", "peas", "okra", "eggplant", "green beans", "cabbage", "carrot", "egg", "lamb", "goat",
      "white rice", "mango", "banana", "cashews", "almonds", "sweet potato"],
  },
  chinese: {
    core: ["white rice", "jasmine", "tofu", "bok choy", "egg", "pork shoulder", "chicken thigh", "napa cabbage",
      "green onion", "noodles", "sesame oil", "shiitake"],
    common: ["gai lan", "snow peas", "bean sprouts", "broccoli", "eggplant", "pepper", "carrot", "shrimp",
      "steak", "duck", "sea bass", "peanuts", "cashews", "edamame", "cucumber", "spinach", "mushroom"],
  },
  japanese: {
    core: ["sushi rice", "white rice", "salmon", "tuna", "tofu", "edamame", "nori", "seaweed", "egg", "soba",
      "green onion", "daikon", "natto", "shiitake"],
    common: ["mackerel", "cod", "shrimp", "chicken thigh", "steak", "spinach", "cabbage", "cucumber", "carrot",
      "sweet potato", "sesame", "mushroom"],
  },
  korean: {
    core: ["white rice", "kimchi", "tofu", "egg", "sesame oil", "green onion", "garlic", "napa cabbage",
      "bean sprouts", "steak", "pork shoulder", "seaweed", "spinach"],
    common: ["chicken thigh", "short ribs", "mackerel", "daikon", "zucchini", "cucumber", "carrot", "shiitake",
      "sweet potato", "sesame", "brown rice"],
  },
  southeast_asian: {
    core: ["jasmine", "rice noodles", "tofu", "shrimp", "chicken thigh", "coconut milk", "lime", "lemongrass",
      "cilantro", "bean sprouts", "egg", "peanuts", "cucumber", "bok choy"],
    common: ["pork shoulder", "steak", "tilapia", "tempeh", "eggplant", "pepper", "cabbage", "spinach", "mango",
      "papaya", "pineapple", "banana", "sweet potato", "white rice", "cashews"],
  },
  caribbean: {
    core: ["white rice", "kidney beans", "black beans", "pigeon peas", "chicken thigh", "plantain", "yam",
      "callaloo", "coconut milk", "lime", "pepper"],
    common: ["goat", "pork shoulder", "ground beef", "cod", "shrimp", "mackerel", "black-eyed peas", "sweet potato",
      "pumpkin", "okra", "cabbage", "carrot", "tomato", "mango", "papaya", "pineapple", "banana", "avocado", "egg"],
  },
  african: {
    core: ["millet", "teff", "yam", "plantain", "black-eyed peas", "peanuts", "peanut butter", "okra", "tomato",
      "chicken thigh", "goat", "white rice", "collard"],
    common: ["lentils", "chickpeas", "fava", "kidney beans", "spinach", "cabbage", "carrot", "sweet potato",
      "pumpkin", "eggplant", "ground beef", "lamb", "tilapia", "mackerel", "sardines", "egg", "mango", "banana",
      "papaya", "avocado", "couscous"],
  },
  european_other: {
    core: ["potato", "rye bread", "cabbage", "sauerkraut", "pork shoulder", "chicken breast", "egg", "butter",
      "carrot", "beets", "apple", "buckwheat"],
    common: ["leeks", "turnips", "parsnips", "brussels sprouts", "cauliflower", "green beans", "peas", "mushroom",
      "cucumber", "sour cream", "cottage cheese", "herring", "cod", "trout", "salmon", "pork tenderloin",
      "egg noodles", "barley", "sourdough", "pear", "plum", "cherries", "raspberries"],
  },
};
