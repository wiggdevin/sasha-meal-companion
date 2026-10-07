/**
 * The FNDDS-to-universe crosswalk (Phase 18 D10, W1b). Offline build only.
 *
 * A recalled FNDDS food code is expanded through its documented ingredients (`input_food.csv`),
 * recursively when an ingredient is itself a survey food, into SR ingredient shares by gram weight.
 * Each SR ingredient maps to one universe food key, or to none:
 *   1. exact: the ingredient's SR number is a universe item's own SR row;
 *   2. family: the ingredient's description, with preparation words removed and words made
 *      singular, shares the longest leading run of comma-separated parts with a universe item's
 *      (see `createMatcher` for the full rule).
 * A documented recipe is an estimate of what a dish contained, never the respondent's recipe; the
 * shares ignore cooking yield. A share credited to several tied keys counts once toward coverage. Water, salt, sugar, oils outside the universe and the rest stay
 * unmapped and are reported (mapping coverage = share of recalled grams mapped).
 */

export type UniverseRef = { key: string; ndb: string | null; sr: string; order: number };
export type Ingredient = { code: string; description: string; grams: number };
export type FnddsRelease = { label: string; ingredients: Map<string, Ingredient[]> };
export type Match = { keys: string[]; how: "exact" | "family" | "loose"; depth: number; jaccard: number };
/** Universe-key shares of a food code's grams; `unmapped` (of which `drink`) is the rest. */
export type Expansion = { shares: Map<string, number>; unmapped: number; drink: number };

/** Comma parts that say how a food was prepared, packed or graded, not what it is. */
const PREP = /^(raw|cooked|uncooked|boiled|roasted|broiled|baked|braised|grilled|fried|pan-fried|pan-browned|steamed|stewed|simmered|microwaved|poached|scrambled|hard-boiled|soft-boiled|drained|drained solids|solids and liquids|without salt|with salt|without added salt|with added salt|unprepared|prepared|frozen|canned|fresh|dry heat|moist heat|ready-to-eat|ready-to-serve|commercial|commercially prepared|regular pack|enriched|unenriched|not fortified|fortified|all grades|choice|select|patty|crumbles|boneless|skinless|year round average|grade a|large|medium|small|extra large|jumbo|nfs)\b/;

/** First parts that name a category, not a food: they never match on one part alone. */
const GENERIC = new Set(["beverage", "snack", "nut", "seed", "fish", "crustacean", "mollusk", "spice", "oil",
  "cereal", "alcoholic beverage", "fast food", "restaurant", "soup", "sauce", "candy", "baby food", "infant formula",
  "vegetable", "fruit", "game meat", "bread", "cheese", "milk"]);

/** Processing an item must share before a description that names it can map to the item. */
const PROCESSED = /\b(cured|smoked|breaded|battered|sweetened|candied|pickled|syrup|juice|dehydrated|powder|flavou?red)\b/;

function processing(text: string): string[] {
  return (text.toLowerCase().match(new RegExp(PROCESSED.source, "g")) ?? []).sort();
}

/** A one-part match needs this much word overlap with the item's whole description. */
export const LOOSE_JACCARD = 0.35;

const WORD = /[a-z0-9%]+/g;

