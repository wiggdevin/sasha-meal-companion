/**
 * W104 (docs/plans/2026-10-10-priority-spec-list.md; Option B of docs/audit/2026-10-05-w2c-impact.md):
 * the diet-label ingredient parser. It reads a printed ingredient statement item by item and says
 * whether EVERY item is a plant, fungal, mineral or synthetic ingredient on one fixed word list. Only
 * then may a label clear an animal facet (animal_product, meat, pork, beef, fish_seafood, shellfish).
 *
 * The rules, each fail-closed (anything else is "not plant-only", which leaves the facet `unknown`):
 * - The text is the label's own statement (`ingredientsTextIsLabel` not false), ends in a period or
 *   a naming "Contains"/"May contain" clause, and has at least two items.
 * - Trailing allergen and facility sentences ("Contains: soy.", "Produced in a facility that also
 *   processes milk.") are split off and never qualify an item. Any other trailing sentence fails.
 * - Items split at commas and semicolons, and at "and", "or" and "and/or", at parenthesis depth 0
 *   only. A parenthesised list belongs to its item: "vegetable oil (canola and/or sunflower oil)".
 * - Every item, and every item inside a parenthesis, must equal a `PLANT_INGREDIENTS` entry after
 *   lower-casing and trimming. No partial match: one plant word never qualifies a whole item
 *   ("corn starch and oil" splits, and a bare "oil" fails). A generic head ("oil", "shortening",
 *   "glycerin", "natural flavor", "mono- and diglycerides", "lecithin") is never on the list, so
 *   "shortening (palm)" and "vegetable glycerin" stay unverified whatever they carry.
 * - A parenthesis that only states a purpose ("(firming agent)", "(to preserve freshness)") is a
 *   note, not an ingredient; any other parenthesis is parsed as sub-items.
 * - Plain sugar and cane sugar can be bone-char filtered: only their organic and beet forms count.
 *
 * Pure. No I/O. Reads no Jev facet. The parser only ever clears; whatever the food's own words name
 * is decided first by lib/policy/diet-evidence.ts, so a label that names an animal ingredient
 * still blocks.
 *
 * Wiring: lib/policy/diet-evidence.ts consults it only while `dietLabelClearanceEnabled()` is true.
 * It ships off (`DIET_LABEL_CLEARANCE_DEFAULT`) until the Mac session's Sol review passes; the
 * read-only recovery count (scripts/diet-label-recovery.ts) turns it on in-process to measure it.
 */

/** Off until Sol reviews the parser (W104). Flip it in its own PR once the review passes. */
export const DIET_LABEL_CLEARANCE_DEFAULT = false;

let clearance = DIET_LABEL_CLEARANCE_DEFAULT;

export function dietLabelClearanceEnabled(): boolean {
  return clearance;
}

/**
 * For the offline recovery count only (scripts/diet-label-recovery.ts) and tests. No app path calls
 * it (tests/policy/diet-label.test.ts checks).
 */
export function overrideDietLabelClearanceForReport(on: boolean): void {
  clearance = on;
}

/** The six animal facets a plant-only label may clear. */
export const LABEL_CLEARABLE_FACETS = [
  "animal_product", "meat", "pork", "beef", "fish_seafood", "shellfish",
] as const;
export type LabelClearableFacet = (typeof LABEL_CLEARABLE_FACETS)[number];

