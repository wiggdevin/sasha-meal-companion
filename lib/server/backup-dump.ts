/**
 * The nightly JSON backup as numbered parts, each a page-at-a-time stream (audit 2026-10-10 F10).
 *
 * - Keyset paging (A122): every table is read in primary-key order, `key > last`, one page of
 *   `PAGE` rows at a time (the API's `max_rows`, supabase/config.toml). A row that exists for the
 *   whole pass is written exactly once, whatever is inserted or deleted around it; OFFSET paging
 *   skipped or repeated a row at each page boundary a concurrent write moved.
 * - Parts (A123): one part is one Storage object. A part ends after the page that crosses the run's
 *   deadline or `PART_MAX_BYTES`, and its `BackupCursor` says where the next part starts, so a pass
 *   is strung across runs like lib/server/job-sweep.ts and no object outgrows the bucket limit.
 *
 * Part document (`user-table-export-v2-part`): `{ format, consistency, pass_started_at, taken_at,
 * part, tables: { <name>: [rows…] } }`; a table that spans parts appears in each, its rows in key
 * order. The pass manifest (`user-table-export-v2`) lists the parts in order. A reader joins each
 * table's rows across the parts.
 */
import type { adminClient } from "@/lib/server/admin";
import { BACKUP_TABLES, type BackupTable } from "@/lib/server/backup-tables";

type Admin = ReturnType<typeof adminClient>;

/** supabase/config.toml `max_rows`: a bigger page would be cut short with no error. */
export const PAGE = 1000;
/** Under the Storage object limit (50 MiB by default), with room for the page that crosses it. */
export const PART_MAX_BYTES = 32 * 1024 * 1024;
export const PART_FORMAT = "user-table-export-v2-part";
export const MANIFEST_FORMAT = "user-table-export-v2";

/** Where the next part starts. `table` null: every table has been read. */
export type BackupCursor = {
  table: string | null;
  /** The last key written in `table`; null starts at its first row. */
  after: string[] | null;
  /** The number of the next part to write (parts 1 … part - 1 exist). */
  part: number;
  /** Bytes of the parts written so far. */
  bytes: number;
};

export const START: BackupCursor = { table: BACKUP_TABLES[0].name, after: null, part: 1, bytes: 0 };

export function serializeCursor(cursor: BackupCursor): string {
  return JSON.stringify(cursor);
}

/** The saved cursor, or null when it is missing or not one this build can resume. */
export function parseCursor(text: string | null): BackupCursor | null {
  if (!text) return null;
  try {
    const c = JSON.parse(text) as Record<string, unknown>;
    const tableOk = c.table === null
      || (typeof c.table === "string" && BACKUP_TABLES.some((t) => t.name === c.table));
    const afterOk = c.after === null
      || (Array.isArray(c.after) && c.after.every((v) => typeof v === "string"));
    if (!tableOk || !afterOk || !Number.isInteger(c.part) || (c.part as number) < 1
      || !Number.isInteger(c.bytes) || (c.bytes as number) < 0) return null;
    const table = c.table as string | null;
    const after = c.after as string[] | null;
    if (after && (table === null || after.length !== tableNamed(table).key.length)) return null;
    return { table, after, part: c.part as number, bytes: c.bytes as number };
  } catch {
    return null;
  }
}

function tableNamed(name: string): BackupTable {
  const found = BACKUP_TABLES.find((t) => t.name === name);
  if (!found) throw new Error(`backup: unknown table ${name}`);
  return found;
}

export function partPath(date: string, part: number): string {
  return `meal-companion/${date}/part-${String(part).padStart(4, "0")}.json`;
}

export function manifestPath(date: string): string {
  return `meal-companion/${date}.json`;
}

/** A PostgREST filter value in double quotes, so a comma, dot or parenthesis stays inside it. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `(k1, k2, …) > (v1, v2, …)` as a PostgREST `or` filter: k1 > v1, or k1 = v1 and k2 > v2, and so on.
 */
export function afterFilter(key: readonly string[], values: readonly string[]): string {
  return key.map((column, i) => {
    const gt = `${column}.gt.${quoted(values[i])}`;
    if (i === 0) return gt;
    const equal = key.slice(0, i).map((prior, j) => `${prior}.eq.${quoted(values[j])}`);
    return `and(${[...equal, gt].join(",")})`;
  }).join(",");
}

function keyOf(table: BackupTable, row: Record<string, unknown>): string[] {
  return table.key.map((column) => {
    const value = row[column];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    throw new Error(`backup: ${table.name}.${column} is not a key value`);
  });
}

