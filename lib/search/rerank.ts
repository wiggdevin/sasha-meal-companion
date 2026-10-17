/**
 * OD08 (owner decisions 2026-10-12): two ranking steps on top of `catalog_search`, run in
 * TypeScript after the RPC so the SQL score expression, its seven feature columns and
 * `tests/search/score-parity.test.ts` stay exactly as they are (no migration).
 *
 * 1. Typo fold. A query word that no candidate description spells is mapped to the nearest
 *    description word when their trigram similarity is at least 0.6 (contracts §7), and the
 *    search runs once more with the folded words. The vocabulary is the first run's own
 *    candidates, which the SQL `word_similarity > 0.45` recall branch already reaches for a typo.
 * 2. Dish-marker penalty. On a one- or two-word query, a row whose description carries a
 *    prepared-dish word the query did not ask for ("Pie, sweet potato" for "sweet potato") loses
 *    a fixed amount of score, so the plain ingredient row wins. A query that names the dish keeps
 *    it ("carrot cake"), and a row whose words are exactly the query's is never penalised.
 *
 * Both are off until `CATALOG_SEARCH_RERANK=1` (ruling R1: a ranking change ships only after
 * `scripts/search-eval.ts --rerank --dry-run` keeps top-1 ≥ 82 % and top-3 ≥ 95 % on the real
 * catalog). Pure: the caller passes the RPC in.
 */

export const TYPO_FOLD_SIMILARITY = 0.6;
export const DISH_MARKER_PENALTY = 0.1;
/** The penalty applies to queries of at most this many words. */
export const DISH_MARKER_MAX_TOKENS = 2;
/** Shorter query words are left alone: a three-letter trigram set is too small to judge. */
const FOLD_MIN_LENGTH = 4;

/**
 * Words that turn an ingredient into a prepared dish or a different product in USDA
 * descriptions (FNDDS leads with them: "Pie, sweet potato", "Muffin, carrot", "Salmon salad").
 * Singular forms; a plural is folded before the lookup ("fries" → "fry"). Form words that are
 * not dishes ("patty", "chili" as in hot chili peppers, "baby" carrots) are deliberately absent.
 */
export const DISH_MARKERS: ReadonlySet<string> = new Set([
  "babyfood", "bagel", "bar", "battered", "biscuit", "bread", "breaded", "brownie", "bun",
  "burger", "burrito", "cake", "candy", "casserole", "cheeseburger", "chip",
  "chowder", "cobbler", "cookie", "crepe", "croissant", "cupcake", "curry", "custard", "danish",
  "dip", "donut", "doughnut", "dressing", "dumpling", "enchilada", "fritter", "fry",
  "frittata", "gravy", "hamburger", "jam", "jelly", "juice", "lasagna", "milkshake", "muffin",
  "nacho", "nugget", "omelet", "omelette", "pancake", "pastry", "pie", "pizza",
  "pudding", "quesadilla", "quiche", "roll", "salad", "sandwich", "sauce", "shake", "smoothie",
  "souffle", "soup", "spread", "stew", "sushi", "taco", "turnover", "waffle",
]);

