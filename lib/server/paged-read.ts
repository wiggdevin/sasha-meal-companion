/**
 * Complete multi-row reads past the API's row cap (`max_rows = 1000`, supabase/config.toml).
 *
 * A plain `.select()` silently stops at the cap with no sign it was truncated. For food-safety data
 * (the Avoid list, stored allergen evidence, allergen checks, ingredient allergen tags) a
 * truncated read is a fail-open: a missing `listed` row or Avoid entry reads as "no rule" and the
 * food passes. Every read here is all-or-nothing: any failed page rejects, so a caller never sees a
 * partial set as if it were the whole one.
 *
 * `.range()` is LIMIT/OFFSET, so the query each caller builds must carry a total, unique
 * `.order()` (a primary key), or Postgres may skip or repeat ties across pages.
 *
 * Moved here from scripts/allergen-evidence-repair.ts (2026-10-05, t18), which re-exports it.
 * No `server-only` import: the repair script runs this under plain tsx.
 */
export const PAGE_SIZE = 1000;
/**
 * A hard ceiling on the page loop. A server or proxy that ignores `.range()` and always returns a
 * full page would otherwise spin forever; five million rows is far past anything these reads hold.
 */
export const MAX_PAGES = 5_000;
/** Keeps a `.in(...)` key list well under any gateway's request-line limit. */
export const IN_CHUNK_SIZE = 150;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

export function chunk<T>(items: readonly T[], size: number = IN_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Pages a `.range()`-capable select to completion. `page(from, to)` is inclusive on both ends,
 * as `.range()` is. Throws on the first failed page; never returns a partial set.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const from = pageNumber * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
  throw new Error(`fetchAllRows: exceeded ${MAX_PAGES} pages — the paging contract likely broke`);
}

/**
 * Keyset reads of at most `want` rows (W012: the export's page of up to 5,000 rows read past the
 * cap). `page(after, size)` returns the next `size` rows strictly after `after` (null: from the
 * start) in the caller's total, unique order; each request asks for at most `PAGE_SIZE` rows, and a
 * short request ends the read. Any failed request rejects the whole read, never a partial set.
 */
export async function fetchUpTo<T>(
  want: number,
  page: (after: T | null, size: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let pageNumber = 0; out.length < want; pageNumber += 1) {
    if (pageNumber >= MAX_PAGES) {
      throw new Error(`fetchUpTo: exceeded ${MAX_PAGES} pages — the paging contract likely broke`);
    }
    const size = Math.min(PAGE_SIZE, want - out.length);
    const { data, error } = await page(out.at(-1) ?? null, size);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).slice(0, size);
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

/**
 * Pages every chunk of a large `.in(...)` key list and concatenates the results. Chunks run one
 * after another (no request burst); any failed page of any chunk rejects the whole read.
 */
export async function fetchAllChunked<K, T>(
  keys: readonly K[],
  pageForChunk: (chunk: K[], from: number, to: number) => PromiseLike<PageResult<T>>,
  size: number = IN_CHUNK_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  for (const batch of chunk(keys, size)) {
    out.push(...await fetchAllRows<T>((from, to) => pageForChunk(batch, from, to)));
  }
  return out;
}
