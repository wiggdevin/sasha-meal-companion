/**
 * Owner decision (2026-10-02): "yes plain whole foods should be cleared" — a plain,
 * single-ingredient whole food is cleared for the allergens its own CLASS cannot contain.
 *
 * Before this, an empty ingredient list read as `no_evidence` for every allergen a food's rule
 * exists for, whatever the food actually was: "Ahi tuna, cooked" (no ingredient text, no tags, no
 * category) was unverified for gluten AND dairy, and so was "Broccoli" and "Chicken breast" — an
 * account avoiding both got zero Eats proteins to suggest. This module is the one place that
 * decides whether a name is a plain whole food and, if so, which allergens it cannot contain;
 * lib/policy/allergens.ts allergenFinding is the only caller, and only for the `no_evidence`
 * fallback — a stored `listed`, a label's `not_listed`, or a user's own label check all still win
 * (§5 precedence is unchanged, this only fills the gap below it).
 *
 * Deliberately narrow and fail-closed: a name outside this table, a branded row, a food with a
 * multi-item ingredient list, or a prepared/compound name (breaded, sauced, canned-with-
 * additives, "chicken and rice") gets no clearance at all — today's "Check the label" mark,
 * unchanged. A false "not a whole food" costs a mark the food would already have had; a false
 * clearance would be a safety claim this file cannot afford to get wrong.
 *
 * Pure. No I/O.
 */

import { policyCategoriesFor } from "@/lib/catalog/category-map";
import { WHOLE_FOOD_CLASSES } from "@/lib/policy/whole-food-classes";

export type WholeFoodMatch = {
  /** The class's own display name, for the card ("Plain fish has no gluten"). */
  label: string;
  /** Allergen keys this class inherently carries — never cleared, whatever else clears. */
  intrinsic: readonly string[];
};

// 2026-10-02 DeepSeek audit round 3 (F4): the app's own catalog data uses doneness words this
// table was missing entirely — "Fish, salmon, Atlantic, farmed, cooked, dry heat" and
// "Egg, hard-boiled" read as prepared/unmatched for want of them, not for any real safety reason.
const COOKING_WORDS =
  "raw|cooked|boiled|steamed|baked|roasted|grilled|poached|dried|fresh|frozen|broiled|braised|" +
  "hard-boiled|pan-fried|dry heat";
/** A comma segment, or the whole name, that is nothing BUT a cooking-state word. */
const BARE_COOKING_STATE = new RegExp(`^(?:${COOKING_WORDS})$`, "i");
/**
 * 2026-10-02 DeepSeek audit round 3 (F4): a lean ratio ("90/10") or percentage ("85% lean") is a
 * plain descriptor for ground meat, the same as the word "lean" already in PLAIN_DESCRIPTORS below
 * — but it rides on the HEAD segment itself ("Ground beef 90/10", not a comma segment of its own),
 * so it has to strip the same way a trailing cooking-state word does, not just be whitelisted.
 */
const LEAN_RATIO = "\\d{1,3}/\\d{1,3}|\\d{1,3}%\\s*lean";
/**
 * A cooking-state word or lean ratio at the very END of a (multi-word) name or segment. 2026-10-02
 * DeepSeek audit via Grok (BLOCK): the old version stripped a cooking-state word from ANYWHERE in
 * the string, so a LEADING word that actually names the dish ("baked" in "Baked beans", a canned
 * dish in tomato sauce, not a doneness) was deleted the same as a genuine trailing one, leaving a
 * bare food word that matched its class. Never strip mid-phrase or leading — only trailing, or a
 * comma segment that is nothing else (BARE_COOKING_STATE above): a false "not a whole food" costs
 * a mark the food already had; stripping a word that changes the food's identity would not.
 */
const TRAILING_STATE_WORD = new RegExp(`[\\s,]+(?:${COOKING_WORDS}|${LEAN_RATIO})$`, "i");

/**
 * Any of these means a prepared or compound food, not one whole ingredient: a breading, a sauce
 * or seasoning, a cured/smoked/canned product, a shaped product sold as a dish, a mix, or a named
 * multi-food dish. Deliberately broad on purpose — see the module doc on which false result costs
 * more.
 */
