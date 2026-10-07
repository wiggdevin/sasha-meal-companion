import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeInputHash } from "@/lib/foods/facet-keys";
import {
  FACETS, facetRubricVersion, OCCASION_RUBRIC_VERSION, RUBRIC_VERSION, rubricVersionsFor, type Facet,
} from "@/lib/foods/facet-vocabulary";
import { adminClient } from "@/lib/server/admin";
import { MAX_PAGES, PAGE_SIZE } from "@/lib/server/paged-read";

export { FACETS, facetRubricVersion, OCCASION_RUBRIC_VERSION, RUBRIC_VERSION, rubricVersionsFor };
export type { Facet };
export type FacetCacheKey = { foodKey: string; inputHash: string };
export type FacetJudgment = { p: number; rubricVersion: number; judgedAt: string };
export type FoodFacetJudgments = Partial<Record<Facet, FacetJudgment>>;
/**
 * `errors` counts failed chunks and malformed rows. `failed(key)` is true for a key whose read
 * failed (t18 r2): such a key has NO judgments in the map, so a caller that writes or clears
 * anything from facets must skip it rather than read the gap as "not present".
 */
export type FacetReadResult = Map<string, FoodFacetJudgments> & {
  readonly errors: number;
  failed(key: FacetCacheKey): boolean;
};

type FacetRow = {
  food_key: unknown;
  input_hash: unknown;
  facet: unknown;
  rubric_version: unknown;
  p: unknown;
  judged_at: unknown;
};

type ParsedRow =
  | { kind: "match"; cacheKey: string; facet: Facet; judgment: FacetJudgment }
  | { kind: "skip" }
  /** `cacheKey` when the row names a key it was wanted for; absent when it names none. */
  | { kind: "error"; cacheKey?: string };

const FACET_SET = new Set<string>(FACETS);

/**
 * Reads only cached judgments, each facet at its own rubric revision (`facetRubricVersion`): a v1
 * occasion row is never returned as a v2 judgment. Missing or stale rows remain unknown; database and malformed-row
 * failures increment `result.errors` and never escape to an interactive caller.
 */
export async function readFacets(
  keys: readonly FacetCacheKey[],
  facets: readonly Facet[] = FACETS,
  client?: SupabaseClient,
): Promise<FacetReadResult> {
  const result = new Map<string, FoodFacetJudgments>();
  const failedKeys = new Set<string>();
  if (keys.length === 0 || facets.length === 0) return withErrors(result, 0, failedKeys);

  const requested = [...new Map(keys.map((key) => [facetCacheKey(key), {
    foodKey: key.foodKey,
    inputHash: postgresHash(key.inputHash),
  }])).values()];
  const wanted = new Set(requested.map(facetCacheKey));
  const wantedFacets = [...new Set(facets)];
  let errors = 0;

  // The pair filter travels in the GET URL. One `.or()` over every key grew past what the
  // PostgREST hop accepts at ~100–110 foods: the request died as a bare `fetch failed` after
  // ~8.7 s, which alone spent the coach's whole 8 s suggestion budget, and came back as an empty
  // map. Chunks bounded by encoded filter size keep every request small and the read linear.
  let db: SupabaseClient;
  try {
    db = client ?? adminClient();
  } catch (cause) {
    reportReadFailure(requested.length, cause);
    for (const key of requested) failedKeys.add(facetCacheKey(key));
    return withErrors(result, 1, failedKeys);
  }
  const chunks = chunkPairFilters(requested.map(pairFilter));
  let offset = 0;
  const chunkKeys = chunks.map((filters) => {
    const ofChunk = requested.slice(offset, offset + filters.length).map(facetCacheKey);
    offset += filters.length;
    return ofChunk;
  });
  const responses = await Promise.all(chunks.map(async (filters) => {
    const rows: FacetRow[] = [];
    try {
      // t18: a chunk holds up to ~27 foods × every wanted facet, close to the API row cap. Paged
      // by primary key (each facet is read at its own rubric revision, so rubric_version is part
      // of the order). A failed page fails the whole chunk: its rows are dropped below and its keys
      // reported by `failed()` (t18 r2, never a partial judgment set).
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const from = page * PAGE_SIZE;
        const { data, error } = await db
          .from("food_facets")
          .select("food_key,input_hash,facet,rubric_version,p,judged_at")
          .in("rubric_version", rubricVersionsFor(wantedFacets))
          .in("facet", wantedFacets)
          .or(filters.join(","))
          .order("food_key").order("input_hash").order("facet").order("rubric_version")
          .range(from, from + PAGE_SIZE - 1);
        rows.push(...((data ?? []) as FacetRow[]));
        if (error) {
          reportReadFailure(filters.length, error.message);
          return { rows, failed: true };
        }
        if ((data ?? []).length < PAGE_SIZE) return { rows, failed: false };
      }
      reportReadFailure(filters.length, "page limit reached");
      return { rows, failed: true };
    } catch (cause) {
      reportReadFailure(filters.length, cause);
      return { rows, failed: true };
    }
  }));

  // t18 r2: a failed chunk, or a malformed row that names no key, fails every key of its chunk; a
  // malformed row for one key fails that key. A failed key keeps NO judgments: a missing facet
  // beside present ones would read as "not present" (an allergen facet would clear a label).
  for (const [index, response] of responses.entries()) {
    const parsedRows: Extract<ParsedRow, { kind: "match" }>[] = [];
    let chunkFailed = response.failed;
    if (response.failed) errors += 1;
    for (const row of response.rows) {
      const parsed = parseRow(row, wanted, wantedFacets);
      if (parsed.kind === "skip") continue;
      if (parsed.kind === "error") {
        errors += 1;
        if (parsed.cacheKey) failedKeys.add(parsed.cacheKey);
        else chunkFailed = true;
        continue;
      }
      parsedRows.push(parsed);
    }
    if (chunkFailed) for (const key of chunkKeys[index]) failedKeys.add(key);
    for (const parsed of parsedRows) {
      if (failedKeys.has(parsed.cacheKey)) continue;
      const current = result.get(parsed.cacheKey) ?? {};
      result.set(parsed.cacheKey, { ...current, [parsed.facet]: parsed.judgment });
    }
  }

  return withErrors(result, errors, failedKeys);
}