/** One page of `table` after `after`, in primary-key order. */
async function keysetPage(
  db: Admin, table: BackupTable, after: string[] | null,
): Promise<Record<string, unknown>[]> {
  let query = db.from(table.name).select("*");
  if (after) {
    query = table.key.length === 1 ? query.gt(table.key[0], after[0])
      : query.or(afterFilter(table.key, after));
  }
  for (const column of table.key) query = query.order(column);
  const { data, error } = await query.limit(PAGE);
  if (error) throw new Error(`${table.name}: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  // A page that starts at the key it was asked to pass ignored the filter: it would repeat forever.
  if (after && rows.length > 0 && keyOf(table, rows[0]).join("\u0000") === after.join("\u0000")) {
    throw new Error(`${table.name}: the page after a key repeats it; the keyset filter was ignored`);
  }
  return rows;
}

export type PartOptions = {
  passStartedAt: Date;
  /** Epoch ms after which the part ends at the next page boundary. */
  deadline: number;
  maxBytes?: number;
  now?: () => number;
};

/**
 * The text of one part, from `cursor`. At least one page is always read, so every part moves the
 * cursor. When the generator finishes, `progress.next` is where the next part starts (its `bytes`
 * still the total before this part; the caller adds what it sent).
 */
export async function* partText(
  db: Admin, cursor: BackupCursor, options: PartOptions, progress: { next?: BackupCursor },
): AsyncGenerator<string> {
  if (cursor.table === null) throw new Error("backup: every table has been read already");
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? PART_MAX_BYTES;
  yield `{"format":${JSON.stringify(PART_FORMAT)},"consistency":"keyset","pass_started_at":${
    JSON.stringify(options.passStartedAt.toISOString())},"taken_at":${
    JSON.stringify(new Date(now()).toISOString())},"part":${cursor.part},"tables":{`;
  let bytes = 0;
  let pages = 0;
  let after = cursor.after;
  const first = BACKUP_TABLES.findIndex((t) => t.name === cursor.table);
  for (let index = first; index < BACKUP_TABLES.length; index += 1) {
    const table = BACKUP_TABLES[index];
    yield `${index === first ? "" : ","}${JSON.stringify(table.name)}:[`;
    let firstRow = true;
    for (;;) {
      if (pages > 0 && (now() >= options.deadline || bytes >= maxBytes)) {
        progress.next = { table: table.name, after, part: cursor.part + 1, bytes: cursor.bytes };
        yield "]}}";
        return;
      }
      const rows = await keysetPage(db, table, after);
      pages += 1;
      if (rows.length > 0) {
        const text = rows.map((row) => JSON.stringify(row)).join(",");
        bytes += text.length;
        yield `${firstRow ? "" : ","}${text}`;
        firstRow = false;
        after = keyOf(table, rows[rows.length - 1]);
      }
      if (rows.length < PAGE) break;
    }
    yield "]";
    after = null;
  }
  progress.next = { table: null, after: null, part: cursor.part + 1, bytes: cursor.bytes };
  yield "}}";
}

/** A pull-driven byte stream of `pieces`: the next page is read only when the upload asks for more,
 *  so memory holds what is in flight, never the part. `sent.bytes` counts what went. Once
 *  `stop.stopped` is set, the next pull fails the stream instead of reading on. */
export function byteStream(
  pieces: AsyncGenerator<string>, sent: { bytes: number }, stop: { stopped: boolean },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stop.stopped) {
        controller.error(new Error("backup: the run hit its hard stop"));
        await pieces.return(undefined);
        return;
      }
      const next = await pieces.next();
      if (next.done) {
        controller.close();
        return;
      }
      const bytes = encoder.encode(next.value);
      sent.bytes += bytes.byteLength;
      controller.enqueue(bytes);
    },
    async cancel() {
      await pieces.return(undefined);
    },
  });
}

/** The pass manifest: written last, it names every part in order. */
export function manifestText(
  date: string, cursor: BackupCursor, passStartedAt: Date, finishedAt: Date,
): string {
  return JSON.stringify({
    format: MANIFEST_FORMAT,
    consistency: "keyset",
    pass_started_at: passStartedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    bytes: cursor.bytes,
    tables: BACKUP_TABLES.map((t) => t.name),
    parts: Array.from({ length: cursor.part - 1 }, (_, i) => partPath(date, i + 1)),
  });
}
