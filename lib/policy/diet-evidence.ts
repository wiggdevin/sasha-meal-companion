/**
 * Phase 18 W2c (docs/specs/phase-18-open-world-foods.md D4, D9, §10 W2c): deterministic evidence
 * for the diet, religious and profile hard-rule facets. Jev has no input here, and the removal
 * fails closed the same way W2a did for allergens:
 *
 * - `present` only from the food's own words or stored deterministic evidence: its name or
 *   ingredient text names the facet (the keyword tables below, or lib/policy/allergens.ts's own
 *   tables for an allergen-backed facet), a legacy tag lists it, or stored non-Jev evidence lists it.
 * - `absent` only from deterministic evidence of absence: the whole-food class rules the facet out
 *   (lib/policy/whole-foods.ts), a reviewed starter outcome, for alcohol only a complete printed
 *   label (the strict lexicon in lib/policy/label-completeness.ts) that names nothing that can hide
 *   it, or, for an allergen-backed facet, the allergen finding's own deterministic absence. A label
 *   never clears an animal facet (animal_product, meat, pork, beef, fish_seafood, shellfish): W2c
 *   re-plan Option A.
 * - `unknown` otherwise. A held allergen row (a Jev-only `listed`, lib/policy/allergen-holds.ts)
 *   never clears a facet it backs. Silence never clears anything.
 *
 * Pure. No I/O. Reads no Jev facet (tests/policy/diet-rule-jev-removal.test.ts).
 */