function singular(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

export function familyParts(description: string): string[] {
  return description.toLowerCase().split(/,\s*/)
    .map((part) => part.replace(/\(.*?\)/g, "").trim().split(/\s+/).map(singular).join(" "))
    .filter((part) => part && !PREP.test(part));
}

function words(description: string): Set<string> {
  return new Set((description.toLowerCase().match(WORD) ?? []).map(singular));
}

function sharedLead(a: readonly string[], b: readonly string[]): number {
  let depth = 0;
  while (depth < a.length && depth < b.length && a[depth] === b[depth]) depth += 1;
  return depth;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let both = 0;
  for (const word of a) if (b.has(word)) both += 1;
  return both / (a.size + b.size - both || 1);
}

/**
 * Exact SR number first; else the longest shared lead of family parts (two or more, or every part
 * of the item); else one shared non-generic first part with word overlap of at least
 * LOOSE_JACCARD. A full family match credits every item of the same family (the same parts once
 * preparation words are gone: raw egg counts for each egg preparation). A description naming a processing (cured, smoked, sweetened, juice ...) the item
 * lacks never maps to it. Among equals the highest word overlap wins; a tie credits every tied item (eggs
 * count for each egg preparation), and is listed in the audit.
 */
export function createMatcher(universe: readonly UniverseRef[]) {
  const byNdb = new Map<string, UniverseRef[]>();
  for (const ref of universe) if (ref.ndb) byNdb.set(ref.ndb, [...(byNdb.get(ref.ndb) ?? []), ref]);
  const prepared = universe.map((ref) => ({ ref, parts: familyParts(ref.sr), words: words(ref.sr) }));
  const cache = new Map<string, Match | null>();
  return function match(ingredient: Pick<Ingredient, "code" | "description">): Match | null {
    const cacheKey = `${ingredient.code}|${ingredient.description}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const exact = byNdb.get(ingredient.code);
    let result: Match | null = exact
      ? { keys: exact.map((ref) => ref.key), how: "exact", depth: Infinity, jaccard: 1 } : null;
    if (!result) {
      const parts = familyParts(ingredient.description);
      const own = words(ingredient.description);
      const processed = processing(ingredient.description);
      let best: { depth: number; score: number; refs: UniverseRef[] } | null = null;
      for (const item of prepared) {
        const depth = sharedLead(parts, item.parts);
        if (depth === 0 || processed.some((word) => !processing(item.ref.sr).includes(word))) continue;
        const score = jaccard(own, item.words);
        const full = depth >= Math.min(2, item.parts.length);
        if (!full && (GENERIC.has(parts[0]) || score < LOOSE_JACCARD)) continue;
        if (!best || depth > best.depth || (depth === best.depth && score > best.score + 1e-12)) {
          best = { depth, score, refs: [item.ref] };
        } else if (depth === best.depth && Math.abs(score - best.score) <= 1e-12) best.refs.push(item.ref);
      }
      if (best) {
        const parts0 = familyParts(best.refs[0].sr);
        const full = best.depth >= Math.min(2, parts0.length);
        const same = prepared.filter((item) => item.parts.join("|") === parts0.join("|")).map((item) => item.ref);
        const refs = full ? [...new Set([...best.refs, ...same])] : best.refs;
        result = { keys: [...refs].sort((a, b) => a.order - b.order).map((ref) => ref.key),
          how: full ? "family" : "loose", depth: best.depth, jaccard: best.score };
      }
    }
    cache.set(cacheKey, result);
    return result;
  };
}

export type Leaf = { ingredient: Ingredient; share: number };

/** Unmapped grams of a drink (water, coffee, juice, alcohol): out of the universe by design (D1). */
export const DRINK = /^(beverages?|water|alcoholic|coffee|tea|soft drink)\b|\bjuice\b/i;

/**
 * Expands a survey food code into its leaf ingredients with their shares of its gram weight
 * (summing to 1), through sub-recipes looked up in the releases in order. A cycle, or a code with no
 * documented ingredients, is one unmapped leaf of its own.
 */
export function createExpander(releases: readonly FnddsRelease[], match: ReturnType<typeof createMatcher>) {
  const leafCache = new Map<string, Leaf[]>();
  const shareCache = new Map<string, Expansion>();
  function ingredientsOf(code: string): Ingredient[] | null {
    for (const release of releases) {
      const list = release.ingredients.get(code);
      if (list?.length) return list;
    }
    return null;
  }
  function leaves(code: string, seen: ReadonlySet<string>): Leaf[] {
    const hit = leafCache.get(code);
    if (hit) return hit;
    const list = ingredientsOf(code);
    const total = list?.reduce((sum, item) => sum + Math.max(0, item.grams), 0) ?? 0;
    if (!list || total <= 0 || seen.has(code)) return [{ ingredient: { code, description: `(no ingredients: ${code})`, grams: 0 }, share: 1 }];
    const nextSeen = new Set(seen).add(code);
    const out: Leaf[] = [];
    for (const item of list) {
      const share = Math.max(0, item.grams) / total;
      if (share === 0) continue;
      if (item.code.length === 8 && ingredientsOf(item.code)) {
        for (const leaf of leaves(item.code, nextSeen)) out.push({ ingredient: leaf.ingredient, share: share * leaf.share });
      } else out.push({ ingredient: item, share });
    }
    if (!seen.size) leafCache.set(code, out);
    return out;
  }
  function expand(code: string): Expansion {
    const hit = shareCache.get(code);
    if (hit) return hit;
    const result: Expansion = { shares: new Map(), unmapped: 0, drink: 0 };
    for (const leaf of leaves(code, new Set())) {
      const matched = match(leaf.ingredient);
      if (!matched) {
        result.unmapped += leaf.share;
        if (DRINK.test(leaf.ingredient.description)) result.drink += leaf.share;
        continue;
      }
      for (const key of matched.keys) result.shares.set(key, (result.shares.get(key) ?? 0) + leaf.share);
    }
    shareCache.set(code, result);
    return result;
  }
  return { expand, leaves: (code: string) => leaves(code, new Set()) };
}
