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
