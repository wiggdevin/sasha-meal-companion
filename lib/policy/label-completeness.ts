/**
 * Phase 13 §9 R1 — ORCHESTRATOR RULING (round 7, closes the completeness class for good). The ONE
 * strict predicate every allergen-evidence path (warm, barcode, capture, search, detail,
 * suggestion) uses to decide whether a label statement is COMPLETE. Supersedes the earlier
 * majority-vote check (the old `itemReadsAsEnglish` in lib/policy/allergens.ts): every word of
 * every item must resolve, not most of them, and text that is not the label's own verbatim
 * statement can never read as complete no matter its shape.
 *
 * COMPLETE only when ALL of these hold:
 *   (a) verbatim — the exact printed/scanned/typed statement (seq-1 `raw_text`, or the label text
 *       a scan/photo/typed entry carries), never a join of parsed ingredient NAMES.
 *   (b) an explicit terminator — a final period, or a following "Contains …"/"May contain …"
 *       clause that itself names at least one item. A cropped "may contain" with nothing after it
 *       is NOT a terminator.
 *   (c) at least three items.
 *   (d) every item tokenizes into words that ALL resolve in the ingredient lexicon — one garbled
 *       token ("???"), one word outside the lexicon ("leche"), or one empty item makes the WHOLE
 *       statement incomplete. No majority rule.
 *   (e) the text did not arrive through a lossy path (a caller-declared fact this module trusts
 *       and never tries to infer).
 *
 * False negatives — calling a genuinely complete label incomplete — are accepted by design: this
 * predicate would rather leave a label unverified than clear it wrongly. Never loosen it to chase
 * one.
 */

export type LabelStatementSource = {
  text: string | null | undefined;
  /** (a): true only when `text` is the verbatim printed/scanned/typed statement itself. */
  verbatim: boolean;
  /** (e): true when `text` passed through a lossy step (a truncated fetch, a stripped bilingual
   * gloss, a garbled OCR normalization, a lossy join, …) and must never read as complete. */
  lossy?: boolean;
};

/** Ingredient names and modifiers a real English label commonly uses. Recognizing a word here
 * never by itself completes an item — (d) still requires every OTHER word in the same item to
 * resolve too. */
const SUBSTANCE_WORDS = new Set([
  "water", "salt", "sugar", "flour", "oil", "milk", "wheat", "rice", "corn", "starch", "vinegar",
  "egg", "eggs", "soy", "acid", "syrup", "cocoa", "butter", "cream", "yeast", "spice", "spices",
  "pepper", "garlic", "onion", "tomato", "chicken", "beef", "pork", "fish", "sodium", "vitamin",
  "citric", "lecithin", "oat", "oats", "honey", "juice", "protein", "gum", "sauce", "seed",
  "seeds", "nut", "nuts", "sunflower", "canola", "palm", "olive", "coconut", "vegetable",
  "soybean", "whey", "modified", "enriched", "bleached", "unbleached", "dried", "ground", "whole",
  "skim", "cane", "brown", "dextrose", "fructose", "glucose", "maltodextrin", "caramel",
  "carrageenan", "pectin", "gelatin", "gelatine", "inulin", "xanthan", "guar", "stevia",
  "aspartame", "sucralose", "saccharin", "malt", "barley", "rye",
]);

/** Words that describe or qualify a substance rather than name one, but are still ordinary,
 * legitimate label vocabulary — "natural flavor" is a ubiquitous real phrase, not a foreign gloss. */
const DESCRIPTOR_WORDS = new Set([
  "natural", "artificial", "flavor", "flavour", "flavors", "flavours", "flavoring", "flavorings",
  "flavouring", "flavourings", "extract", "extracts", "powder", "powdered", "concentrate",
  "concentrated", "isolate", "isolates", "solids", "color", "colour", "colors", "colours",
  "preservative", "preservatives", "stabilizer", "stabilizers", "stabiliser", "stabilisers",
  "emulsifier", "emulsifiers", "thickener", "thickeners", "sulfite", "sulfites", "sulphite",
  "sulphites", "dioxide", "monosodium", "glutamate", "regulator", "regulators", "agent", "agents",
  "less", "than",
]);

/** Connectors and boilerplate around the substance word that actually matters. */
const CONNECTOR_WORDS = new Set([
  "of", "and", "or", "in", "with", "no", "not", "a", "an", "the", "for", "per", "contains",
  "contain", "may", "from",
]);

/** Every single word ALLERGEN_RULES' own keyword lists use ("sesame", "shrimp", "brazil nut"
 * split into "brazil" and "nut", …), mirrored directly rather than imported — lib/policy/
 * allergens.ts imports THIS module, so importing it back here would be a cycle. A real label's
 * own allergen-declaring words are exactly as "recognized" as any other ingredient word. */
