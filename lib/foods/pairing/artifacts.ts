/**
 * Server loader of the W1c pairing table (Phase 18 D10). It loads the table only when its identity
 * checks out (W1c round 2), and otherwise refuses with null, so every pair scores its curated B:
 *   - the table file's sha256 equals the manifest's `table.sha256` (a stale or edited table, even a
 *     schema-valid one, is refused);
 *   - the manifest's curated hash equals the pinned PAIRING_CURATED_SHA256, and the rows' own
 *     curated hash equals the manifest's `table.rowsHash`;
 *   - the table and the manifest parse under their strict schemas (each stored `pair` must equal
 *     its formula);
 *   - the activation invariant holds (./gate.ts): no non-curated term carries a weight or a row
 *     without its validation evidence, even when every hash matches.
 * Then the NCHS gate: the NHANES `co` part is kept only while the ruling file exists at its
 * approved hash (lib/foods/universe/artifacts.ts `rulingHash`) and the manifest names it (./gate.ts).
 *
 * Nothing in the app reads it yet: W8 wires the table into `pairScore` for open-world accounts.
 */
import "server-only";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activationViolations, gatedPairingTable } from "@/lib/foods/pairing/gate";
import { parsePairingManifest, parsePairingTable } from "@/lib/foods/pairing/schema";
import {
  PAIRING_CURATED_SHA256, PAIRING_DIR, PAIRING_MANIFEST_FILE, rowsCuratedHash, TABLE_FILE, type PairingTable,
} from "@/lib/foods/pairing/table";
import { rulingHash } from "@/lib/foods/universe/artifacts";
import { NHANES_RULING_SHA256 } from "@/lib/foods/universe/prior";

export type PairingRefusal = "table_missing" | "table_invalid" | "manifest_invalid" | "table_hash" | "curated_hash" | "rows_hash"
  | "activation_unauthorized";

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function parseJson(text: string | null): unknown {
  try {
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function loadPairing(root: string = process.cwd()): { table: PairingTable } | { refused: PairingRefusal } {
  const text = readText(join(root, PAIRING_DIR, TABLE_FILE));
  if (text === null) return { refused: "table_missing" };
  const table = parsePairingTable(parseJson(text));
  if (!table) return { refused: "table_invalid" };
  const manifest = parsePairingManifest(parseJson(readText(join(root, PAIRING_DIR, PAIRING_MANIFEST_FILE))));
  if (!manifest) return { refused: "manifest_invalid" };
  if (createHash("sha256").update(text).digest("hex") !== manifest.table.sha256) return { refused: "table_hash" };
  if (manifest.curated.hash !== PAIRING_CURATED_SHA256) return { refused: "curated_hash" };
  if (rowsCuratedHash(table.rows) !== manifest.table.rowsHash) return { refused: "rows_hash" };
  if (activationViolations(table, manifest).length) return { refused: "activation_unauthorized" };
  return { table: gatedPairingTable(table, manifest, rulingHash(root) === NHANES_RULING_SHA256) };
}

const logged = new Set<string>();

/** The verified, gated table, or null (refused: logged once, every pair scores its curated B). */
export function loadPairingTable(root: string = process.cwd()): PairingTable | null {
  const result = loadPairing(root);
  if ("table" in result) return result.table;
  if (!logged.has(result.refused)) {
    logged.add(result.refused);
    console.warn(`[pairing-table] refused (every pair scores its curated B): ${result.refused}`);
  }
  return null;
}
