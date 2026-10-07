/**
 * The whole-food class table lib/policy/whole-foods.ts classifies names against (split out
 * 2026-10-03 to keep both modules under the house size limit). Read that module's doc first: a
 * class here only ever fills the `no_evidence` gap for a plain, single-ingredient food, and a
 * name outside this table gets no clearance at all. Pure. No I/O.
 */

export type WholeFoodClass = {
  label: string;
  /** Matched against the name once cooking-state words and punctuation are stripped. */
  pattern: RegExp;
  /** Oats vary by a "gluten-free" claim in the name; every other class is a fixed set. */
  intrinsic: (normalizedName: string) => readonly string[];
};

const fixed = (...keys: readonly string[]) => () => keys;

const GLUTEN_FREE_CLAIM = /\bgluten[\s-]?free\b/;

/**
 * One row per class: the allergens it is allowed to escape clearance for never changes except for
 * oats, whose cross-contact risk is a labelling claim, not a word in the food's own identity.
 */
export const WHOLE_FOOD_CLASSES: readonly WholeFoodClass[] = [
  { label: "fish", intrinsic: fixed("fish"), pattern: new RegExp(
    "^(?:(?:ahi|yellowfin|albacore|skipjack|bluefin|bigeye|chunk light|white)\\s+)?" +
    "(?:fish|tuna|salmon|cod|tilapia|halibut|trout|haddock|pollock|sardines?|mackerel|" +
    "anchov(?:y|ies)|bass|herring|catfish|swordfish|snapper|flounder|sole)s?$") },
  { label: "shellfish", intrinsic: fixed("shellfish", "crustacean"), pattern: new RegExp(
    "^(?:shrimps?|prawns?|crabs?|lobsters?|crayfish|crawfish|langoustines?|mussels?|clams?|" +
    "oysters?|scallops?|squid|calamari|octopus|krill)$") },
  { label: "poultry", intrinsic: fixed(), pattern: new RegExp(
    "^(?:ground\\s+)?(?:chicken|turkey|duck|goose|hen|cornish hen)" +
    "(?:\\s+(?:breasts?|thighs?|drumsticks?|wings?|legs?|tenderloins?))?$") },
  { label: "red meat", intrinsic: fixed(), pattern: new RegExp(
    "^(?:ground\\s+)?(?:beef|pork|lamb|veal|bison|venison|goat|mutton|" +
    "(?:sirloin|ribeye|rib eye|strip|flank|skirt|flat iron|t-bone|porterhouse)\\s+steak)" +
    "(?:\\s+(?:steaks?|chops?|loins?|tenderloins?|ribs?|roasts?))?$") },
  { label: "egg", intrinsic: fixed("egg"),
    pattern: /^eggs?(?:\s+(?:whites?|yolks?))?$/ },
  { label: "dairy", intrinsic: fixed("dairy"), pattern: new RegExp(
    "^(?:milk|cream|butter|ghee|kefir|whey|cheese|cheddar|mozzarella|parmesan|ricotta|" +
    "cottage cheese|yogurt|yoghurt)$") },
  // Cross-contact risk, not an ingredient word: the gluten mark only clears on an explicit claim.
  // Grok audit round 5 (HIGH): oats' cross-contact is wheat as well as gluten.
  { label: "oats", intrinsic: (name) => (GLUTEN_FREE_CLAIM.test(name) ? [] : ["gluten", "wheat"]),
    pattern: /^(?:oats?|rolled oats|steel-cut oats|oatmeal)(?:\s+gluten[\s-]?free)?$/ },
  { label: "grain", intrinsic: fixed("gluten", "wheat"), pattern: new RegExp(
    "^(?:wheat(?:\\s+berries)?|barley|rye|spelt|farro|semolina|couscous|bulgur|durum|kamut|" +
    "einkorn|emmer|triticale)s?$") },
  { label: "grain", intrinsic: fixed(), pattern: new RegExp(
    "^(?:(?:(?:white|brown|jasmine|basmati|wild|long-grain|medium-grain|short-grain)\\s+)?rice|" +
    "quinoa|buckwheat|millet)$") },
  // The card names the class ("Plain potato has no dairy"), so potatoes and corn are not "grain".
  { label: "potato", intrinsic: fixed(), pattern: /^(?:sweet\s+)?potato(?:es)?$/ },
  { label: "corn", intrinsic: fixed(), pattern: /^corn$/ },
  { label: "legume", intrinsic: fixed(), pattern: new RegExp(
    "^(?:(?:(?:black|pinto|kidney|lima|navy|white)\\s+)?beans?|lentils?|chickpeas?|" +
    "garbanzo beans?|peas?)$") },
  // 2026-10-02 DeepSeek audit via Grok (finding C): tempeh dropped — commercial tempeh can be
  // grain-inoculated (barley), so it must not clear gluten as a plain single-ingredient soy food.
  // "Contains soy" still fires independently: tempeh is one of allergens.ts's own soy keywords.
  { label: "soy", intrinsic: fixed("soy"), pattern: /^(?:soybeans?|tofu|edamame)$/ },
  { label: "tree nuts", intrinsic: fixed("tree-nut"), pattern: new RegExp(
    "^(?:almonds?|cashews?|walnuts?|pecans?|pistachios?|hazelnuts?|macadamias?|" +
    "brazil nuts?|pine nuts?|filberts?)$") },
  { label: "peanuts", intrinsic: fixed("peanut"), pattern: /^(?:peanuts?|groundnuts?)$/ },
  { label: "sesame", intrinsic: fixed("sesame"), pattern: /^sesame(?:\s+seeds?)?$/ },
  { label: "seeds", intrinsic: fixed(), pattern: new RegExp(
    "^(?:chia|flax|pumpkin|sunflower|hemp)\\s+seeds?$") },
  { label: "vegetables", intrinsic: fixed(), pattern: new RegExp(
    "^(?:broccoli|spinach|carrots?|cauliflower|kale|cabbage|zucchini|cucumbers?|lettuce|" +
    "bell peppers?|onions?|garlic|tomato(?:es)?|celery|asparagus|green beans?|mushrooms?)$") },
  { label: "fruit",
    // 2026-10-02 DeepSeek audit round 3 (F6): FDA lists coconut among tree nuts for labelling, so
    // coconut alone keeps the tree-nut mark even though it is otherwise a plain fruit — fail
    // closed. Every other name in this class keeps its existing, unaffected clearance.
    intrinsic: (name) => (/^coconuts?$/.test(name) ? ["tree-nut"] : []),
    pattern: new RegExp(
      "^(?:apples?|bananas?|oranges?|grapes?|strawberries|blueberries|pears?|peaches?|plums?|" +
      "mangoe?s?|pineapples?|watermelons?|melons?|cantaloupes?|honeydews?|cherries|kiwis?|lemons?|limes?|apricots?|" +
      "nectarines?|raspberries|blackberries|cranberries|pomegranates?|figs?|dates?|coconuts?|" +
      "avocados?)$") },
  // Live trace 2026-10-02: the composer fills fat first, and no fat ever cleared on a gluten- and
  // dairy-free account. Only olive and avocado oil: a nut, seed or soy oil is left to its label.
  { label: "plant oil", intrinsic: fixed(),
    // 2026-10-03: also the catalog's head-first spelling of the same single oil ("Oil, olive, salad
    // or cooking", "Oil, avocado"). A blend, spray or infused oil matches neither form.
    pattern: /^(?:(?:(?:extra[\s-]virgin\s+)?olive|avocado)\s+oil|oil\s+(?:olive|avocado))$/ },
  // 2026-10-03: plain drinking water ("Water, bottled, generic"). Flavored, tonic, coconut,
  // sparkling-flavored or enhanced water does not match this name.
  { label: "water", intrinsic: fixed(), pattern:
    /^(?:(?:bottled|tap|drinking|spring)\s+)?water(?:\s+(?:bottled|tap|drinking|municipal|spring)(?:\s+generic)?)?$/ },
];