const PREPARED = new RegExp(
  "\\b(?:bread(?:ed|ing)?|batter(?:ed)?|fried|refried|sauce[sd]?|gravy|glaze[sd]?|" +
  "marinad(?:e|ed)|season(?:ed|ing)?|stuff(?:ed|ing)|smoked|cured|sausages?|patt(?:y|ies)|" +
  "nuggets?|mix(?:es)?|powder|bars?|drinks?|shakes?|flavou?red|imitation|casseroles?|salads?|" +
  "soups?|stews?|pie|jerky|canned|broth|stock|spread|dip|chips?|crisps?|teriyaki|bbq|" +
  "barbecue|buffalo|cajun|blackened|jerk|loaf|meatballs?|dumplings?|pizza|burger|wrap|taco|" +
  // 2026-10-02 DeepSeek audit (HIGH): "Chicken, rotisserie", "Fish, sticks" and "Fast food" /
  // "restaurant" names were not prepared/compound on the OLD table, so the comma-head fallback
  // below (now itself tightened) could still have read them as a plain whole food.
  "burrito|rotisserie|sticks?|prepared|fast food|restaurant|coated|battered|" +
  // 2026-10-02 DeepSeek audit via Grok (BLOCK): named dish forms, not a doneness word — defense
  // in depth alongside the trailing-only cooking-state fix below (normalize/TRAILING_STATE_WORD).
  "baked beans|au gratin|gratin|scalloped|mashed|creamed|candied|hash browns?|home-prepared|" +
  // 2026-10-02 DeepSeek audit round 3 (F5): the catalog's own comma order reverses this ("Beans,
  // baked", "Apples, baked") — a bare trailing "baked" segment would otherwise strip to "" and let
  // the head alone clear, but these name a DISH (baked beans, baked apples), not a doneness.
  "beans?,\\s*baked|apples?,\\s*baked|bananas?,\\s*baked|pears?,\\s*baked|peach(?:es)?,\\s*baked|plums?,\\s*baked)\\b",
  "i",
);

/**
 * "Chicken and rice", "beef with gravy" — a joined dish, not one ingredient. Checked against the
 * whole name on the no-comma path and against the comma name's HEAD segment only — 2026-10-02
 * DeepSeek audit round 3 (F4): checking the full comma string here killed the head-first reading
 * before the segment whitelist ever ran, so a plain two-word descriptor containing "with" ("Potato,
 * baked, with skin") could never reach PLAIN_DESCRIPTORS below. A non-head segment that is NOT a
 * recognized plain descriptor is already rejected by that whitelist on its own, compound or not.
 */
const COMPOUND = /\b(?:with|and)\b|[&+]/i;

/**
 * 2026-10-02 DeepSeek audit (HIGH): the comma-head fallback below (the catalog's "Rice, white,
 * long-grain, cooked" naming) used to accept the head word alone and silently discard every OTHER
 * segment, so a descriptor it had never seen — a preparation word missing from PREPARED, a cut, a
 * grade — passed through just as freely as "white" or "cooked" did. A non-head segment now has to
 * be one of these plain, non-identifying descriptors (a variety, cut, or processing grade that
 * never changes which class the food belongs to) or it blocks the head-first reading entirely.
 */
