/**
 * Phase 18 W4 (Sol W4 r2 BLOCK 1, r3 BLOCK): the release fingerprint binds the import to the TARGET
 * database's FNDDS revisions: text, every nutrient amount and every portion. The zip half comes
 * from scripts/priors/fndds_release_rows.py, which reads the CSVs with scripts/import-fdc.py's own
 * helpers. With the real pinned files (the offline workspace, when present) a version that differs
 * by one changed description, one extra or missing dish, one changed nutrient amount, one missing
 * nutrient row or one changed portion is refused. The synthetic half always runs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contentHashOf, fingerprint, fingerprintDiff, nutrientKey, portionKey, readZipRows, releaseFindings, zipRowsFromHelper,
  type FingerprintRow, type ReleaseEvidence,
} from "@/scripts/priors/fndds-release";
import { FNDDS_DIR, FNDDS_FILES, FNDDS_RELEASE } from "@/scripts/priors/input-sources";
import { DEFAULT_WORKSPACE } from "@/scripts/priors/workspace";

const WORKSPACE = process.env.PRIORS_WORKSPACE ?? DEFAULT_WORKSPACE;
const HAVE_FILES = Object.values(FNDDS_FILES).every((file) => existsSync(join(WORKSPACE, file)));

function evidence(zipRows: FingerprintRow[], dbRows: FingerprintRow[]): ReleaseEvidence {
  return { zipSha256: FNDDS_RELEASE.zipSha256, files: {}, ledgerSha256: FNDDS_RELEASE.zipSha256,
    versions: [{ id: 3, source: "fdc_fndds", version_label: FNDDS_RELEASE.versionLabel, is_active: true }], zipRows, dbRows };
}

/** The first dish with at least two nutrients and a portion, changed one way each. */
function variants(rows: FingerprintRow[]): [string, keyof ReturnType<typeof fingerprintDiff>, FingerprintRow[]][] {
  const at = rows.findIndex((row) => row.nutrients.length >= 2 && row.portions.length >= 1);
  const edit = (change: (row: FingerprintRow) => FingerprintRow) => rows.map((row, i) => (i === at ? change(row) : row));
  return [
    ["description", "changed", edit((row) => ({ ...row, description: `${row.description} (changed)`,
      contentHash: contentHashOf(`${row.description} (changed)`) }))],
    ["extra dish", "extra", [...rows, { ...rows[at], fdcId: "9999999" }]],
    ["missing dish", "missing", rows.filter((_, i) => i !== at)],
    ["nutrient amount, same description", "changed", edit((row) => ({ ...row,
      nutrients: [`${row.nutrients[0].split("=")[0]}=${Number(row.nutrients[0].split("=")[1]) + 0.01}`, ...row.nutrients.slice(1)] }))],
    ["missing nutrient row, same description", "changed", edit((row) => ({ ...row, nutrients: row.nutrients.slice(1) }))],
    ["portion grams, same description", "changed", edit((row) => ({ ...row, portions: [
      row.portions[0].replace(/\|([\d.]+)\|(true|false)$/, (_m, grams, flag) => `|${Number(grams) + 1}|${flag}`),
      ...row.portions.slice(1)] }))],
  ];
}

describe("the release fingerprint", () => {
  const rows = zipRowsFromHelper([
    JSON.stringify({ fdcId: "2", description: "Milk, NFS", nutrients: [["protein", "3.33"], ["calcium", "125.0"]],
      portions: [[1, "1 cup 10205", "244.0", true]] }),
    JSON.stringify({ fdcId: "1", description: "Milk, human", nutrients: [], portions: [] }), ""].join("\n"));

  it("canonicalises numbers and keys the way the database returns them", () => {
    expect(rows[0]).toEqual({ fdcId: "2", description: "Milk, NFS", contentHash: "ba796ff3dd45d22062f0dafb168b9189",
      nutrients: ["protein=3.33", "calcium=125"], portions: ["1|1 cup 10205|244|true"] });
    expect(nutrientKey("calcium", 125)).toBe(nutrientKey("calcium", "125.0"));
    expect(portionKey(1, "1 cup 10205", 244, true)).toBe(rows[0].portions[0]);
    expect(nutrientKey("vitamin_d", null)).toBe("vitamin_d=null");
    expect(fingerprint(rows)).toBe(fingerprint([...rows].reverse()));
    expect(fingerprint([{ ...rows[0], nutrients: [...rows[0].nutrients].reverse() }, rows[1]])).toBe(fingerprint(rows));
  });

  it.each(variants(rows).map(([name, kind, db]) => [name, kind, db] as const))(
    "refuses a synthetic version with a different %s", (_name, kind, db) => {
      expect(releaseFindings(evidence(rows, rows)).findings).toEqual([]);
      expect(releaseFindings(evidence(rows, db))).toMatchObject({ versionId: null });
      expect(fingerprintDiff(rows, db)[kind]).toBe(1);
    });
});

// Vitest still runs a skipped describe's body to collect its tests, so the real-file block (which
// reads the pinned FNDDS files at collection time) is defined only where those files exist; CI has none.
if (!HAVE_FILES) describe.skip("the release fingerprint on the real pinned FNDDS files (files absent)", () => {
  it("needs the pinned FNDDS workspace", () => {});
});
else describe("the release fingerprint on the real pinned FNDDS files", () => {
  const zip = readZipRows(join(WORKSPACE, FNDDS_DIR));

  it("covers all 5,432 FNDDS 2021-2023 foods with their nutrients and portions", () => {
    expect(zip).toHaveLength(5432);
    expect(zip.reduce((sum, row) => sum + row.portions.length, 0)).toBe(22045);
    expect(zip.filter((row) => row.nutrients.length).length).toBeGreaterThan(5400);
  });

  it.each(variants(zip).map(([name, kind]) => [name, kind] as const))("refuses a version with a different %s", (name, kind) => {
    const db = variants(zip).find(([n]) => n === name)![2];
    expect(releaseFindings(evidence(zip, zip)).findings).toEqual([]);
    const result = releaseFindings(evidence(zip, db));
    expect(result.versionId).toBeNull();
    expect(result.findings.join()).toMatch(/do not match the pinned zip/);
    expect(fingerprintDiff(zip, db)[kind]).toBe(1);
  });
});
