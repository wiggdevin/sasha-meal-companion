/**
 * The FNDDS release check of the W4 import (Sol W4 r1 BLOCK 1). Before anything is written, the
 * run must prove that the recipes it read and the catalog it writes to are the same release:
 *
 *   1. the workspace zip hashes to the pinned `FNDDS_RELEASE.zipSha256`;
 *   2. each FNDDS file read from the workspace is byte-identical to its member of that zip;
 *   3. the catalog import worker's ledger (`~/Backups/usda/fdc/<label>/checksums.json`, written by
 *      scripts/import-fdc.py) records that same zip for `fdc_fndds` under the pinned label;
 *   4. the catalog has exactly that `catalog_versions` row (`fdc_fndds`, pinned label) and it is
 *      active;
 *   5. (Sol W4 r2 BLOCK 1, r3) the TARGET database holds that release: a content fingerprint of
 *      the version's revisions as stored (FoodData Central id, description, `content_hash`, every
 *      nutrient amount, every portion) equals the fingerprint of what scripts/import-fdc.py stores
 *      from the pinned zip's CSVs, computed by scripts/priors/fndds_release_rows.py with that
 *      worker's own readers (`content_hash` = md5(description || '|' || category); the FNDDS zip has
 *      no category list, so md5(description || '|')). A missing, extra or changed dish (text,
 *      nutrient amount or portion) refuses the run.
 * Then fndds-inputs-rows.ts refuses any dish revision outside that version. Any finding refuses the
 * whole run. The importer re-runs checks 4 and 5 after its last write (`postWriteFindings`).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { FNDDS_DIR, FNDDS_FILES, FNDDS_RELEASE } from "@/scripts/priors/input-sources";

export const FDC_LEDGER_ROOT = join(homedir(), "Backups", "usda", "fdc");

export type CatalogVersion = { id: number; source: string; version_label: string; is_active: boolean };
/**
 * One dish revision as the fingerprint sees it: identity and text, plus every stored nutrient
 * amount (`code=amount`, sorted by code; `energy_kcal_calc` excluded, the catalog derives it in SQL
 * from these) and every stored portion (`seq|label|grams|default`, sorted by seq). Numbers are
 * canonical: `String(Number(x))`, so 125, "125.0" and 125.0 agree.
 */
export type FingerprintRow = { fdcId: string; description: string; contentHash: string; nutrients: string[];
  portions: string[] };

export const num = (value: unknown): string => (value === null || value === undefined ? "null" : String(Number(value)));
export const nutrientKey = (code: string, amount: unknown) => `${code}=${num(amount)}`;
export const portionKey = (seq: unknown, label: string, grams: unknown, isDefault: unknown) =>
  `${Number(seq)}|${label}|${num(grams)}|${isDefault === true}`;
export const contentHashOf = (description: string) => createHash("md5").update(`${description}|`).digest("hex");
export type ReleaseEvidence = {
  zipSha256: string | null;
  /** Workspace file → [its sha256, the sha256 of the zip member of the same name]. */
  files: Record<string, [string | null, string | null]>;
  ledgerSha256: string | null;
  versions: CatalogVersion[];
  /** From the pinned zip's food.csv, and from the target database's label-matched version. */
  zipRows: FingerprintRow[];
  dbRows: FingerprintRow[];
};

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const line = (row: FingerprintRow) => [row.fdcId, row.description, row.contentHash,
  [...row.nutrients].sort().join(";"), [...row.portions].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(";")].join("\t");