const PLAIN_DESCRIPTORS = new Set([
  "white", "brown", "long-grain", "medium-grain", "short-grain", "regular", "enriched",
  "unenriched", "parboiled", "jasmine", "basmati", "wild", "fresh", "frozen", "raw",
  "meat only", "breast", "breasts", "thigh", "thighs", "drumstick", "drumsticks", "wing",
  "wings", "leg", "legs", "skinless", "boneless", "broilers or fryers", "lean", "trimmed",
  "separable lean", "separable lean and fat", "select", "choice", "whole", "atlantic",
  "pacific", "farmed", "sockeye", "coho", "chinook", "yellowfin", "albacore", "skipjack",
  "bluefin", "light", "large", "medium", "small", "grade a",
  // 2026-10-02 DeepSeek audit round 3 (F4): two-word forms the catalog uses as a single comma
  // segment ("Salmon, wild sockeye, cooked", "Salmon, Atlantic farmed, cooked"), a cut/processing
  // word ("Chicken, ground, raw"), and preparation descriptors that never change which class a food
  // belongs to ("Broccoli, ..., drained, without salt"; "firm" for tofu only — soy stays intrinsic).
  "wild sockeye", "atlantic farmed", "with skin", "ground", "drained", "without salt", "firm",
  // 2026-10-03 (item B): catalog cut and sourcing words on plain foods. None names a preparation.
  "peeled", "wild caught", "skin eaten", "skin not eaten",
  // 2026-10-03 (recipe coverage): the USDA rows behind the recipe pilot. "without peel" is a cut
  // ("Lemons, raw, without peel"); "red", "ripe" and "year round average" are a variety, a
  // ripeness and a sampling note ("Tomatoes, red, ripe, raw, year round average"); "top sirloin",
  // "steak" and "separable lean only" are a fresh beef cut ("Beef, top sirloin, steak, separable
  // lean only, trimmed to 0" fat, choice, cooked, broiled"). None names a preparation, and each is
  // only read after the head segment already matched a class.
  "without peel", "red", "ripe", "year round average", "top sirloin", "steak",
  "separable lean only",
]);

/** 2026-10-03: a fat-trim grade on a fresh cut ('trimmed to 0" fat', 'trimmed to 1/8" fat'). */
const TRIM_GRADE = /^trimmed to (?:0|1\/8|1\/4)" fat$/;

/** 2026-10-03: plain only for ONE class ("Scallops, sea" is a size; "Cucumbers, sea" an animal). */
const CLASS_DESCRIPTORS: Readonly<Record<string, ReadonlySet<string>>> =
  { shellfish: new Set(["bay", "sea", "patagonian"]), fruit: new Set(["hass"]) };
/** 2026-10-03: only this exact negated phrase goes; the rest of the name is still checked. */
const WITHOUT_SAUCE = /\bwithout sauce\b/g;
/**
 * 2026-10-03: USDA's use note on a single oil ("Oil, olive, salad or cooking") — "salad" here is
 * what the oil is for, not a dish. Only this whole name shape loses the note; any other "salad"
 * still reads as PREPARED.
 */
const OIL_USE_NOTE = /^(oil, (?:olive|avocado)), salad or cooking$/;

/** 2026-10-03: only these variety words leave "(…)"; any other stays and matches no class (Grok). */
const PAREN_QUALIFIERS = /\s*\((cantaloupe|honeydew|hass|bay|sea|patagonian)\)/g;
const parentheticalAsSegment = (name: string) => name.replace(PAREN_QUALIFIERS, ", $1");

/** Empty (nothing left once cooking-state words are stripped) counts as plain too. */
function isPlainDescriptor(segment: string): boolean {
  return segment === "" || PLAIN_DESCRIPTORS.has(segment) || TRIM_GRADE.test(segment);
}

/**
 * Lower-cases, folds commas to spaces, collapses whitespace, and strips a trailing run of
 * cooking-state words or a trailing lean ratio (or returns "" when the whole thing was nothing but
 * one) — never a word in the middle or at the front (see TRAILING_STATE_WORD above).
 */
function normalize(name: string): string {
  const folded = name.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (BARE_COOKING_STATE.test(folded)) return "";
  let result = folded;
  for (let next = result.replace(TRAILING_STATE_WORD, "").trim(); next !== result;
    next = result.replace(TRAILING_STATE_WORD, "").trim()) {
    result = next;
    if (BARE_COOKING_STATE.test(result)) return "";
  }
  return result;
}

/**
 * 2026-10-02 DeepSeek audit via Grok (HIGH, finding B): a multi-item list was already
 * disqualifying, but a single-item line that does NOT repeat the food's own name ("Soy sauce",
 * "Breadcrumbs" against "Chicken breast") was not — the only ingredient text that tolerates
 * clearance is none at all, or one item that is the same food the name already says.
 */