import type { Facet } from "@/lib/foods/facet-vocabulary";
import {
  allergenFinding, allergenKey, looksLikeCompleteList, textNames, type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import type { FacetOutcome } from "@/lib/policy/facet-rules";
import { absentAnimalFacets, classifyWholeFood, clearanceNameOf } from "@/lib/policy/whole-foods";

/** The food's own deterministic inputs, the same fields `PolicyEvidence` carries. */
export type DietEvidence = {
  foodName?: string | null;
  wholeFoodName?: string | null;
  foodBrand?: string | null;
  packaged?: boolean;
  ingredientsText?: string | null;
  /** False for a self-authored food's own text: it may name a facet but never clears one. */
  ingredientsTextIsLabel?: boolean;
  allergenTags?: readonly string[] | null;
  allergenEvidence?: Readonly<Record<string, StoredAllergenEvidence>>;
  checkedAllergens?: readonly string[];
  /** Stored `policy_categories`; `null` is "never annotated". */
  category?: readonly string[] | null;
  /**
   * Reviewed, curated outcomes for an exact, unedited bundled starter row
   * (lib/foods/starter-evidence.ts). Deterministic catalog data, never a model judgment: a curated
   * `present` blocks, and a curated `absent` clears unless the food's own words name the facet or
   * a held allergen row backs it.
   */
  attestedFacets?: Readonly<Partial<Record<string, FacetOutcome>>>;
};

/** A frozen facet that is one allergen key's own question: the allergen finding decides it. */
const ALLERGEN_FACETS: Partial<Record<Facet, string>> = {
  contains_dairy: "dairy", contains_egg: "egg", contains_peanut: "peanut",
  contains_tree_nut: "tree-nut", contains_soy: "soy", contains_sesame: "sesame",
  contains_gluten: "gluten",
};

/** Land-animal flesh and its plain products (the meat facet's rubric: not fish). */
const MEAT_WORDS = [
  "meat", "meats", "beef", "veal", "pork", "ham", "bacon", "lamb", "mutton", "goat", "venison",
  "bison", "chicken", "turkey", "duck", "goose", "quail", "sausage", "sausages", "salami",
  "pepperoni", "prosciutto", "pancetta", "chorizo", "jerky", "brisket", "sirloin", "ribeye",
  "rib eye", "meatball", "meatballs", "hot dog", "hotdog", "bologna", "pastrami", "lard",
  "tallow", "suet", "oxtail", "hamburger", "hamburgers", "cheeseburger", "cheeseburgers",
  "poultry", "rabbit", "boar", "elk", "pheasant", "frankfurter", "frankfurters", "bratwurst",
  "kielbasa", "mortadella", "liverwurst",
  // Gelatin is rendered from animal skin and bone: a vegetarian rule blocks it (W2c r1). Fish
  // gelatin is excluded below; pork and beef stay open for plain gelatin.
  "gelatin", "gelatine",
];
const MEAT_EXCLUSIONS = [
  "coconut meat", "crab meat", "lobster meat", "nut meat", "meatless", "plant-based meat",
  "plant based meat", "vegan meat", "meat substitute", "meat alternative", "goat cheese",
  "goat milk", "goat's milk", "goats milk", "duck sauce", "beef tomato", "beef tomatoes",
  "vegan bacon", "veggie bacon", "imitation bacon", "vegan sausage", "veggie sausage",
  // A mushroom, a bun and a "free from" claim name no flesh (W2c edge review).
  "chicken of the woods", "meat-free", "meat free", "hot dog bun", "hot dog buns",
  "hamburger bun", "hamburger buns", "fish gelatin", "fish gelatine",
];
const PORK_WORDS = [
  "pork", "ham", "bacon", "lard", "prosciutto", "pancetta", "guanciale", "pork rind",
  "pork rinds", "chicharron", "chicharrones", "boar", "swine", "hog", "hogs", "pig", "pigs",
  "porcine", "carnitas",
];
const PORK_EXCLUSIONS = [
  "turkey bacon", "turkey ham", "beef bacon", "vegan bacon", "veggie bacon", "imitation bacon",
  "bacon flavor", "bacon flavour", "bacon flavored", "bacon flavoured",
];
const BEEF_WORDS = ["beef", "veal", "brisket", "sirloin", "ribeye", "rib eye", "oxtail", "corned beef"];
const BEEF_EXCLUSIONS = ["beef tomato", "beef tomatoes", "plant-based beef", "vegan beef"];
const SEAFOOD_WORDS = ["seafood", "seafoods", "caviar", "roe", "eel", "fish sauce"];
const ANIMAL_EXTRA_WORDS = [
  "honey", "gelatin", "gelatine", "lard", "tallow", "suet", "carmine", "cochineal", "collagen",
  "isinglass", "shellac", "lanolin", "beeswax", "royal jelly", "bone broth", "bone char",
];
const ALCOHOL_WORDS = [
  "alcohol", "ethanol", "wine", "wines", "beer", "beers", "ale", "lager", "rum", "vodka",
  "whiskey", "whisky", "bourbon", "brandy", "cognac", "gin", "tequila", "mezcal", "sake",
  "mirin", "liqueur", "liquor", "sherry", "vermouth", "champagne", "prosecco", "hard cider",
  "soju", "shochu", "baijiu",
];
const ALCOHOL_EXCLUSIONS = [
  "wine vinegar", "sugar alcohol", "sugar alcohols", "alcohol-free", "alcohol free",
  "ginger ale", "root beer", "ginger beer", "birch beer", "sherry vinegar", "champagne vinegar",
];

/**
 * Words that keep a complete label from clearing alcohol ("vanilla extract", "natural flavor",
 * brewed soy sauce, kefir). Phase 18 W2c re-plan (Option A): a label never clears an animal facet
 * at all, so there is no animal-origin word table here.
 */
const ALCOHOL_UNCERTAIN = [
  "natural", "artificial", "flavor", "flavour", "flavors", "flavours", "flavoring", "flavorings",
  "flavouring", "flavourings", "extract", "extracts", "fermented", "cider", "kombucha",
  // Brewed soy sauces and kefir can carry alcohol; an unnamed "sauce" may hold wine.
  "kefir", "sauce", "sauces", "miso", "tamari", "shoyu",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lowerText = (e: DietEvidence) => [e.foodName, e.ingredientsText].filter(Boolean).join(" ").toLowerCase();

function names(text: string, words: readonly string[], exclusions: readonly string[] = []): boolean {
  const stripped = exclusions.reduce((current, phrase) => current.replaceAll(phrase, " "), text);
  return words.some((word) => new RegExp(`(^|[^a-z])${escape(word)}([^a-z]|$)`).test(stripped));
}

function tagged(e: DietEvidence, keys: readonly string[]): boolean {
  return (e.allergenTags ?? []).some((tag) => keys.includes(allergenKey(tag)));
}

/** A stored row for one of these allergens is a deterministic `listed` (not a hold). */
function storedListed(e: DietEvidence, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const row = e.allergenEvidence?.[key];
    return row?.level === "listed" && row.held !== true;
  });
}

/** A held row (Jev-only `listed`) for one of these allergens: it never clears the facet. */
function held(e: DietEvidence, keys: readonly string[]): boolean {
  return keys.some((key) => e.allergenEvidence?.[key]?.held === true);
}

/**
 * The diet facets read from the food's own words. `shellfish` is one of them: as a diet or
 * religious rule (vegetarian, kosher) a complete ingredient list names a mollusc like any other
 * ingredient, unlike an allergen statement, which need not (an allergy to shellfish stays on the
 * allergen floor, lib/policy/allergens.ts).
 */
type TextFacet = "meat" | "pork" | "beef" | "shellfish" | "fish_seafood" | "animal_product" | "alcohol";

