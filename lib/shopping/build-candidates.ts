/**
 * The Ingredients deck of "Have AI build my list" (UI makeover §7.3): which foods the deck offers.
 *
 * Pure. The caller (components/shopping/BuildListCard.tsx) reads the account's own sources and
 * hands them in: its Favored foods, its starred foods, its admitted "Eaten often" rows, and the
 * ingredients of its saved recipes and saved meals. Here they are merged by normalized name (the
 * base name every Eats/Avoid mark uses, lib/foods/base-name.ts), then:
 *
 * - a name on Avoid is never offered (and is not counted: it is the person's own choice);
 * - a name already in the pantry or already on the list is not offered;
 * - a `blocked` rule mark drops the food and counts it, so the deck can say "N left out by your
 *   food rules"; an `unknown` mark keeps the food and shows its mark;
 * - at most `cap` (30) cards, in the usual order: Favored, starred, eaten often, saved meals, saved
 *   recipes, each in the order its source gave.
 */
import { baseFoodName } from "@/lib/foods/base-name";
import type { RuleMark } from "@/lib/types";

export type CandidateSource = "favored" | "starred" | "eaten" | "meal" | "recipe";

export type CandidateInput = {
  name: string;
  source: CandidateSource;
  /** The food under the account's current rules: null clear, else blocked or unknown. */
  ruleMark?: RuleMark | null;
};

export type BuildCandidate = {
  /** Stable within one deck: "c1", "c2" … (no name in it, so the rank route sees ids only). */
  id: string;
  name: string;
  /** The normalized name the merge used. */
  key: string;
  sources: CandidateSource[];
  ruleMark: RuleMark | null;
};

export type BuildCandidates = {
  candidates: BuildCandidate[];
  /** Foods a `blocked` rule mark kept out of the deck. */
  leftOutByRules: number;
  /** Offerable foods before the cap. */
  total: number;
};

export const DECK_CAP = 30;

const SOURCE_ORDER: CandidateSource[] = ["favored", "starred", "eaten", "meal", "recipe"];

export const SOURCE_LABEL: Record<CandidateSource, string> = {
  favored: "Favorite", starred: "Starred", eaten: "Eaten often", meal: "From a saved meal",
  recipe: "From a saved recipe",
};

/** The one tag a card shows: its first source in the usual order. */
export function sourceLabel(candidate: Pick<BuildCandidate, "sources">): string {
  const first = SOURCE_ORDER.find((source) => candidate.sources.includes(source));
  return first ? SOURCE_LABEL[first] : "";
}

export function candidateKey(name: string): string {
  return baseFoodName(name);
}

function worse(a: RuleMark | null, b: RuleMark | null): RuleMark | null {
  if (a?.verdict === "blocked") return a;
  if (b?.verdict === "blocked") return b;
  return a ?? b;
}

export function buildCandidates(input: {
  sources: readonly CandidateInput[];
  avoid: readonly string[];
  pantry: readonly string[];
  listed: readonly string[];
  cap?: number;
}): BuildCandidates {
  const cap = input.cap ?? DECK_CAP;
  const keys = (names: readonly string[]) => new Set(names.map(candidateKey).filter(Boolean));
  const avoid = keys(input.avoid);
  const have = keys([...input.pantry, ...input.listed]);

  const rank = (source: CandidateSource) => SOURCE_ORDER.indexOf(source);
  const ordered = input.sources
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.source) - rank(b.row.source) || a.index - b.index)
    .map(({ row }) => row);

  const merged = new Map<string, { name: string; sources: CandidateSource[]; ruleMark: RuleMark | null }>();
  for (const row of ordered) {
    const name = row.name.trim().replace(/\s+/g, " ");
    const key = candidateKey(name);
    if (!key) continue;
    const mark = row.ruleMark ?? null;
    const prior = merged.get(key);
    if (prior) {
      if (!prior.sources.includes(row.source)) prior.sources.push(row.source);
      prior.ruleMark = worse(prior.ruleMark, mark);
    } else merged.set(key, { name, sources: [row.source], ruleMark: mark });
  }

  let leftOutByRules = 0;
  const offerable: Omit<BuildCandidate, "id">[] = [];
  for (const [key, row] of merged) {
    if (avoid.has(key) || have.has(key)) continue;
    if (row.ruleMark?.verdict === "blocked") { leftOutByRules += 1; continue; }
    offerable.push({ key, name: row.name, sources: row.sources, ruleMark: row.ruleMark });
  }
  return {
    candidates: offerable.slice(0, cap).map((row, index) => ({ id: `c${index + 1}`, ...row })),
    leftOutByRules,
    total: offerable.length,
  };
}
