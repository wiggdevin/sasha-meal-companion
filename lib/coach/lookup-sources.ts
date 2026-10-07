/**
 * Phase 13 §3.3 "Source links are shown" (slice 6, review r1 sol FIX): the `lookup` tool's source
 * links go into the reply deterministically, after the model's own text, so the user sees where a
 * web-grounded fact came from even when the model's reply leaves them out.
 *
 * Pure. No I/O.
 */
import type { LookupSource, LookupToolResult } from "@/lib/coach/lookup-types";

/** At most this many links: a reply is a chat bubble, not a bibliography. */
export const MAX_SHOWN_SOURCES = 3;

/** The source links a successful `lookup` result carries, or none. */
export function lookupSourcesOf(result: unknown): readonly LookupSource[] {
  const r = result as Partial<Extract<LookupToolResult, { ok: true }>> | null;
  return r?.ok === true && Array.isArray(r.sources) ? r.sources : [];
}

/** `text` with one "Sources:" line of deduplicated links, or `text` unchanged when none. */
export function appendLookupSources(text: string, sources: readonly LookupSource[]): string {
  const seen = new Set<string>();
  const shown = sources.filter((source) => {
    if (seen.has(source.uri)) return false;
    seen.add(source.uri);
    return true;
  }).slice(0, MAX_SHOWN_SOURCES);
  if (shown.length === 0) return text;
  const links = shown.map((source) => source.title ? `${source.title} (${source.uri})` : source.uri);
  return `${text}\n\nSources: ${links.join("; ")}`;
}