const RELATED_ALLERGENS: Record<TextFacet, readonly string[]> = {
  meat: [], pork: [], beef: [], alcohol: [], shellfish: ["shellfish", "crustacean"],
  fish_seafood: ["fish", "shellfish", "crustacean"],
  animal_product: ["dairy", "egg", "fish", "shellfish", "crustacean"],
};

/**
 * Plant foods whose names borrow a seafood word. The allergen keyword tables (lib/policy/
 * allergens.ts) read them as shellfish, which is fail-closed for an allergy; a diet rule strips
 * them first so a vegetarian's oyster mushrooms are not blocked as seafood.
 */
const SEAFOOD_NAME_EXCLUSIONS = [
  "oyster mushrooms", "oyster mushroom", "crab apples", "crab apple", "crabapples", "crabapple",
];

function namesFacet(facet: TextFacet, raw: string): boolean {
  const text = SEAFOOD_NAME_EXCLUSIONS.reduce((current, phrase) => current.replaceAll(phrase, " "), raw);
  switch (facet) {
    case "meat": return names(text, MEAT_WORDS, MEAT_EXCLUSIONS);
    case "pork": return names(text, PORK_WORDS, PORK_EXCLUSIONS);
    case "beef": return names(text, BEEF_WORDS, BEEF_EXCLUSIONS);
    case "alcohol": return names(text, ALCOHOL_WORDS, ALCOHOL_EXCLUSIONS);
    case "shellfish": return textNames("shellfish", text);
    case "fish_seafood":
      return textNames("fish", text) || textNames("shellfish", text) || names(text, SEAFOOD_WORDS);
    case "animal_product":
      return namesFacet("meat", text) || namesFacet("fish_seafood", text)
        || textNames("dairy", text) || textNames("egg", text) || names(text, ANIMAL_EXTRA_WORDS);
  }
}

/**
 * A plain red-meat cut is pork or beef only by its own words. These name a species or a cut sold
 * only as beef. A cut also sold as pork ("sirloin", "flank", "brisket", "loin", "strip" alone) is
 * not here alone: it stays `unknown` for the pork rule unless the name says "beef" or is the
 * whole-food class's own "<cut> steak" form (a pork steak is named "pork steak").
 */
const BEEF_SPECIES = new RegExp("\\b(?:beef|veal|ribeye|rib eye|porterhouse|t-bone|flat iron|new york strip|"
  + "(?:sirloin|strip|flank|skirt) steak)\\b");
/** Beef-like words that never clear the beef rule for another species ("lamb sirloin" stays open). */
const BEEF_CUTS = /\b(?:beef|veal|sirloin|ribeye|rib eye|strip|flank|skirt|flat iron|t-bone|porterhouse|brisket)\b/;
/** A red meat that is neither pork nor beef. */
const OTHER_RED_SPECIES = /\b(?:lamb|mutton|goat|venison|bison)\b/;
/**
 * A red meat that clears the beef rule. Bison is a bovine, so a no-beef rule may well cover it:
 * it clears pork but stays `unknown` for beef.
 */
const NOT_BEEF_SPECIES = /\b(?:lamb|mutton|goat|venison)\b/;
const PORK_SPECIES = /\b(?:pork|ham|boar|pig|hog)\b/;

/** Whether the plain whole-food class rules the facet out (the 2026-10-02 banana case). */
function classRulesOut(facet: TextFacet, e: DietEvidence): boolean {
  const name = clearanceNameOf(e);
  const match = classifyWholeFood({ foodName: name, brand: e.foodBrand,
    ingredientsText: e.ingredientsText, packaged: e.packaged });
  if (match === null) return false;
  const lower = (name ?? "").toLowerCase();
  // A plain single-ingredient whole food holds no alcohol; kefir is fermented, so it is left open.
  if (facet === "alcohol") return !/\bkefir\b/.test(lower);
  if (absentAnimalFacets(match).includes(facet)) return true;
  // The meat facet is land-animal flesh: plain fish and shellfish are not meat (pescatarian).
  if (facet === "meat") return match.label === "fish" || match.label === "shellfish";
  if (match.label !== "red meat") return false;
  // A plain cut names its own species: a beef steak is not pork, and a pork chop is not beef.
  if (facet === "pork") {
    return (BEEF_SPECIES.test(lower) || OTHER_RED_SPECIES.test(lower)) && !PORK_SPECIES.test(lower);
  }
  if (facet === "beef") {
    return (PORK_SPECIES.test(lower) || NOT_BEEF_SPECIES.test(lower)) && !BEEF_CUTS.test(lower)
      && !/\bbison\b/.test(lower);
  }
  return false;
}

/**
 * A complete printed label that names no alcohol and nothing that can hide it. Alcohol only: it
 * takes no facet, so an animal facet cannot reach a label clearance by construction (W2c
 * re-plan, Option A). The animal facets clear only by the whole-food class or a reviewed starter
 * outcome; a label-only food stays `unknown` (an ingredient parser is Option B, a separate change).
 */
