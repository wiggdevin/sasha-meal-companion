/**
 * Catalog revision → the five `banned_categories` keys the Avoids switches name — T1 §3.
 *
 * `catalog_food_revisions.category` carries the PROVIDER's taxonomy (SR Legacy / Foundation group
 * names, FNDDS WWEIA names, OFF category tags), which never lines up with their five switches. So a
 * switch was a promise the policy could not keep: audit ruling 3. This file is the mapping, and
 * `catalog_food_revisions.policy_categories` is where its answer is stored (one annotation pass
 * per import, `scripts/annotate-policy-categories.ts`), so the request path compares arrays of
 * controlled keys and never a free-text string.
 *
 * The rules are DATA, not prose: one row per key, saying what the description must contain, what
 * it must not, and what the provider category may not be. Precision is the gate (≥ 0.95 on a
 * hand-labelled sample per key) and recall is only reported, so every exclusion is deliberately
 * cheap to add — an exclusion can cost recall, never precision.
 *
 * Revised 2026-09-17 after the panel's first labelled run. `docs/catalog/category-map.md` records
 * each rule, the ground truth it was measured against, and why it is written this way.
 *
 * Pure. No I/O.
 */

export const POLICY_CATEGORY_KEYS = [
  "raw_cruciferous", "raw_leafy_greens", "onion_garlic", "beans", "simple_sugars",
] as const;

export type PolicyCategoryKey = (typeof POLICY_CATEGORY_KEYS)[number];

/**
 * What the annotator reads off an active revision.
 *
 * `catalog_foods.source` is deliberately NOT an input. It was one until round 2, when the branded
 * carve-out for `onion_garlic` turned out to be the wrong axis — a flavour name reads the same
 * whoever published it — and nothing has needed the provider since. A branded row and a USDA row
 * with the same words get the same answer.
 */
export type CategorizableRevision = {
  category: string | null;
  description: string;
};

type Rule = {
  key: PolicyCategoryKey;
  /** Every term the description must contain one of. */
  description: RegExp;
  /** A term that disqualifies the row whatever else it says. */
  descriptionNot?: RegExp;
  /**
   * The row must name no preparation at all. USDA and FNDDS say "raw" inconsistently — "Spinach,
   * baby" and "Radish" are raw rows that never use the word — so the raw keys test for the ABSENCE
   * of a preparation rather than the presence of "raw". A row that says both ("Cauliflower,
   * roasted, raw as purchased") is still excluded, which is what the presence test used to do.
   */
  unprepared?: boolean;
  /** A provider category that disqualifies the row. Category is used to exclude, never to require. */
  categoryNot?: RegExp;
  /**
   * Match `description` against the HEAD of the row rather than the whole of it. USDA writes the
   * food first and its qualifiers after: "Rhubarb, frozen, cooked, with sugar" is rhubarb, and
   * "Raspberries, canned, red, heavy syrup pack" is raspberries. Reading the whole row made 21 of
   * the first production sample's 30 `simple_sugars` rows wrong. `descriptionNot` still reads the
   * whole row, because a disqualifier anywhere is still a disqualifier.
   */
  headOnly?: boolean;
};

/** The container words USDA files a sweetener under, so the segment after one is still the head. */
const CONTAINER_HEAD = /^(syrups?|sugars?|sweeteners?|jams?|jell(y|ies)|preserves?|marmalades?)$/;

/** The first comma-separated segment, plus the second when the first is only a container word. */
function headOf(text: string): string {
  const parts = text.split(",").map((part) => part.trim());
  const head = parts[0] ?? "";
  return CONTAINER_HEAD.test(head) && parts.length > 1 ? `${head}, ${parts[1]}` : head;
}

/**
 * A COMPOSED pickle — a "Pickles," prefix, a relish, a chowchow — is a negative for every key: the
 * onion in a chowchow's ingredient list is a question about that list, which is T3's work, not a
 * row that names onion. "Pickles, chowchow, with cauliflower onion mustard, sweet" is the row that
 * proved it, a false positive for cruciferous in round 2 and for onion_garlic in round 3.
 *
 * `pickle` / `pickled` on its own is NOT here. "Pickled onions" is still onion, and the user reacts to
 * the allium however it was kept; it is only the RAW keys that a pickled form contradicts, and
 * PREPARED below carries it for them.
 */
const COMPOSED_PICKLE = /\bpickles\b|\bchowchow\b|\brelish\b/;

/**
 * Any word that says this row is not the raw vegetable: a cooking method, or a preservation method.
 * Fermented, salted, brined, canned, dried and frozen forms are all the preserved product rather
 * than the vegetable — "Cabbage, mustard, salted" is not raw cabbage. Pickling is here rather than
 * in COMPOSED_PICKLE above, because it contradicts "raw" without making the row a different food.
 */
