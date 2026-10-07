/**
 * A small RFC 4180 CSV reader for the FoodData Central downloads (offline build only, W1b).
 * Quoted fields may hold commas, doubled quotes and newlines. Returns one object per row keyed by
 * the header.
 */
import { readFileSync } from "node:fs";

export function parseCsv(source: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
}

export function readCsv(path: string): Record<string, string>[] {
  return parseCsv(readFileSync(path, "utf8"));
}