function alcoholLabelRulesOut(e: DietEvidence): boolean {
  if (e.ingredientsTextIsLabel === false) return false;
  if (!looksLikeCompleteList(e.ingredientsText, { verbatim: true })) return false;
  return !names((e.ingredientsText ?? "").toLowerCase(), ALCOHOL_UNCERTAIN);
}

/**
 * What a plain whole food's class IS: plain poultry and red meat are meat, plain fish and shellfish
 * are seafood, and every animal class is an animal product. Only ever adds `present`.
 */
function classNames(facet: TextFacet, e: DietEvidence): boolean {
  const label = classifyWholeFood({ foodName: clearanceNameOf(e), brand: e.foodBrand,
    ingredientsText: e.ingredientsText, packaged: e.packaged })?.label;
  switch (facet) {
    case "meat": return label === "poultry" || label === "red meat";
    case "fish_seafood": return label === "fish" || label === "shellfish";
    case "shellfish": return label === "shellfish";
    case "animal_product":
      return label !== undefined && ["poultry", "red meat", "fish", "shellfish", "egg", "dairy"]
        .includes(label);
    default: return false;
  }
}

function textFacetOutcome(facet: TextFacet, e: DietEvidence): FacetOutcome {
  const related = RELATED_ALLERGENS[facet];
  if (namesFacet(facet, lowerText(e)) || tagged(e, related) || storedListed(e, related)
    || classNames(facet, e)) {
    return "present";
  }
  if (held(e, related)) return "unknown";
  if (classRulesOut(facet, e)) return "absent";
  return facet === "alcohol" && alcoholLabelRulesOut(e) ? "absent" : "unknown";
}

/** `onion_garlic` and `beans` are policy categories: a stored list decides, a name may add one. */
function categoryFacetOutcome(facet: "onion_garlic" | "beans", e: DietEvidence): FacetOutcome {
  const stored = e.category?.map((key) => key.toLowerCase().trim()) ?? null;
  if (stored?.includes(facet)) return "present";
  return stored === null ? "unknown" : "absent";
}

/**
 * The deterministic outcome for one frozen facet on one food. A facet with no deterministic source
 * here (the occasion fits, `human_food`, `requires_preparation`, `raw_*`, `simple_sugars`) is
 * `unknown`: no rule decision may treat it as clear.
 */
export function dietFacetOutcome(facet: Facet, e: DietEvidence): FacetOutcome {
  const own = ownFacetOutcome(facet, e);
  const attested = e.attestedFacets?.[facet];
  if (own === "present" || attested === "present") return "present";
  if (facetHeld(facet, e)) return "unknown";
  return own === "absent" || attested === "absent" ? "absent" : "unknown";
}

/**
 * Whether a W2a hold (a Jev-only `listed` allergen row) backs this facet. Nothing clears a held
 * facet: not the class, a label, a starter outcome, or a preference flag's certification.
 */
export function facetHeld(facet: string, e: DietEvidence): boolean {
  const allergen = (ALLERGEN_FACETS as Partial<Record<string, string>>)[facet];
  const backing = allergen !== undefined ? [allergen]
    : (RELATED_ALLERGENS as Partial<Record<string, readonly string[]>>)[facet] ?? [];
  return held(e, backing);
}

function ownFacetOutcome(facet: Facet, e: DietEvidence): FacetOutcome {
  const allergen = ALLERGEN_FACETS[facet];
  if (allergen !== undefined) {
    return allergenFinding(allergen, {
      stored: e.allergenEvidence?.[allergen], tags: e.allergenTags, ingredientsText: e.ingredientsText,
      userChecked: (e.checkedAllergens ?? []).some((key) => allergenKey(key) === allergen),
      isLabelText: e.ingredientsTextIsLabel, foodName: e.foodName, brand: e.foodBrand,
      packaged: e.packaged, wholeFoodName: e.wholeFoodName,
    }).outcome;
  }
  switch (facet) {
    case "meat": case "pork": case "beef": case "shellfish": case "fish_seafood":
    case "animal_product": case "alcohol":
      return textFacetOutcome(facet, e);
    case "onion_garlic": case "beans":
      return categoryFacetOutcome(facet, e);
    default:
      return "unknown";
  }
}

/** The facets this module decides from deterministic evidence (every other one is `unknown`). */
export const DIET_DECIDED_FACETS: readonly Facet[] = [
  ...(Object.keys(ALLERGEN_FACETS) as Facet[]),
  "meat", "pork", "beef", "shellfish", "fish_seafood", "animal_product", "alcohol", "onion_garlic",
  "beans",
];