const PREPARED =
  /\b(cooked|boiled|steamed|roasted|baked|braised|saut[eé]ed|fried|grilled|blanched|pickled?|fermented|salted|brine[ds]?|cured|canned|frozen|dried|dehydrated|creamed|unprepared|prepared|souffl[eé]|quiche|casserole|lasagna|soup|stew|dip|pizza|omelet(te)?|chips?|crisps?|snacks?|juice|powder|sauce)\b/;

/**
 * A second, narrower net for the raw keys: a protein, a starch, a condiment, a seaweed or a
 * sandwich in the name makes this a composed product, not the vegetable. "Beef and broccoli",
 * "Spaghetti, spinach, dry" and "SUBWAY, SUBWAY CLUB sub on white bread with lettuce and tomato"
 * name no cooking method and would otherwise read as the raw green. `with lettuce` is here for the
 * same reason: a row that lists a leaf among its fillings is named after something else.
 */
const DISH =
  /\b(beef|chicken|pork|turkey|lamb|shrimp|steak|bacon|sausage|ham|noodles?|pasta|spaghetti|macaroni|ravioli|dumplings?|couscous|rice|stir[\s-]?fry|gratin|curry|risotto|burrito|taco|quesadilla|wrap|sandwich|bowl|subs?|burgers?|breads?|kimchi|sauerkraut|dressings?|seaweed|kelp|nori|wakame|laver)\b|\bwith\s+lettuce\b/;

/**
 * "Caesar salad, with romaine, no dressing" is a raw row that names a dressing only to deny it, and
 * FNDDS writes a lot of rows this way ("no added fat", "no salt"). Drop the denied word before the
 * preparation nets run, so a negation cannot disqualify the row it was written to qualify.
 */
function withoutNegations(text: string): string {
  return text.replace(/\bno\s+\w+/g, " ");
}

/** "flavor", "flavored", "flavour", "-flavor": the product tastes of it, it is not made of it. */
const FLAVOUR = /flavou?r/;

const RULES: readonly Rule[] = [
  {
    key: "raw_cruciferous",
    description:
      /\b(broccolis?|broccolini|cauliflowers?|cabbages?|kale|brussels?|bok\s+choy|pak\s+choi|arugulas?|rocket|radish(es)?|daikon|collards?|kohlrabi|turnip\s+greens?|watercress|cress|mustard\s+greens?|rutabagas?)\b/,
    unprepared: true,
  },
  {
    key: "raw_leafy_greens",
    // arugula, cress and watercress are leaves AND brassicas, and the panel's sample labels them
    // under both keys; both keys are banned by default, so a row simply carries both. Kale and
    // collards stay cruciferous-only — the panel did not report them as leafy misses.
    description:
      /\b(lettuces?|spinach|chard|endives?|escaroles?|mesclun|salad\s+greens?|mixed\s+greens?|romaine|iceberg|radicchio|fris[eé]e|arugulas?|rocket|watercress|cress|beet\s+greens?|dandelion\s+greens?|spring\s+mix)\b/,
    unprepared: true,
  },
  {
    key: "onion_garlic",
    description: /\b(onions?|garlics?|shallots?|leeks?|scallions?|chives?|ramps?)\b/,
    // The allium itself is a positive however it is cooked — onion rings, garlic bread, onion dip,
    // French onion soup and garlic sauce all are. What is NOT a positive is a product that merely
    // tastes of it ("sour cream and onion flavored") or a seasoning made of it (onion powder,
    // garlic salt). A flavouring inside a product is judged from its ingredient list, which is T3.
    descriptionNot:
      /flavou?r|\b(powder|powdered|granulated|granules)\b|\b(onion|garlic|shallot|leek|scallion|chive)s?\s*[,-]?\s*salt\b/,
  },
  {
    key: "beans",
    // The pulse itself, and dishes named after it. Bare "pea" is deliberately NOT here: "Green
    // peas" and "Peas, cooked, from restaurant" are the vegetable, and every pulse pea names
    // itself (split, black-eyed, pigeon, field, crowder, cow, chick).
    description:
      /\b(beans?|lentils?|chickpeas?|garbanzos?|pulses?|edamame|soybeans?|cowpeas?|favas?|limas?|split\s+peas?|peas?,\s*split|black[\s-]?eyed\s+peas?|pigeon\s+peas?|field\s+peas?|crowder\s+peas?|dried\s+peas?)\b/,
    // tofu, tempeh, hummus and refried stay allowed (the coach's call, T1 §3). The pods are a
    // vegetable, not a pulse, and so are "immature seeds" — a green shelled bean is eaten as a
    // vegetable. The rest are homonyms or a different food wearing the word.
    descriptionNot:
      /\b(tofu|tempeh|hummus|houmous|refried|bean\s+sprouts?|sprouted|vanilla|coffee|cocoa|cacao|jelly|jellybeans?|pea\s+protein|immature|edible-podded|snap|snow\s+peas?|green\s+beans?|beans?,\s*green|string\s+beans?|wax\s+beans?|haricots?\s+verts?|green\s+peas?|peas?,\s*green)\b|\b(soy)?beans?\s+(oil|lecithin)\b/,
  },
  {
    key: "simple_sugars",
    // The sweetener or the sweet spread itself. Bare "nectar" is absent: a fruit nectar is a drink
    // and a nectarine is a fruit. Bare "agave" is absent too — the plant is a Southwest vegetable
    // ("Agave, raw", "Agave, cooked"), so only the sweetener forms of it count.
    description:
      /\b(honey|syrups?|sugars?|sweeteners?|jams?|jell(y|ies)|marmalades?|preserves?|molasses|treacle)\b|\bagave\s+(syrups?|nectars?|liquid|sweeteners?)\b/,
    // "Jams, preserves, marmalade, reduced sugar" is a jam; "Plums, dried, with added sugar" is a
    // plum. The noun decides and its POSITION is what says whether it is the noun or a qualifier.
    headOnly: true,
    // Confectionery and baked goods that merely CONTAIN a sweetener, fruits and drinks named after
    // one, condiments made with one, and anything that says it has no sugar. "reduced sugar" and
    // "fruit juice sweetened" are NOT exclusions — those rows are still the spread itself.
    descriptionNot:
      /\bsugar[\s-]*free\b|\bno\s+sugar\b|\bunsweetened\b|\bsugar[\s-]*substitute|\bsugar[\s-]?apples?\b|\bsweetsop\b|\bsyrup\s+pack\b|\bin\s+syrup\b|\b(heavy|light|extra\s+heavy)\s+syrup\b|\broasted\b|\bglazed?\b|\bcoated\b|\bcandied\b|\bcand(?:y|ies)\b|\bjell(?:y|ies)?\s*beans?\b|\bjellybeans?\b|\bchews?\b|\bnougat\b|\bgumdrops?\b|\bcookies?\b|\bbiscuits?\b|\bcrackers?\b|\bcakes?\b|\bpies?\b|\bpastr(y|ies)\b|\bmuffins?\b|\bbrownies?\b|\bbuns?\b|\bdough?nuts?\b|\brolls?\b|\bbreads?\b|\bcereals?\b|\bgranolas?\b|\bbars?\b|\bsandwich(es)?\b|\bice\s+cream\b|\byogh?urts?\b|\bmilks?\b|\bmustards?\b|\bdressings?\b|\bmarinades?\b|\bpeanut\s+butter\b|\bpeanuts?\b|\bbeverages?\b|\bdrinks?\b|\bsodas?\b|\bcolas?\b|\blemonades?\b|\bpunch\b|\bteas?\b|\bcoffees?\b|\bsmoothies?\b|\bshakes?\b|\bsnaps?\b|\bpeas?\b/,
    categoryNot: /beverage|baked\s+product|snack/,
  },
] as const;