const ALLERGEN_LEXICON = new Set([
  "dairy", "milk", "milks", "cheese", "cheeses", "buttermilk", "whey", "casein", "caseinate",
  "caseinates", "butterfat", "yogurt", "yoghurt", "lactose", "ghee", "kefir", "curd", "curds",
  "lactalbumin", "lactoglobulin", "paneer", "ricotta", "mozzarella", "parmesan", "cheddar",
  "cocoa", "cacao", "shea", "peanut", "almond", "cashew", "apple", "thistle", "butternut",
  "albumen", "albumin", "ovalbumin", "lysozyme", "mayonnaise", "meringue", "yolk", "yolks",
  "soya", "soybean", "soybeans", "tofu", "edamame", "tempeh", "miso", "tamari", "shoyu",
  "peanuts", "groundnut", "groundnuts", "arachis", "cacahuate", "cacahuates", "cacahuete",
  "cacahuetes", "almonds", "cashews", "walnut", "walnuts", "pecan", "pecans", "pistachio",
  "pistachios", "hazelnut", "hazelnuts", "macadamia", "macadamias", "brazil", "pine", "praline",
  "marzipan", "filbert", "filberts", "nutmeg", "doughnut", "donut", "tiger", "anchovy",
  "anchovies", "salmon", "tuna", "cod", "haddock", "pollock", "tilapia", "sardine", "sardines",
  "mackerel", "trout", "halibut", "bass", "herring", "catfish", "swordfish", "snapper", "flounder",
  "sole", "worcestershire", "sesame", "tahini", "tahina", "benne", "gingelly", "spelt", "semolina",
  "durum", "farina", "farro", "couscous", "seitan", "bulgur", "kamut", "einkorn", "emmer",
  "triticale", "gluten", "shellfish", "shrimp", "shrimps", "prawn", "prawns", "crab", "crabs",
  "lobster", "lobsters", "crayfish", "crawfish", "langoustine", "mussel", "mussels", "clam",
  "clams", "oyster", "oysters", "scallop", "scallops", "squid", "calamari", "octopus", "krill",
  "nut-free",
]);

const LEXICON = new Set([
  ...SUBSTANCE_WORDS, ...DESCRIPTOR_WORDS, ...CONNECTOR_WORDS, ...ALLERGEN_LEXICON,
]);

/** Whitespace-separated tokens of one item. Unlike a `\p{L}+` letter-run scan over the whole
 * item, this never silently drops a garbled token ("???") that sits next to a real word — every
 * whitespace-delimited token has to show up here and then resolve on its own. */
function tokensOf(item: string): string[] {
  return item.trim().split(/\s+/).filter((token) => token.length > 0);
}

/** (d): every token of one comma-separated item must resolve; an empty item, a token that is pure
 * punctuation once its edges are trimmed (a garbled token like "???", a bare "Contains:"'s colon
 * survives the trim as "Contains"), or a token with punctuation INSIDE it (a real garble like
 * "wa??er") always fails the whole item — never dropped, never carried by a neighboring real
 * word. */
function itemIsResolved(item: string): boolean {
  if (item.trim() === "") return false;
  const tokens = tokensOf(item);
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    const stripped = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (stripped.length === 0) return false;
    if (!/^\p{L}+$/u.test(stripped)) return false;
    return LEXICON.has(stripped.toLowerCase());
  });
}

/** (b): a "Contains"/"May contain" clause that names something after it, or — only when the
 * statement carries no such clause at all — a final period. The Contains/May-contain check runs
 * FIRST and unconditionally: a trailing period must never short-circuit past an unnamed clause
 * (an OCR-mangled "Contains:" colon commonly reads as a period, and that clause is typically a
 * label's last printed line, so a cropped scan is likely to end right after it — "Contains." must
 * stay a non-terminator, not read as a bare completed sentence). A lone trailing "!" is not a
 * terminator either; only a final period or a naming Contains/May-contain clause counts. */
function hasTerminator(trimmed: string): boolean {
  const match = /\b(?:may\s+contain|contains?)\b\s*:?\s*(.*)$/i.exec(trimmed);
  if (match) return match[1].trim().replace(/[.!]+$/, "").length > 0;
  return /\.$/.test(trimmed);
}

export function isCompleteLabelStatement(source: LabelStatementSource): boolean {
  if (!source.verbatim || source.lossy) return false;
  const text = source.text;
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const items = trimmed.split(",").map((part) => part.trim());
  if (items.length < 3) return false;
  if (!items.every(itemIsResolved)) return false;
  return hasTerminator(trimmed);
}

