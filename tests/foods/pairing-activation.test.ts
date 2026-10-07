/**
 * Phase 18 W1c round 3 — the activation invariant (lib/foods/pairing/gate.ts): every non-curated
 * term (co, jev, comp, any future one) has weight 0 and contributes no row unless the manifest
 * carries that term's validation evidence — a passed holdout calibration meeting the §5 numbers AND
 * a W8 replay-lift record. No term has evidence today, so the build refuses any active term and the
 * loader refuses (curated only) any table that carries one, even when every hash matches.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadPairing } from "@/lib/foods/pairing/artifacts";
import { activationViolations, assertActivationAuthorized } from "@/lib/foods/pairing/gate";
import { parsePairingManifest, parsePairingTable, type ActivationEvidence } from "@/lib/foods/pairing/schema";
import {
  buildPairingTable, pairKey, PAIR_CO_TARGET_WEIGHT, PAIR_COMP_TARGET_WEIGHT, PAIR_JEV_TARGET_WEIGHT, PAIR_WEIGHTS, PAIRING_DIR,
  PAIRING_MANIFEST_FILE, rowsCuratedHash, TABLE_FILE, type PairingTable,
} from "@/lib/foods/pairing/table";
import { NHANES_RULING_PATH } from "@/lib/foods/universe/prior";
import { pairingText, readCoFeatures } from "@/scripts/pairing/artifact-io";
import { buildPairing } from "@/scripts/pairing/build";
import { checkActivation, readPairingArtifacts } from "@/scripts/pairing/check-pairing";
import { fixedPairs } from "@/scripts/pairing/pairs";
import { PASSING_EVIDENCE } from "@/tests/helpers/pairing-evidence";

const pairs = fixedPairs();
const co = readCoFeatures();
const committed = readPairingArtifacts();
const committedManifest = parsePairingManifest(committed.manifest)!;
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

const coTable = buildPairingTable(pairs, { co, jev: null, comp: null }, { ...PAIR_WEIGHTS, co: PAIR_CO_TARGET_WEIGHT });
const keyed = (value: number) => new Map(pairs.filter((pair) => pair.b >= 0.3).slice(0, 50)
  .map((pair) => [pairKey(pair.anchor, pair.side, pair.template), value] as const));
const compTable = buildPairingTable(pairs, { co: null, jev: null, comp: keyed(0.9) }, { ...PAIR_WEIGHTS, comp: PAIR_COMP_TARGET_WEIGHT });
const jevTable = buildPairingTable(pairs, { co: null, jev: keyed(0.9), comp: null }, { ...PAIR_WEIGHTS, jev: PAIR_JEV_TARGET_WEIGHT });

/** A checkout whose table and manifest match each other byte for byte (every hash passes). */
function checkout(table: PairingTable, activation: Record<string, ActivationEvidence> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "w1c-activation-"));
  fixtures.push(root);
  mkdirSync(path.join(root, PAIRING_DIR), { recursive: true });
  const text = pairingText(table);
  writeFileSync(path.join(root, PAIRING_DIR, TABLE_FILE), text);
  const manifest = JSON.parse(readFileSync(path.join(PAIRING_DIR, PAIRING_MANIFEST_FILE), "utf8"));
  manifest.table = { ...manifest.table, sha256: createHash("sha256").update(text).digest("hex"), rows: table.rows.length,
    rowsHash: rowsCuratedHash(table.rows), absent: table.absent };
  manifest.activation = activation;
  writeFileSync(path.join(root, PAIRING_DIR, PAIRING_MANIFEST_FILE), JSON.stringify(manifest));
  mkdirSync(path.dirname(path.join(root, NHANES_RULING_PATH)), { recursive: true });
  copyFileSync(NHANES_RULING_PATH, path.join(root, NHANES_RULING_PATH));
  return root;
}

/** A checkout with the ruling absent, so the build reads no NHANES file. */
function buildRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "w1c-activation-build-"));
  fixtures.push(root);
  return root;
}

