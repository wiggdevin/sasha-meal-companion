/**
 * Reads and writes the W1c pairing artifacts (lib/foods/pairing/artifacts/) in canonical text: one
 * row per line, object keys sorted at every level, so equal inputs give equal bytes and hashes.
 * Offline build only. Canonical JSON, hashing and the build-side NCHS gate are W1b's
 * (scripts/priors/artifact-io.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCoRows } from "@/lib/foods/pairing/schema";
import { CO_FILE, pairKey, PAIRING_DIR } from "@/lib/foods/pairing/table";
import { coFeature } from "@/scripts/pairing/co-consumption";
import { canonical } from "@/scripts/priors/artifact-io";

/** Rows one per line; an object with `rows` keeps its other keys on the first line. */
export function pairingText(value: unknown): string {
  if (Array.isArray(value)) return `[\n${value.map(canonical).join(",\n")}\n]\n`;
  if (value && typeof value === "object" && Array.isArray((value as { rows?: unknown }).rows)) {
    const { rows, ...rest } = value as { rows: unknown[] };
    return `{${canonical(rest).slice(1, -1)},"rows":[\n${rows.map(canonical).join(",\n")}\n]}\n`;
  }
  return `${JSON.stringify(JSON.parse(canonical(value)), null, 2)}\n`;
}

/** The committed co-consumption rows as `co` features by pair key; empty when the file is absent or invalid. */
export function readCoFeatures(dir: string = PAIRING_DIR): Map<string, number> {
  const path = join(dir, CO_FILE);
  const rows = existsSync(path) ? parseCoRows(JSON.parse(readFileSync(path, "utf8"))) : null;
  return new Map((rows ?? []).map((row) => [pairKey(row.anchor, row.side, row.template), coFeature(row)]));
}