function matches(rule: Rule, text: string, category: string): boolean {
  if (!rule.description.test(rule.headOnly ? headOf(text) : text)) return false;
  if (COMPOSED_PICKLE.test(text)) return false;
  if (rule.unprepared) {
    const plain = withoutNegations(text);
    if (PREPARED.test(plain) || DISH.test(plain) || FLAVOUR.test(plain)) return false;
  }
  if (rule.descriptionNot?.test(text)) return false;
  if (category !== "" && rule.categoryNot?.test(category)) return false;
  return true;
}

/**
 * 2026-10-02 DeepSeek audit round 3 (F2): whether a catalog source is a packaged product — a
 * branded USDA row or an Open Food Facts scan — as opposed to a generic USDA commodity entry
 * (Foundation/SR Legacy/FNDDS, an unbranded "Chicken breast, raw"). Packaged by definition,
 * whether or not the row's own `brand` string happens to be set (an unbranded store label is
 * still packaged) — lib/policy/whole-foods.ts classifyWholeFood's own `packaged` input never
 * grants whole-food clearance to one. Plain string, not `CatalogSource`: this file is imported by
 * both lib/server/catalog.ts (server-only) and lib/coach/suggest-policy.ts (dynamic-imports its
 * server reads), and neither needs the other's type just to ask this one question.
 */
export function isPackagedCatalogSource(source: string | null | undefined): boolean {
  return source === "off" || source === "fdc_branded";
}

/**
 * The keys this revision belongs to, in the rule table's order. Never throws, never mutates its
 * input, and answers `[]` for anything no rule names — an unrecognised food is not blocked.
 */
export function policyCategoriesFor(revision: CategorizableRevision): PolicyCategoryKey[] {
  const text = revision.description.toLowerCase();
  const category = (revision.category ?? "").trim().toLowerCase();
  const out: PolicyCategoryKey[] = [];
  for (const rule of RULES) {
    if (matches(rule, text, category)) out.push(rule.key);
  }
  return out;
}