/** Encoded `.or()` budget per request, far below URL limits on the PostgREST path. */
export const FACET_FILTER_MAX_CHARS = 4_000;

/** Splits pair clauses into groups whose URL-encoded `.or()` value stays within the budget. */
export function chunkPairFilters(
  filters: readonly string[], maxChars: number = FACET_FILTER_MAX_CHARS,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const filter of filters) {
    const cost = encodeURIComponent(filter).length + 3; // plus the encoded "," separator
    if (current.length > 0 && size + cost > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(filter);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** A failed cache read is logged (counts and message only, never food names) and counted. */
function reportReadFailure(keys: number, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.warn("[facets] cache read failed", { keys, message });
}

function parseRow(
  row: FacetRow,
  wanted: ReadonlySet<string>,
  wantedFacets: readonly Facet[],
): ParsedRow {
  const inputHash = normalizeInputHash(row.input_hash);
  if (typeof row.food_key !== "string" || !inputHash) return { kind: "error" };
  const cacheKey = facetCacheKey({ foodKey: row.food_key, inputHash });
  if (!wanted.has(cacheKey)) return { kind: "skip" };
  if (typeof row.facet !== "string" || !FACET_SET.has(row.facet)) return { kind: "error", cacheKey };
  if (!wantedFacets.includes(row.facet as Facet)) return { kind: "skip" };

  const p = finiteNumber(row.p);
  const rubricVersion = finiteNumber(row.rubric_version);
  if (rubricVersion === null) return { kind: "error", cacheKey };
  if (rubricVersion !== facetRubricVersion(row.facet as Facet)) return { kind: "skip" };
  if (p === null || p < 0 || p > 1) return { kind: "error", cacheKey };
  const judgedAt = normalizeTimestamp(row.judged_at);
  if (!judgedAt) return { kind: "error", cacheKey };
  return {
    kind: "match",
    cacheKey,
    facet: row.facet as Facet,
    judgment: { p, rubricVersion, judgedAt },
  };
}

function postgresHash(hash: string): string {
  return normalizeInputHash(hash)
    ?? (hash.startsWith("\\x") ? hash.toLowerCase() : `\\x${hash.toLowerCase()}`);
}

function pairFilter({ foodKey, inputHash }: FacetCacheKey): string {
  return `and(food_key.eq.${quoted(foodKey)},input_hash.eq.${quoted(inputHash)})`;
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

/** Stable lookup key for one exact food identity and canonical input. */
export function facetCacheKey({ foodKey, inputHash }: FacetCacheKey): string {
  return `${foodKey}\u0000${postgresHash(inputHash)}`;
}

function withErrors(map: Map<string, FoodFacetJudgments>, errors: number,
  failedKeys: ReadonlySet<string>): FacetReadResult {
  const failed = (key: FacetCacheKey) => failedKeys.has(facetCacheKey(key));
  return Object.assign(map, { errors, failed });
}
