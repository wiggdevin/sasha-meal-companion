/**
 * CSV for the export route. Two concerns, in this order:
 *
 * 1. Formula injection. A cell opening with = + - @ is executed by Excel,
 *    Numbers and Sheets when the file is opened. An apostrophe in front makes
 *    it text. architecture.md §4.6.
 * 2. RFC 4180 quoting. Comma, double quote, CR and LF force quoting; an inner
 *    double quote doubles.
 *
 * Pure. No I/O.
 */

const FORMULA_LEAD = /^[=+\-@]/;
const MUST_QUOTE = /[",\r\n]/;

export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  const guarded = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  if (!MUST_QUOTE.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(escapeCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * OFF data is ODbL (architecture §3.1): any export of an OFF-derived row carries the notice, in
 * the JSON `notices` array and as a trailing CSV comment line.
 */
export const ODBL_NOTICE =
  "Data from Open Food Facts, licensed under the Open Database License (ODbL).";

/**
 * Positional sibling of `toCsv`: the streaming export already has its rows as arrays in column
 * order, so it never builds a keyed object per row just to serialise it.
 */
export function csvDocument(
  header: string[],
  rows: readonly (string | number | null)[][],
  notices: readonly string[] = []
): string {
  const lines = [header.map(escapeCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCell).join(","));
  for (const notice of notices) lines.push(`# ${notice}`);
  return `${lines.join("\r\n")}\r\n`;
}
