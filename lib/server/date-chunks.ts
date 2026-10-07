/**
 * Read a date-keyed series in date windows, so no single request meets the API's row cap
 * (`max_rows = 1000`, supabase/config.toml). A window that comes back full is split in half and
 * read again, so the cap can never silently drop rows; a one-day window that is still full is an
 * error, never a truncation. Windows are disjoint calendar ranges, so nothing is read twice.
 *
 * Found by the GPT-6 Sol review of exp-3.0.0 (2026-10-04): the estimator read five years of
 * `daily_totals` in one request, and a long history lost its most recent days.
 */
export const ROW_CAP = 1000;
export const CHUNK_DAYS = 180;

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `fetch(from, to)` must return every row with `from <= local_date <= to` (both inclusive). */
export async function readByDateChunks<T>(
  from: string, to: string, fetch: (from: string, to: string) => Promise<T[]>,
  chunkDays = CHUNK_DAYS,
): Promise<T[]> {
  async function read(start: string, end: string): Promise<T[]> {
    const rows = await fetch(start, end);
    if (rows.length < ROW_CAP) return rows;
    const span = spanDays(start, end);
    if (span === 0) throw new Error(`More than ${ROW_CAP - 1} rows on ${start}; refusing to truncate`);
    const middle = addDays(start, Math.floor(span / 2));
    return [...await read(start, middle), ...await read(addDays(middle, 1), end)];
  }
  const out: T[] = [];
  for (let start = from; start <= to; start = addDays(start, chunkDays)) {
    const end = addDays(start, chunkDays - 1) < to ? addDays(start, chunkDays - 1) : to;
    out.push(...await read(start, end));
  }
  return out;
}

/** Ids per `.in(...)` request: well under any gateway's request-line limit. */
export const ID_BATCH = 100;

/**
 * Read rows keyed by an id list in batches of `ID_BATCH`. A batch that comes back full is split in
 * half and read again, so the row cap can never silently drop rows; a single id whose rows still
 * fill the cap is an error, never a truncation. Duplicate ids are read once.
 */
export async function readByIdBatches<K, T>(
  ids: readonly K[], fetch: (batch: K[]) => Promise<T[]>, batchSize = ID_BATCH,
): Promise<T[]> {
  async function read(batch: K[]): Promise<T[]> {
    const rows = await fetch(batch);
    if (rows.length < ROW_CAP) return rows;
    if (batch.length === 1) throw new Error(`More than ${ROW_CAP - 1} rows for one id; refusing to truncate`);
    const middle = Math.ceil(batch.length / 2);
    return [...await read(batch.slice(0, middle)), ...await read(batch.slice(middle))];
  }
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += batchSize) out.push(...await read(unique.slice(i, i + batchSize)));
  return out;
}