describe("the committed artifacts", () => {
  it("carry no active term: every non-curated weight is 0, no row, no evidence", () => {
    const table = parsePairingTable(committed.table)!;
    expect(table.weights).toEqual({ co: 0, jev: 0, comp: 0 });
    expect(table.rows).toEqual([]);
    expect(committedManifest.activation).toEqual({});
    expect(activationViolations(table, committedManifest)).toEqual([]);
    expect(checkActivation(committed)).toEqual([]);
  });
});

describe("the build refuses an active term", () => {
  it.each([
    ["co 0.2", { co: PAIR_CO_TARGET_WEIGHT }],
    ["comp 0.05", { comp: PAIR_COMP_TARGET_WEIGHT }],
    ["jev 0.15", { jev: PAIR_JEV_TARGET_WEIGHT }],
  ])("refuses %s", (_name, weights) => {
    expect(() => buildPairing(buildRoot(), { weights: { ...PAIR_WEIGHTS, ...weights } })).toThrow(/activation refused/);
  });

  it("refuses co rows and comp rows before anything is written", () => {
    expect(coTable.rows.length).toBeGreaterThan(1000);
    expect(() => assertActivationAuthorized(coTable, committedManifest)).toThrow(/co: weight 0.2 with rows/);
    expect(() => assertActivationAuthorized(compTable, committedManifest)).toThrow(/comp: weight 0.05 with rows/);
    expect(() => assertActivationAuthorized(jevTable, committedManifest)).toThrow(/jev: weight 0.15 with rows/);
  });
});

describe("the loader refuses an active term even when every hash matches", () => {
  it.each([["co 0.2", coTable], ["a comp row", compTable], ["jev 0.15", jevTable]] as const)("refuses %s", (_name, table) => {
    expect(loadPairing(checkout(table))).toEqual({ refused: "activation_unauthorized" });
  });

  it("refuses a fake passed calibration with no replay record", () => {
    const fake: ActivationEvidence = { ...PASSING_EVIDENCE, replay: null };
    expect(loadPairing(checkout(coTable, { co: fake }))).toEqual({ refused: "activation_unauthorized" });
    expect(activationViolations(coTable, { activation: { co: fake } }).join()).toMatch(/no W8 replay-lift record/);
  });

  it("refuses evidence that misses the §5 numbers, a failed calibration or a flat replay", () => {
    const cases: ActivationEvidence[] = [
      { ...PASSING_EVIDENCE, calibration: { ...PASSING_EVIDENCE.calibration!, brier: 0.2 } },
      { ...PASSING_EVIDENCE, calibration: { ...PASSING_EVIDENCE.calibration!, ece: 0.06 } },
      { ...PASSING_EVIDENCE, calibration: { ...PASSING_EVIDENCE.calibration!, rawBrier: 0.155 } },
      { ...PASSING_EVIDENCE, calibration: { ...PASSING_EVIDENCE.calibration!, holdoutPairs: 399 } },
      { ...PASSING_EVIDENCE, calibration: { ...PASSING_EVIDENCE.calibration!, status: "failed" } },
      { ...PASSING_EVIDENCE, calibration: null },
      { ...PASSING_EVIDENCE, replay: { ...PASSING_EVIDENCE.replay!, ndcg5GainLo: 0 } },
      { ...PASSING_EVIDENCE, replay: { ...PASSING_EVIDENCE.replay!, implausibleRateDelta: 0.01 } },
    ];
    for (const evidence of cases) expect(activationViolations(coTable, { activation: { co: evidence } })).not.toEqual([]);
  });

  it("evidence is per term: co's evidence does not authorize comp or jev", () => {
    expect(loadPairing(checkout(compTable, { co: PASSING_EVIDENCE }))).toEqual({ refused: "activation_unauthorized" });
    expect(loadPairing(checkout(jevTable, { co: PASSING_EVIDENCE }))).toEqual({ refused: "activation_unauthorized" });
  });

  it("loads only with full evidence for the active term", () => {
    expect("table" in loadPairing(checkout(coTable, { co: PASSING_EVIDENCE }))).toBe(true);
  });

  it("holds a future term to the same rule", () => {
    const future = { weights: { ...PAIR_WEIGHTS, ctx: 0.15 }, rows: [] } as unknown as PairingTable;
    expect(activationViolations(future, committedManifest).join()).toMatch(/ctx: weight 0.15/);
  });
});