const PLANTS = [
  // Water and minerals.
  "water", "filtered water", "salt", "sea salt", "kosher salt", "iodized salt", "potassium chloride",
  "calcium chloride", "calcium sulfate", "magnesium chloride", "sodium bicarbonate", "baking soda",
  "potassium iodide",
  // Synthetic or fermentation acids and preservatives with no animal source.
  "citric acid", "ascorbic acid", "vitamin c", "acetic acid", "malic acid", "tartaric acid",
  "disodium edta", "calcium disodium edta", "sodium benzoate", "potassium sorbate", "sorbic acid",
  "sodium metabisulfite", "sodium bisulfite", "erythorbic acid", "sodium erythorbate",
  // Flour enrichment.
  "niacin", "reduced iron", "iron", "ferrous sulfate", "thiamine mononitrate", "thiamin mononitrate",
  "riboflavin", "folic acid",
  // Vinegars, yeast, leaveners.
  "vinegar", "distilled vinegar", "white vinegar", "apple cider vinegar", "rice vinegar", "yeast",
  "baking powder", "sodium acid pyrophosphate", "monocalcium phosphate",
  // Sweeteners with no bone-char question.
  "organic sugar", "organic cane sugar", "organic brown sugar", "beet sugar", "coconut sugar",
  "maple syrup", "agave syrup", "agave nectar", "corn syrup", "brown rice syrup", "molasses",
  "dextrose", "stevia", "stevia leaf extract",
  // Oils named by their plant.
  "canola oil", "sunflower oil", "high oleic sunflower oil", "safflower oil",
  "high oleic safflower oil", "olive oil", "extra virgin olive oil", "soybean oil", "corn oil",
  "palm oil", "palm fruit oil", "coconut oil", "sesame oil", "peanut oil", "avocado oil",
  "rice bran oil", "cottonseed oil", "vegetable oil",
  // The plant a "vegetable oil (canola and/or sunflower)" sub-list names.
  "canola", "sunflower", "safflower", "soybean", "palm", "olive", "cottonseed", "palm kernel",
  // Starches, grains and flours.
  "corn starch", "cornstarch", "potato starch", "tapioca starch", "tapioca", "rice starch",
  "modified corn starch", "modified food starch", "rice", "brown rice", "white rice", "long grain rice",
  "wild rice", "oats", "rolled oats", "whole grain oats", "barley", "quinoa", "millet", "buckwheat",
  "wheat flour", "whole wheat flour", "enriched wheat flour", "enriched flour", "unbleached wheat flour",
  "bleached wheat flour", "semolina", "durum wheat semolina", "corn flour", "corn masa flour", "cornmeal",
  "rice flour", "oat flour", "wheat", "corn", "sweet corn", "whole kernel corn", "lime",
  // Legumes.
  "beans", "black beans", "kidney beans", "red kidney beans", "dark red kidney beans",
  "light red kidney beans", "pinto beans", "navy beans", "great northern beans", "cannellini beans",
  "white beans", "small white beans", "garbanzo beans", "chickpeas", "lentils", "green lentils",
  "red lentils", "brown lentils", "black eyed peas", "black-eyed peas", "split peas", "lima beans",
  "butter beans", "fava beans", "mung beans", "adzuki beans", "soybeans", "edamame", "peas",
  "green peas", "green beans", "cut green beans", "prepared beans", "prepared black beans",
  "prepared pinto beans", "prepared kidney beans", "prepared chickpeas", "prepared garbanzo beans",
  // Vegetables, fruits and fungi.
  "tomatoes", "tomato", "diced tomatoes", "tomato paste", "tomato puree", "crushed tomatoes",
  "tomato juice", "onion", "onions", "dehydrated onion", "onion powder", "garlic", "dehydrated garlic",
  "garlic powder", "carrots", "carrot", "celery", "potatoes", "potato", "sweet potatoes", "spinach",
  "kale", "cabbage", "broccoli", "cauliflower", "zucchini", "squash", "pumpkin", "bell peppers",
  "red bell peppers", "green bell peppers", "peppers", "jalapeno peppers", "jalapeño peppers",
  "green chiles", "chili peppers", "mushrooms", "shiitake mushrooms", "button mushrooms",
  "oyster mushrooms", "olives", "ripe olives", "black olives", "green olives", "cucumbers",
  "artichoke hearts", "beets", "asparagus", "pineapple", "peaches", "pears", "apples", "applesauce",
  "mandarin oranges", "lemon juice", "lime juice", "concentrated lemon juice", "orange juice",
  "apple juice", "grape juice", "white grape juice", "pineapple juice", "pear juice", "fruit juice",
  "coconut", "coconut milk", "coconut cream", "raisins", "dates",
  // Nuts and seeds.
  "almonds", "cashews", "walnuts", "pecans", "peanuts", "pistachios", "hazelnuts", "sunflower seeds",
  "pumpkin seeds", "sesame seeds", "chia seeds", "flaxseed", "flax seeds",
  // Soy foods.
  "tofu", "soy protein isolate", "soy flour",
  // Herbs and spices (spices are plant by definition, 21 CFR 101.22(a)(2)).
  "spice", "spices", "black pepper", "pepper", "paprika", "cumin", "chili powder", "oregano", "basil",
  "parsley", "cilantro", "thyme", "rosemary", "bay leaf", "turmeric", "cinnamon", "nutmeg", "ginger",
  "cayenne pepper", "red pepper", "dried basil", "dried oregano", "mustard seed", "dill", "sage",
  // Gums and fibres from plants or fermentation.
  "xanthan gum", "guar gum", "locust bean gum", "gellan gum", "pectin", "fruit pectin", "agar",
  "carrageenan", "cellulose gum",
] as const;

const PLANT_INGREDIENTS: ReadonlySet<string> = new Set(PLANTS);

/** A parenthesis that only says why the item is there: a note, not an ingredient or a sub-list. */
const PURPOSE_NOTES: ReadonlySet<string> = new Set([
  "firming agent", "a firming agent", "preservative", "a preservative", "as a preservative",
  "antioxidant", "an antioxidant", "color", "for color", "leavening", "acidulant",
  "to preserve freshness", "to preserve color", "to promote color retention", "to retain color",
  "to protect flavor", "to protect quality", "used to protect quality", "to maintain freshness",
  "anticaking agent", "to prevent caking",
]);

/** Words a trailing allergen or facility sentence may use. Anything else fails the label. */
const TRAILING_WORDS: ReadonlySet<string> = new Set([
  "contains", "may", "contain", "traces", "trace", "of", "and", "or", "produced", "manufactured",
  "processed", "made", "packed", "in", "on", "a", "the", "facility", "plant", "that", "which",
  "also", "processes", "handles", "uses", "shared", "equipment", "with", "products",
  "milk", "egg", "eggs", "fish", "shellfish", "crustacean", "wheat", "soy", "soybean", "soybeans",
  "peanut", "peanuts", "tree", "nut", "nuts", "sesame", "almond", "almonds", "cashew", "cashews",
  "walnut", "walnuts", "pecan", "pecans", "pistachio", "pistachios", "hazelnut", "hazelnuts",
  "coconut", "macadamia", "brazil",
]);