/** sha256 of the rows in FoodData Central id order, one tab-separated line each. */
export function fingerprint(rows: readonly FingerprintRow[]): string {
  const lines = [...rows].sort((a, b) => Number(a.fdcId) - Number(b.fdcId) || a.fdcId.localeCompare(b.fdcId)).map(line);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Parses the JSON lines of scripts/priors/fndds_release_rows.py (import-fdc.py's own readers). */
export function zipRowsFromHelper(output: string): FingerprintRow[] {
  return output.split("\n").filter(Boolean).map((text) => {
    const row = JSON.parse(text) as { fdcId: string; description: string; nutrients: [string, string | null][];
      portions: [number, string, string, boolean][] };
    return { fdcId: row.fdcId, description: row.description, contentHash: contentHashOf(row.description),
      nutrients: row.nutrients.map(([code, amount]) => nutrientKey(code, amount)),
      portions: row.portions.map(([seq, label, grams, isDefault]) => portionKey(seq, label, grams, isDefault)) };
  });
}

/** Runs the Python helper over the workspace's FNDDS CSVs (the files proven to be the zip's own). */
export function readZipRows(csvDir: string): FingerprintRow[] {
  const python = existsSync(join(process.cwd(), ".venv", "bin", "python")) ? join(process.cwd(), ".venv", "bin", "python") : "python3";
  const output = execFileSync(python, [join(process.cwd(), "scripts", "priors", "fndds_release_rows.py"), csvDir],
    { encoding: "utf8", maxBuffer: 1 << 28 });
  return zipRowsFromHelper(output);
}

/** How two fingerprint row sets differ: dishes only in the zip, only in the database, or changed. */
export function fingerprintDiff(zip: readonly FingerprintRow[], db: readonly FingerprintRow[]) {
  const key = line;
  const inZip = new Map(zip.map((row) => [row.fdcId, key(row)]));
  const inDb = new Map(db.map((row) => [row.fdcId, key(row)]));
  return { missing: [...inZip.keys()].filter((id) => !inDb.has(id)).length,
    extra: [...inDb.keys()].filter((id) => !inZip.has(id)).length,
    changed: [...inZip].filter(([id, value]) => inDb.has(id) && inDb.get(id) !== value).length };
}

/** Pure: every way the evidence fails to name the pinned release. */
export function releaseFindings(evidence: ReleaseEvidence, pin: typeof FNDDS_RELEASE = FNDDS_RELEASE):
  { findings: string[]; versionId: number | null } {
  const findings: string[] = [];
  if (evidence.zipSha256 !== pin.zipSha256) {
    findings.push(`release: workspace zip ${pin.zip} hashes to ${evidence.zipSha256 ?? "(missing)"}, pinned ${pin.zipSha256}`);
  }
  for (const [file, [own, member]] of Object.entries(evidence.files)) {
    if (!own || own !== member) findings.push(`release: ${file} is not the file inside the pinned zip`);
  }
  if (evidence.ledgerSha256 !== pin.zipSha256) {
    findings.push(`release: the catalog import ledger for ${pin.versionLabel} records ${evidence.ledgerSha256 ?? "nothing"} `
      + `for ${pin.catalogSource}, pinned ${pin.zipSha256}`);
  }
  const matching = evidence.versions.filter((v) => v.source === pin.catalogSource && v.version_label === pin.versionLabel);
  if (matching.length !== 1) {
    findings.push(`release: the catalog has ${matching.length} ${pin.catalogSource} version(s) labelled ${pin.versionLabel}`);
  } else if (!matching[0].is_active) {
    findings.push(`release: catalog version ${matching[0].id} (${pin.versionLabel}) is not the active ${pin.catalogSource} version`);
  }
  const zipPrint = fingerprint(evidence.zipRows);
  if (!evidence.zipRows.length || zipPrint !== fingerprint(evidence.dbRows)) {
    const diff = fingerprintDiff(evidence.zipRows, evidence.dbRows);
    findings.push(`release: the target database's ${pin.catalogSource} ${pin.versionLabel} revisions do not match the pinned zip `
      + `(${diff.missing} missing, ${diff.extra} extra, ${diff.changed} changed dish(es))`);
  }
  return { findings, versionId: findings.length === 0 && matching.length === 1 ? Number(matching[0].id) : null };
}

/** After the last write: the same version must still be active and still hold the same release. */
export function postWriteFindings(before: number, after: { findings: string[]; versionId: number | null }): string[] {
  if (after.versionId === before) return [];
  return [`release changed during the import: version ${before} before, ${after.versionId ?? "none proven"} after`,
    ...after.findings];
}

function fileSha(path: string): string | null {
  return existsSync(path) ? sha(readFileSync(path)) : null;
}

function memberSha(zip: string, name: string): string | null {
  try {
    return sha(execFileSync("unzip", ["-p", zip, `*/${name}`], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

/** Reads the file half of the evidence (the catalog versions come from the database). */
export function readReleaseFiles(workspace: string, ledgerRoot = FDC_LEDGER_ROOT):
  Omit<ReleaseEvidence, "versions" | "dbRows"> {
  const zip = join(workspace, FNDDS_RELEASE.zip);
  const files = Object.fromEntries(Object.values(FNDDS_FILES).map((file) => [file,
    [fileSha(join(workspace, file)), existsSync(zip) ? memberSha(zip, basename(file)) : null] as [string | null, string | null]]));
  let ledgerSha256: string | null = null;
  const ledger = join(ledgerRoot, FNDDS_RELEASE.versionLabel, "checksums.json");
  if (existsSync(ledger)) {
    const value = (JSON.parse(readFileSync(ledger, "utf8")) as Record<string, unknown>)[FNDDS_RELEASE.catalogSource];
    ledgerSha256 = typeof value === "string" ? value : null;
  }
  const dir = join(workspace, FNDDS_DIR);
  const zipRows = Object.values(FNDDS_FILES).every((file) => existsSync(join(workspace, file))) ? readZipRows(dir) : [];
  return { zipSha256: fileSha(zip), files, ledgerSha256, zipRows };
}
