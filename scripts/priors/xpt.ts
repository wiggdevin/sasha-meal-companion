/**
 * A reader for SAS transport (XPORT v5) files, the format NHANES publishes. Offline build only
 * (Phase 18 W1b): it reads a file from the local workspace into plain column arrays and is never
 * imported by app/, lib/ or components/.
 *
 * Layout (SAS TS-140): 80-byte header records, one 140-byte NAMESTR per variable, then the
 * observations packed back to back. Numbers are IBM System/360 floats (big-endian, base 16,
 * excess-64 exponent) of 2 to 8 bytes; a missing value is a byte of `.`, `_` or `A`-`Z` followed by
 * zeros. Character values are space-padded.
 */
import { readFileSync } from "node:fs";

export type XptColumn = { name: string; numeric: boolean; length: number; offset: number };
export type XptTable = { columns: XptColumn[]; rows: number; values: Map<string, (number | string | null)[]> };

const RECORD = 80;

function text(buffer: Buffer, start: number, length: number): string {
  return buffer.toString("latin1", start, start + length);
}

/** IBM 360 floating point to a JS number; null for a SAS missing value. */
export function ibmToNumber(bytes: Buffer, start: number, length: number): number | null {
  const first = bytes[start];
  let rest = 0;
  for (let i = 1; i < length; i += 1) rest |= bytes[start + i];
  if (rest === 0 && (first === 0x2e || first === 0x5f || (first >= 0x41 && first <= 0x5a))) return null;
  if (first === 0 && rest === 0) return 0;
  const sign = first & 0x80 ? -1 : 1;
  const exponent = (first & 0x7f) - 64;
  let mantissa = 0;
  for (let i = 1; i < 8; i += 1) mantissa = mantissa * 256 + (i < length ? bytes[start + i] : 0);
  return sign * (mantissa / 2 ** 56) * 16 ** exponent;
}

function findRecord(buffer: Buffer, marker: string, from: number): number {
  for (let at = from; at + RECORD <= buffer.length; at += RECORD) {
    if (text(buffer, at, marker.length) === marker) return at;
  }
  throw new Error(`xpt: header "${marker}" not found`);
}

/** The NAMESTR block: one 140-byte descriptor per variable. */
function readColumns(buffer: Buffer): { columns: XptColumn[]; dataStart: number } {
  const namestrHeader = findRecord(buffer, "HEADER RECORD*******NAMESTR HEADER RECORD", 0);
  const count = Number(text(buffer, namestrHeader + 54, 4));
  const descriptorStart = namestrHeader + RECORD;
  const columns: XptColumn[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = descriptorStart + i * 140;
    columns.push({
      numeric: buffer.readInt16BE(at) === 1,
      length: buffer.readInt16BE(at + 4),
      name: text(buffer, at + 8, 8).trim(),
      offset: buffer.readInt32BE(at + 84),
    });
  }
  const afterDescriptors = descriptorStart + count * 140;
  const padded = Math.ceil(afterDescriptors / RECORD) * RECORD;
  const obsHeader = findRecord(buffer, "HEADER RECORD*******OBS     HEADER RECORD", padded);
  return { columns, dataStart: obsHeader + RECORD };
}

/** Reads only `wanted` columns (all when omitted). Trailing all-space padding rows are dropped. */
export function readXpt(path: string, wanted?: readonly string[]): XptTable {
  const buffer = readFileSync(path);
  const { columns, dataStart } = readColumns(buffer);
  const rowLength = columns.reduce((sum, column) => sum + column.length, 0);
  const keep = wanted ? columns.filter((column) => wanted.includes(column.name)) : columns;
  const missing = (wanted ?? []).filter((name) => !columns.some((column) => column.name === name));
  if (missing.length) throw new Error(`xpt: ${path} has no column ${missing.join(", ")}`);
  const values = new Map<string, (number | string | null)[]>(keep.map((column) => [column.name, []]));
  let rows = 0;
  for (let at = dataStart; at + rowLength <= buffer.length; at += rowLength) {
    let blank = true;
    for (let i = 0; i < rowLength && blank; i += 1) if (buffer[at + i] !== 0x20) blank = false;
    if (blank) break;
    for (const column of keep) {
      const out = values.get(column.name)!;
      out.push(column.numeric ? ibmToNumber(buffer, at + column.offset, column.length)
        : text(buffer, at + column.offset, column.length).trimEnd());
    }
    rows += 1;
  }
  return { columns: keep, rows, values };
}

/** A numeric column as numbers, with NaN for missing. */
export function numbers(table: XptTable, name: string): Float64Array {
  const column = table.values.get(name);
  if (!column) throw new Error(`xpt: column ${name} was not read`);
  return Float64Array.from(column, (value) => (typeof value === "number" ? value : NaN));
}
