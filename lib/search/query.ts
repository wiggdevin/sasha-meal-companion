/**
 * Query parsing for catalog search (Phase 1 spec, Engines and logic).
 *
 * A token promoted to a structured field leaves `raw`: the brand and the prep
 * state are scored as their own features (architecture §4.1), so leaving them
 * in the free text would also make `websearch_to_tsquery` AND on them and hide
 * rows that do not spell them out. `raw` keeps the caller's capitalisation —
 * `classifyQuery` reads it and the SQL lowercases.
 */

import { CATEGORY_LABELS, type RuleLabel } from "@/lib/reference";

export const PREP_STATES = [
  "raw", "cooked", "roasted", "grilled", "fried", "boiled", "baked", "unknown",
] as const;

export type PrepState = (typeof PREP_STATES)[number];

/** The seven a query can carry. 'unknown' is a wire value, never a parse result. */
export const PREP_WORDS: readonly PrepState[] = [
  "raw", "cooked", "roasted", "grilled", "fried", "boiled", "baked",
];

export type ParsedQuery = { raw: string; brand: string | null; prep: PrepState | null };

const BRAND_FIELD = /\bbrand:\s*(?:"([^"]+)"|(\S+))\s*$/i;
const QUOTED = /"([^"]+)"/;
const CAPITALISED = /^[A-ZÀ-Þ][\w'&.À-ɏ-]*$/;

export function normalizeBrand(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function liftBrand(text: string): { rest: string; brand: string | null } {
  const field = text.match(BRAND_FIELD);
  if (field) {
    const brand = (field[1] ?? field[2] ?? "").trim();
    return { rest: text.slice(0, field.index ?? 0).trim(), brand: brand.length > 0 ? brand : null };
  }
  const quoted = text.match(QUOTED);
  if (quoted) {
    const at = quoted.index ?? 0;
    const rest = `${text.slice(0, at)} ${text.slice(at + quoted[0].length)}`.replace(/\s+/g, " ").trim();
    const brand = quoted[1].trim();
    return { rest, brand: brand.length > 0 ? brand : null };
  }
  return { rest: text, brand: null };
}

function liftPrep(text: string): { rest: string; prep: PrepState | null } {
  const words = text.split(" ").filter(Boolean);
  const bare = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "");
  const at = words.findIndex((w) => (PREP_WORDS as readonly string[]).includes(bare(w)));
  if (at < 0) return { rest: text, prep: null };
  const prep = bare(words[at]) as PrepState;
  words.splice(at, 1);
  return { rest: words.join(" ").trim(), prep };
}

export function parseQuery(input: string): ParsedQuery {
  const original = (input ?? "").replace(/\s+/g, " ").trim();
  const { rest: afterBrand, brand } = liftBrand(original);
  const { rest, prep } = liftPrep(afterBrand);
  return { raw: rest.length > 0 ? rest : original, brand, prep };
}

/**
 * The TypeScript mirror of SQL `catalog_expand_query` (migration 20260921090000).
 *
 * The API route never calls this: `app/api/foods/search/route.ts` passes the raw query and the
 * SQL helper does the expansion inside `catalog_search`, so there is no `loadSynonyms` on the
 * client and the browser bundle never carries the table. This mirror exists for the feature
 * parity tests — `tests/search/recall.test.ts` asserts SQL and TypeScript agree on the same
 * strings, and `tests/search/score-parity.test.ts` keeps reading the SQL's own seven feature
 * columns, which are computed from the UNEXPANDED query and are therefore unaffected.
 *
 * Matching is two-word-first, then single-token, and each token is consumed once: an expansion is
 * never re-expanded, so the table cannot cycle.
 */
export function expandQuery(q: string, synonyms: Map<string, string>): string {
  const tokens = (q ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const pair = i + 1 < tokens.length ? synonyms.get(`${tokens[i]} ${tokens[i + 1]}`) : undefined;
    if (pair !== undefined) {
      out.push(pair);
      i += 2;
      continue;
    }
    out.push(synonyms.get(tokens[i]) ?? tokens[i]);
    i += 1;
  }
  return out.join(" ");
}

/**
 * Branded when the query names a brand, or carries a run of two or more
 * capitalised tokens inside an otherwise lowercase query. A wholly title-cased
 * query is the phone keyboard, not a brand, so it stays generic.
 */
export function classifyQuery(q: ParsedQuery): "branded" | "generic" {
  if (q.brand !== null) return "branded";
  const tokens = q.raw.split(" ").filter(Boolean);
  if (tokens.length < 2) return "generic";
  const caps = tokens.map((t) => CAPITALISED.test(t));
  if (caps.every(Boolean)) return "generic";
  let run = 0;
  let best = 0;
  for (const c of caps) {
    run = c ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best >= 2 ? "branded" : "generic";
}

/** A category request expands to at most this many searches, the raw phrase included. */
export const FOOD_DISCOVERY_MAX_TERMS = 6;

function discoveryText(value: string): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\s+/g, " ").trim();
}

const PREP_PREFIX = /^(?:raw|uncooked)\s+/;

/**
 * The only aliases discovery adds: each existing policy category (lib/reference.ts, keyed by
 * lib/catalog/category-map.ts), the phrases that name it, and the foods its help line lists.
 * The catalog synonym table is NOT here — it lives in SQL (`catalog_expand_query`), so a typo or
 * a kitchen word reaches it as the raw phrase and the browser never carries the table.
 */
const CATEGORY_ALIASES = (Object.entries(CATEGORY_LABELS) as [string, RuleLabel][])
  .map(([key, rule]) => {
    const names = [key.replace(/_/g, " "), discoveryText(rule.label)];
    return {
      names: new Set([...names, ...names.map((name) => name.replace(PREP_PREFIX, ""))]),
      foods: discoveryText(rule.help).replace(/\.$/, "").split(/,\s*|\s+and\s+/)
        .map((item) => item.replace(PREP_PREFIX, "").trim()).filter(Boolean),
    };
  });

/**
 * The searches one food request becomes: its normalized phrase first, then — only when the phrase
 * names an existing policy category — the foods that category covers. Deduplicated and bounded.
 * Every term is still a plain server search, so the server's policy verdict marks every row.
 */
export function foodDiscoveryTerms(value: string): readonly string[] {
  const phrase = discoveryText(value);
  if (!phrase) return [];
  const aliases = CATEGORY_ALIASES.filter((category) => category.names.has(phrase))
    .flatMap((category) => category.foods);
  return [...new Set([phrase, ...aliases])].slice(0, FOOD_DISCOVERY_MAX_TERMS);
}