function hasDisqualifyingIngredients(foodNameLower: string, text: string | null | undefined): boolean {
  const items = (text ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (items.length === 0) return false;
  if (items.length > 1) return true;
  return items[0] !== foodNameLower;
}

/**
 * Whether `foodName` is a plain, single-ingredient whole food, and if so, which allergens its
 * class cannot clear. `null` means "no judgment" — the caller's existing fallback applies.
 *
 * `brand` and `ingredientsText` disqualify before the name table is even consulted: a brand means
 * this is a branded catalog row, not a generic commodity identity, and a multi-item ingredient
 * list means this is not one whole ingredient whatever its name reads like.
 */
export function classifyWholeFood(input: {
  foodName?: string | null;
  brand?: string | null;
  ingredientsText?: string | null;
  /**
   * 2026-10-02 DeepSeek audit (HIGH, finding #2): true for a scanned barcode or label — packaged
   * by definition whether or not THIS row happens to carry a brand string. An unbranded store
   * label is still packaged, so `brand` alone cannot be the only disqualifier.
   */
  packaged?: boolean;
}): WholeFoodMatch | null {
  const match = classifyName(input);
  // Grok audit round 5 (HIGH): "frozen" off a dairy food is a formulated dessert, and "dried" off
  // a meat or fish is cured with soy or wheat; neither is the plain food its class names.
  if (match === null) return null;
  const lower = (input.foodName ?? "").toLowerCase();
  if (match.label === "dairy" && /\bfrozen\b/.test(lower)) return null;
  // A cooked fruit is a dish (often with butter or sugar), not the plain fruit (DeepSeek round 7).
  if (match.label === "fruit" && COOKED.test(lower)) return null;
  if (ANIMAL_FLESH.has(match.label) && /\bdried\b/.test(lower)) return null;
  return match;
}

const ANIMAL_FLESH = new Set(["fish", "shellfish", "poultry", "red meat"]);
const COOKED = /\b(?:baked|roasted|cooked|grilled|poached|fried|stewed|broiled|braised|caramelized|candied|saut[eé]ed)\b/;

function classifyName(input: Parameters<typeof classifyWholeFood>[0]): WholeFoodMatch | null {
  if (input.packaged) return null;
  if (input.brand != null && input.brand.trim() !== "") return null;
  const raw = (input.foodName ?? "").trim();
  if (raw === "") return null;
  if (hasDisqualifyingIngredients(raw.toLowerCase(), input.ingredientsText)) return null;
  const lower = parentheticalAsSegment(raw.toLowerCase().replace(WITHOUT_SAUCE, "")
    .replace(OIL_USE_NOTE, "$1"));
  if (PREPARED.test(lower)) return null;
  if (!lower.includes(",")) {
    // No comma segments to whitelist descriptors against, so COMPOUND is checked on the whole name
    // here — unchanged from before (2026-10-02 DeepSeek audit round 3, F4).
    if (COMPOUND.test(lower)) return null;
    return matchClass(normalize(lower));
  }
  // A multi-word class pattern (oats' own optional "gluten-free" suffix) can span what the catalog
  // wrote as two comma segments ("Oats, gluten-free") once commas fold to spaces — tried first,
  // still gated by COMPOUND on the full name exactly as before, so this adds no new reading beyond
  // what already worked pre-2026-10-02.
  if (!COMPOUND.test(lower)) {
    const direct = matchClass(normalize(lower));
    if (direct) return direct;
  }
  // The catalog names commodity foods head-first with comma descriptors ("Rice, white, long-grain,
  // cooked", "Fish, tuna, yellowfin"), but a comma name is only read this way when every OTHER
  // segment is itself harmless — see PLAIN_DESCRIPTORS above (2026-10-02 DeepSeek audit).
  const segments = lower.split(",").map((part) => part.trim()).filter((part) => part !== "");
  const head = normalize(segments[0] ?? "");
  // 2026-10-02 DeepSeek audit round 3 (F4): COMPOUND only guards the HEAD segment now — a compound
  // DISH as the head ("chicken and dumplings, cooked") still blocks, but a plain descriptor segment
  // that happens to contain "with"/"and" ("with skin", "separable lean and fat", already in
  // PLAIN_DESCRIPTORS but dead code until now) is judged by that whitelist below instead, the same
  // as any other rest segment — already a closed set that rejects an unrecognized segment whether
  // or not it is "compound". The full-name COMPOUND check above still gates the DIRECT attempt,
  // unchanged from before.
  if (COMPOUND.test(head)) return null;
  const rest = segments.slice(1).map(normalize);
  for (const wholeFoodClass of WHOLE_FOOD_CLASSES) {
    if (!wholeFoodClass.pattern.test(head)) continue;
    const accepted = rest.every((segment) =>
      isPlainDescriptor(segment) || wholeFoodClass.pattern.test(segment)
      || (CLASS_DESCRIPTORS[wholeFoodClass.label]?.has(segment) ?? false));
    // Every food-naming segment's intrinsic allergens ("Apples, coconut" keeps tree-nut; Grok).
    const named = [head, ...rest.filter((segment) => wholeFoodClass.pattern.test(segment))];
    if (accepted) return { label: wholeFoodClass.label,
      intrinsic: [...new Set(named.flatMap((segment) => wholeFoodClass.intrinsic(segment)))] };
  }
  return null;
}

function matchClass(name: string): WholeFoodMatch | null {
  for (const wholeFoodClass of WHOLE_FOOD_CLASSES) {
    if (wholeFoodClass.pattern.test(name)) {
      return { label: wholeFoodClass.label, intrinsic: wholeFoodClass.intrinsic(name) };
    }
  }
  return null;
}

/**
 * 2026-10-03: whether free text (a recipe's own ingredient wording, "cooked salmon") names a
 * prepared or compound food, by the same PREPARED and COMPOUND tests this module applies to a
 * catalog name. A caller that clears by a catalog row's own description uses this to make sure
 * the wording around it adds no sauce, breading, seasoning or second food.
 */
export function namesPreparedOrCompound(name: string): boolean {
  const lower = name.toLowerCase();
  return PREPARED.test(lower) || COMPOUND.test(lower);
}

/**
 * 2026-10-03: the name clearance reads. A caller whose `foodName` is not one food's own name (a
 * recipe line joins its wording with the catalog row) passes that row's description as
 * `wholeFoodName`, or null when the wording rules clearance out; escalation still reads
 * `foodName`. Undefined keeps reading `foodName`.
 */
export function clearanceNameOf(input: { foodName?: string | null; wholeFoodName?: string | null }):
  string | null | undefined {
  return input.wholeFoodName !== undefined ? input.wholeFoodName : input.foodName;
}

const PLANT_CLASSES = new Set(["water", "plant oil", "grain", "oats", "potato", "corn", "legume", "soy", "tree nuts", "peanuts",
  "sesame", "seeds", "vegetables", "fruit"]);

/**
 * The animal facets a plain whole food's class cannot carry (live smoke 2026-10-02: a banana read
 * "Not verified … your no-pork preference"). Only facets the class rules out by what it IS: plant
 * foods carry no animal product at all; eggs and dairy carry no meat or seafood; poultry and fish
 * carry no pork or beef. Red meat is left open here (pork or beef is the open question);
 * lib/policy/diet-evidence.ts settles it only from the cut's own species word (Phase 18 W2c).
 */
export function absentAnimalFacets(match: WholeFoodMatch): readonly string[] {
  if (PLANT_CLASSES.has(match.label)) {
    return ["meat", "fish_seafood", "shellfish", "animal_product", "pork", "beef"];
  }
  if (match.label === "egg" || match.label === "dairy") {
    return ["meat", "fish_seafood", "shellfish", "pork", "beef"];
  }
  if (match.label === "poultry") return ["fish_seafood", "shellfish", "pork", "beef"];
  if (match.label === "fish") return ["shellfish", "pork", "beef"];
  if (match.label === "shellfish") return ["pork", "beef"];
  return [];
}

/**
 * A food with no stored policy category, categorised by its own name with the catalog's own rules
 * (lib/catalog/category-map.ts). Live check 2026-10-02: a user's own "Black beans" carries no
 * category, so it passed an account that bans beans once its allergens were cleared by name.
 */
export function nameCategories(foodName: string | null | undefined): string[] | null {
  const name = (foodName ?? "").trim();
  return name === "" ? null : policyCategoriesFor({ description: name, category: null });
}