const TRAILING_START = /^(?:contains|may contain|produced in|manufactured in|processed in|made in a facility|packed in a facility|made on shared equipment)\b/;

function isTrailingStatement(sentence: string): boolean {
  if (!TRAILING_START.test(sentence)) return false;
  const words = sentence.split(/[\s,;:]+/).filter((word) => word !== "");
  // At least one word past the opening ("Contains:" alone names nothing), every word known.
  return words.length > 2 - (sentence.startsWith("contains") ? 1 : 0)
    && words.every((word) => TRAILING_WORDS.has(word));
}

export type ParsedIngredient = { name: string; parts: ParsedIngredient[] };

/** The label's ingredient items, or `null` when the statement cannot be read item by item. */
export function parseIngredientStatement(raw: string | null | undefined): ParsedIngredient[] | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/^ingredients?\s*:\s*/, "");
  const sentences = splitSentences(text);
  if (sentences === null) return null;
  const [list, ...rest] = sentences;
  if (!rest.every(isTrailingStatement)) return null;
  const items = splitItems(list);
  if (items === null || items.length < 2) return null;
  return items;
}

/**
 * Splits at a period at depth 0 (never one between digits). The list itself must end in a period;
 * only allergen or facility sentences may follow it, with or without their own period. Returns
 * `null` for unbalanced brackets or a list with no period.
 */
function splitSentences(text: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (depth < 0) return null;
    if (char === "." && depth === 0 && !(/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? ""))) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (depth !== 0 || out.length === 0 || out[0] === "") return null;
  const tail = current.trim();
  if (tail !== "") out.push(tail);
  return out.filter((sentence, index) => index === 0 || sentence !== "");
}

/** Items at depth 0, split at , ; and the joins "and", "or", "and/or", "&". */
function splitItems(list: string): ParsedIngredient[] | null {
  const pieces: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < list.length; i += 1) {
    const char = list[i];
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (depth === 0 && (char === "," || char === ";")) {
      pieces.push(current);
      current = "";
      continue;
    }
    if (depth === 0) {
      const join = /^ (?:and\/or|and|or|&) (?!less\b)/.exec(list.slice(i));
      if (join) {
        pieces.push(current);
        current = "";
        i += join[0].length - 1;
        continue;
      }
    }
    current += char;
  }
  pieces.push(current);
  const items: ParsedIngredient[] = [];
  for (const piece of pieces) {
    const item = parseItem(piece.trim().replace(/^(?:and\/or|and|or)\s+/, ""));
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/** "Contains 2% or less of: salt" introduces the items after it; the marker itself is not one. */
const LESS_THAN = /^(?:contains )?(?:(?:less than )?\d+(?:\.\d+)?\s?% (?:or less )?of|one or more of(?: the following)?):?\s*/;

function parseItem(raw: string): ParsedIngredient | null {
  const text = raw.replace(/\*+/g, "").trim().replace(LESS_THAN, "").trim();
  if (text === "") return null;
  const paren = text.indexOf("(");
  const bracket = text.indexOf("[");
  const open = paren < 0 ? bracket : bracket < 0 ? paren : Math.min(paren, bracket);
  if (open < 0) return { name: text, parts: [] };
  const close = text.lastIndexOf(text[open] === "(" ? ")" : "]");
  if (close !== text.length - 1) return null;
  const name = text.slice(0, open).trim();
  const inner = text.slice(open + 1, close).trim();
  if (name === "" || inner === "") return null;
  if (PURPOSE_NOTES.has(inner)) return { name, parts: [] };
  const parts = splitItems(inner);
  if (parts === null || parts.length === 0) return null;
  return { name, parts };
}

function plantOnly(item: ParsedIngredient): boolean {
  return PLANT_INGREDIENTS.has(item.name) && item.parts.every(plantOnly);
}

/** Every item (and every sub-item) is on the fixed plant list. */
export function isPlantOnlyStatement(text: string | null | undefined): boolean {
  const items = parseIngredientStatement(text);
  return items !== null && items.every(plantOnly);
}

/**
 * Whether the food's own complete label rules out an animal facet. The caller decides `present`
 * first (lib/policy/diet-evidence.ts: the food's words, tags, stored evidence and held rows), so
 * this only ever turns an `unknown` into `absent`.
 */
export function dietLabelRulesOut(
  facet: string, e: { ingredientsText?: string | null; ingredientsTextIsLabel?: boolean },
): boolean {
  if (!(LABEL_CLEARABLE_FACETS as readonly string[]).includes(facet)) return false;
  if (e.ingredientsTextIsLabel === false) return false;
  return isPlantOnlyStatement(e.ingredientsText);
}
