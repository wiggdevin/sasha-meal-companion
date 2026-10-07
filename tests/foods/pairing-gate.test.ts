/**
 * Phase 18 W1c, acceptance 6 — the NCHS gate on the pairing feature (docs/specs/phase-18-open-world-foods.md
 * D10): the NHANES part of `co` is built and bundled only while
 * docs/decisions/2026-10-05-nhanes-aggregate-use.md exists at its approved hash and the pairing
 * manifest names it. Without it the spec builds the table from the Ahn lists alone; the Ahn data
 * is CC BY-NC-SA (non-commercial) and withheld, so the `co` term is then empty and every pair
 * scores its curated B. The committed table ships co at weight 0 (round 2), so the runtime gate is
 * exercised on a fixture table built at the co target weight, with a manifest that names its bytes.
 *
 * Round 2 (Sol W1c-r1 WARN): the loader verifies identity — the table bytes against the manifest
 * sha256, the manifest's curated hash against the pin, and the rows against the manifest's rows
 * hash — and refuses (null: every pair scores its curated B) an edited, schema-valid table.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createHash } from "node:crypto";
import { loadPairing, loadPairingTable } from "@/lib/foods/pairing/artifacts";
import { gatedPairingTable, manifestNamesRuling } from "@/lib/foods/pairing/gate";
import { parsePairingManifest, parsePairingTable } from "@/lib/foods/pairing/schema";
import {
  buildPairingTable, PAIR_CO_TARGET_WEIGHT, PAIR_WEIGHTS, PAIRING_DIR, PAIRING_MANIFEST_FILE, rowsCuratedHash, TABLE_FILE,
  type PairingTable,
} from "@/lib/foods/pairing/table";
import { pairingText, readCoFeatures } from "@/scripts/pairing/artifact-io";
import { PASSING_EVIDENCE } from "@/tests/helpers/pairing-evidence";
import { fixedPairs } from "@/scripts/pairing/pairs";
import { NHANES_RULING_PATH } from "@/lib/foods/universe/prior";
import { buildPairing } from "@/scripts/pairing/build";
import { runPairingChecks } from "@/scripts/pairing/check-pairing";

const fixtures: string[] = [];
const committedTable = parsePairingTable(JSON.parse(readFileSync(path.join(PAIRING_DIR, TABLE_FILE), "utf8")))!;
const committedManifest = parsePairingManifest(JSON.parse(readFileSync(path.join(PAIRING_DIR, PAIRING_MANIFEST_FILE), "utf8")))!;

/** A table with co at its target weight: never shipped; it gives the gate something to drop. */
const withCo = buildPairingTable(fixedPairs(), { co: readCoFeatures(), jev: null, comp: null },
  { ...PAIR_WEIGHTS, co: PAIR_CO_TARGET_WEIGHT });

type Edit = { manifest?: (manifest: Record<string, unknown>) => void; tableText?: (text: string) => string };

function checkout(ruling: "approved" | "missing" | "changed", edit: Edit = {}, table: PairingTable = withCo): string {
  const root = mkdtempSync(path.join(tmpdir(), "w1c-gate-"));
  fixtures.push(root);
  mkdirSync(path.join(root, PAIRING_DIR), { recursive: true });
  const text = pairingText(table);
  writeFileSync(path.join(root, PAIRING_DIR, TABLE_FILE), edit.tableText ? edit.tableText(text) : text);
  const manifest = JSON.parse(readFileSync(path.join(PAIRING_DIR, PAIRING_MANIFEST_FILE), "utf8"));
  manifest.table = { ...manifest.table, sha256: createHash("sha256").update(text).digest("hex"), rows: table.rows.length,
    rowsHash: rowsCuratedHash(table.rows), absent: table.absent };
  // The co fixture is a hypothetical authorized build: test-only evidence (no real term has any).
  if (table === withCo) manifest.activation = { co: PASSING_EVIDENCE };
  edit.manifest?.(manifest);
  writeFileSync(path.join(root, PAIRING_DIR, PAIRING_MANIFEST_FILE), JSON.stringify(manifest));
  if (ruling !== "missing") {
    mkdirSync(path.dirname(path.join(root, NHANES_RULING_PATH)), { recursive: true });
    copyFileSync(NHANES_RULING_PATH, path.join(root, NHANES_RULING_PATH));
    if (ruling === "changed") writeFileSync(path.join(root, NHANES_RULING_PATH), "# Refused\n\nNHANES may not be used.\n");
  }
  return root;
}

afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("the committed pairing build is under the ruling", () => {
  it("keeps the NHANES co rows server-side under the named ruling, and ships co at weight 0", () => {
    expect(readCoFeatures().size).toBeGreaterThan(1000);
    expect(manifestNamesRuling(committedManifest)).toBe(true);
    expect(committedManifest.nhanes?.weight).toBe(0);
    expect(committedManifest.nhanes?.requires).toMatch(/holdout.*replay/);
    expect(committedTable.rows).toEqual([]);
    expect(committedManifest.withheld.map((item) => item.id)).toEqual(["ahn-2011"]);
    expect(committedManifest.sources.some((source) => /ahn|flavor/i.test(`${source.id} ${source.name}`))).toBe(false);
  });

  it("the committed files pass the loader's identity checks", () => {
    expect(loadPairing(process.cwd())).toEqual({ table: committedTable });
  });
});

describe("the runtime gate", () => {
  it("keeps co with the ruling present and named", () => {
    const table = loadPairingTable(checkout("approved"))!;
    expect(table.rows).toEqual(withCo.rows);
    expect(table.rows.some((row) => row.co !== undefined)).toBe(true);
  });

  it.each(["missing", "changed"] as const)("drops every co when the ruling is %s: each pair scores its curated B", (ruling) => {
    const table = loadPairingTable(checkout(ruling))!;
    expect(table.absent).toContain("co");
    expect(table.rows).toEqual([]);
  });

  it("drops co when the manifest does not name the ruling", () => {
    expect(loadPairingTable(checkout("approved", { manifest: (manifest) => { manifest.ruling = null; } }))!.rows).toEqual([]);
    expect(gatedPairingTable(withCo, null).rows).toEqual([]);
  });
});

describe("the loader's identity checks (round 2)", () => {
  it("refuses an edited, schema-valid table whose bytes no longer match the manifest", () => {
    const dropRow = (text: string) => text.replace(/\n\{"anchor"[^\n]*\},(?=\n)/, "");
    const root = checkout("approved", { tableText: dropRow });
    const edited = parsePairingTable(JSON.parse(readFileSync(path.join(root, PAIRING_DIR, TABLE_FILE), "utf8")));
    expect(edited?.rows.length).toBe(withCo.rows.length - 1);
    expect(loadPairing(root)).toEqual({ refused: "table_hash" });
    expect(loadPairingTable(root)).toBeNull();
  });

  it("rejects a row whose stored pair is not its formula (the parser, not a recompute)", () => {
    const edited = (text: string) => text.replace(/"pair":0\.\d+/, '"pair":0.99');
    const root = checkout("approved", { tableText: edited });
    expect(parsePairingTable(JSON.parse(readFileSync(path.join(root, PAIRING_DIR, TABLE_FILE), "utf8")))).toBeNull();
    expect(loadPairing(root)).toEqual({ refused: "table_invalid" });
  });

  it("refuses a stale build: a curated hash other than the pin", () => {
    const root = checkout("approved", { manifest: (manifest) => { (manifest.curated as Record<string, unknown>).hash = "0".repeat(64); } });
    expect(loadPairing(root)).toEqual({ refused: "curated_hash" });
  });

  it("refuses rows that do not match the manifest's rows hash", () => {
    const root = checkout("approved", { manifest: (manifest) => { (manifest.table as Record<string, unknown>).rowsHash = "1".repeat(64); } });
    expect(loadPairing(root)).toEqual({ refused: "rows_hash" });
  });

  it("refuses a missing table or an unparseable manifest", () => {
    const root = checkout("approved", { manifest: (manifest) => { manifest.schema = 9; } });
    expect(loadPairing(root)).toEqual({ refused: "manifest_invalid" });
    rmSync(path.join(root, PAIRING_DIR, TABLE_FILE));
    expect(loadPairing(root)).toEqual({ refused: "table_missing" });
  });
});

describe("the build gate", () => {
  it.each(["missing", "changed"] as const)("with the ruling %s, never reads NHANES and bundles no co", (ruling) => {
    const root = checkout(ruling, {}, committedTable);
    const build = buildPairing(root, { workspace: path.join(root, "no-such-workspace") });
    expect(build.co).toBeNull();
    expect(build.texts["co-consumption.json"]).toBeNull();
    expect(build.manifest.ruling).toBeNull();
    expect(build.manifest.nhanes).toBeNull();
    expect(build.manifest.sources).toEqual([]);
    expect(build.table.absent).toEqual(["co", "jev", "comp"]);
    expect(build.table.rows).toEqual([]);
    expect(runPairingChecks({ co: build.co, table: build.table, manifest: build.manifest })).toEqual([]);
  });
});
