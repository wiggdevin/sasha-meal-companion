/**
 * Phase 13 §3.3 (slice 6): a `lookup` answer's numeric claims are kept only when Gemini's own
 * `groundingMetadata` links them to a source segment (`groundingSupports`). Everything else about
 * the answer is free text a model wrote from a web search; a number with no linked segment, or one
 * whose segment names no source chunk, is dropped rather than shown as fact. Deterministic — it
 * adds no extra model hop (closes Sol r1 finding 8; the Jev attribution idea was withdrawn, §6).
 *
 * Pure. No I/O.
 */

export type LookupSource = { uri: string; title: string | null };

/** The one shape this module reads out of `@google/genai`'s `GroundingMetadata`. */
export type GroundingChunk = { web?: { uri?: string | null; title?: string | null } | null };
export type GroundingSupport = {
  segment?: { startIndex?: number | null; endIndex?: number | null } | null;
  groundingChunkIndices?: readonly number[] | null;
};
export type GroundingMetadata = {
  groundingChunks?: readonly GroundingChunk[] | null;
  groundingSupports?: readonly GroundingSupport[] | null;
  webSearchQueries?: readonly string[] | null;
} | null | undefined;

export type FilteredLookupAnswer = {
  /** The answer with every unsupported numeric claim replaced by a redaction marker. */
  text: string;
  /** The source links the KEPT claims are grounded in, deduplicated, in first-cited order. */
  sources: readonly LookupSource[];
  /** How many search queries the grounding call spent — the §3.3/§8 item 3 cost line. */
  webSearchQueries: number;
};

export const REDACTED = "[unconfirmed]";

/** Any run of digits, with the usual decimal/thousands separators and a food-nutrition unit. */
const NUMBER = /\d[\d,]*(?:\.\d+)?\s?(?:kcal|cal|calories|k?j|joules?|g|kg|mg|mcg|µg|%|percent)?/gi;

function segmentOf(support: GroundingSupport): { start: number; end: number } | null {
  const start = support.segment?.startIndex ?? null;
  const end = support.segment?.endIndex ?? null;
  if (start === null || end === null || start === undefined || end === undefined) return null;
  return { start, end };
}

/** The chunk's source link, or null when the index is out of range or the chunk has no URI. */
function linkOf(chunks: readonly GroundingChunk[], i: number): LookupSource | null {
  const web = chunks[i]?.web;
  if (typeof web?.uri !== "string" || web.uri.length === 0) return null;
  return { uri: web.uri, title: web.title ?? null };
}

/**
 * The chunk indices that back a text index: those of the first segment covering it that names at
 * least one chunk with a real source link. An out-of-range index or a link-less chunk backs
 * nothing (review r1, sol FIX), so a kept number always has a source the user can open.
 */
function linkedChunksFor(
  index: number, supports: readonly GroundingSupport[], chunks: readonly GroundingChunk[],
): number[] | null {
  for (const support of supports) {
    const range = segmentOf(support);
    if (!range || index < range.start || index >= range.end) continue;
    const linked = (support.groundingChunkIndices ?? []).filter((i) => linkOf(chunks, i) !== null);
    if (linked.length > 0) return linked;
  }
  return null;
}

/**
 * Drops every numeric claim the grounding metadata does not link to a source, and lists the
 * sources the claims that survived actually cite. A `lookup` answer with no grounding metadata at
 * all (a malformed or non-grounded response) keeps no numbers and cites no sources.
 */
export function filterGroundedAnswer(text: string, metadata: GroundingMetadata): FilteredLookupAnswer {
  const supports = metadata?.groundingSupports ?? [];
  const chunks = metadata?.groundingChunks ?? [];
  const keptChunkIndices = new Set<number>();
  const filtered = text.replace(NUMBER, (match: string, offset: number) => {
    const linked = linkedChunksFor(offset, supports, chunks);
    if (!linked) return REDACTED;
    for (const i of linked) keptChunkIndices.add(i);
    return match;
  });
  const seen = new Set<string>();
  const sources: LookupSource[] = [...keptChunkIndices].sort((a, b) => a - b)
    .map((i) => linkOf(chunks, i))
    .filter((link): link is LookupSource => {
      if (link === null || seen.has(link.uri)) return false;
      seen.add(link.uri);
      return true;
    });
  return { text: filtered, sources, webSearchQueries: metadata?.webSearchQueries?.length ?? 0 };
}