export function searchWords(text: string): string[] {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** The word and its possible singulars: "cookies" → cookies, cooky, cookie; "fries" → fry. */
function forms(word: string): string[] {
  const out = [word];
  if (word.length > 4 && word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  if (word.length > 4 && word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) out.push(word.slice(0, -1));
  return out;
}

function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/** pg_trgm `similarity` for two single lowercase a-z0-9 words (the output of `searchWords`). */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The query with each unknown word folded to its nearest candidate word, or null when nothing
 * folds. A word is unknown when no description carries it. A plural of a candidate word (or the
 * other way round) is left for the full-text stemmer, which already matches it; a number never
 * folds.
 */
export function foldTypos(raw: string, descriptions: readonly string[]): string | null {
  const vocabulary = new Set<string>();
  for (const d of descriptions) {
    for (const w of searchWords(d)) if (w.length >= 3 && !/\d/.test(w)) vocabulary.add(w);
  }
  const words = searchWords(raw);
  const folded = words.map((word) => {
    if (word.length < FOLD_MIN_LENGTH || /\d/.test(word) || vocabulary.has(word)) return word;
    let best: { word: string; sim: number } | null = null;
    for (const candidate of vocabulary) {
      if (forms(word).includes(candidate) || forms(candidate).includes(word)) continue;
      const sim = trigramSimilarity(word, candidate);
      if (sim < TYPO_FOLD_SIMILARITY) continue;
      if (!best || sim > best.sim || (sim === best.sim && candidate < best.word)) {
        best = { word: candidate, sim };
      }
    }
    return best ? best.word : word;
  });
  const replacements = new Map<string, string>();
  words.forEach((word, i) => {
    if (folded[i] !== word) replacements.set(word, folded[i]);
  });
  if (replacements.size === 0) return null;
  // Only the folded words change; the caller's punctuation, quotes and accents stay as typed.
  return raw.replace(/[\p{L}\p{M}\p{N}]+/gu, (m) => {
    const w = searchWords(m);
    return w.length === 1 ? replacements.get(w[0]) ?? m : m;
  });
}

/**
 * True when the description's head (its first comma segment, where FNDDS and SR Legacy name the
 * food: "Pie, sweet potato", "Salmon salad", "Cookies, oatmeal") carries a dish word the query
 * does not ask for. A marker later in the description is a form, not the food ("Oil, olive, salad
 * or cooking", "Beef, chuck for stew", "Tortillas, ready-to-bake or -fry, corn").
 */
export function isUnaskedDish(raw: string, description: string): boolean {
  const asked = new Set(searchWords(raw).flatMap(forms));
  const head = (description ?? "").split(",")[0];
  return searchWords(head).some((w) => {
    const marker = forms(w).some((f) => DISH_MARKERS.has(f));
    return marker && !forms(w).some((f) => asked.has(f));
  });
}

type Scored = { description: string; score: number | string };

/**
 * Applies the dish-marker penalty and reorders by the adjusted score (stable on ties, so the
 * RPC's own `revision_id` tie-break holds). Each row keeps its SQL `score`, so auto-resolve never
 * sees a margin the penalty made: a demoted row left above the new first row only makes
 * `shouldAutoResolve` stricter. A query longer than two words returns the rows unchanged.
 */
export function penalizeDishes<T extends Scored>(raw: string, rows: readonly T[]): T[] {
  const tokens = searchWords(raw);
  if (tokens.length === 0 || tokens.length > DISH_MARKER_MAX_TOKENS) return [...rows];
  return rows
    .map((row, index) => {
      const score = Number(row.score);
      const adjusted = isUnaskedDish(raw, row.description) ? score - DISH_MARKER_PENALTY : score;
      return { row, adjusted, index };
    })
    .sort((a, b) => b.adjusted - a.adjusted || a.index - b.index)
    .map((x) => x.row);
}

export function searchRerankEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CATALOG_SEARCH_RERANK === "1";
}

/**
 * One search with both OD08 steps. `run` calls `catalog_search` with the given free text (the
 * caller keeps brand, prep and limit). Off, it is exactly one `run(raw)`. On, a folded query
 * costs one more round trip, and its results replace the first run's only when it returns any.
 */
export async function rerankedSearch<T extends Scored>(
  raw: string,
  run: (q: string) => Promise<T[]>,
  enabled: boolean,
): Promise<{ rows: T[]; query: string }> {
  const first = await run(raw);
  if (!enabled) return { rows: first, query: raw };
  const folded = foldTypos(raw, first.map((r) => r.description));
  let query = raw;
  let rows = first;
  if (folded !== null) {
    const second = await run(folded);
    if (second.length > 0) {
      query = folded;
      rows = second;
    }
  }
  return { rows: penalizeDishes(query, rows), query };
}
