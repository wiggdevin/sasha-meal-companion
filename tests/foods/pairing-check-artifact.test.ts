/**
 * Phase 18 W1c, acceptance 7 (docs/specs/phase-18-open-world-foods.md D10): the NHANES
 * co-consumption feature passes W1b's hard-rule checks, run on the pairing artifacts
 * (scripts/pairing/check-pairing.ts): pair rates only, each with n_eff ≥ 30, no respondent rows,
 * no SEQN, no race or ethnicity, licences on the allowlist. Each check catches its own fault.
 */
import { describe, expect, it } from "vitest";
import { buildPairingTable, PAIR_CO_TARGET_WEIGHT, PAIR_WEIGHTS } from "@/lib/foods/pairing/table";
import { readCoFeatures } from "@/scripts/pairing/artifact-io";
import { fixedPairs } from "@/scripts/pairing/pairs";
import { PASSING_EVIDENCE } from "@/tests/helpers/pairing-evidence";
import {
  checkAggregateSchema, checkLicences, checkMinEffectiveN, checkNoRespondentRows, checkNoSensitiveAxes, readPairingArtifacts,
  runPairingChecks, type PairingArtifacts,
} from "@/scripts/pairing/check-pairing";

const committed = readPairingArtifacts();
const clone = (): PairingArtifacts => JSON.parse(JSON.stringify(committed));
/** The committed artifacts with a table at the co target weight and test-only evidence (never shipped), so the row checks have rows. */
const withCoTable = (): PairingArtifacts => {
  const a = clone();
  (a.manifest as Record<string, unknown>).activation = { co: PASSING_EVIDENCE };
  return { ...a, table: JSON.parse(JSON.stringify(buildPairingTable(fixedPairs(),
    { co: readCoFeatures(), jev: null, comp: null }, { ...PAIR_WEIGHTS, co: PAIR_CO_TARGET_WEIGHT }))) };
};
const co = (a: PairingArtifacts) => a.co as Record<string, unknown>[];
const rows = (a: PairingArtifacts) => (a.table as { rows: Record<string, unknown>[] }).rows;
const manifest = (a: PairingArtifacts) => a.manifest as Record<string, unknown>;

describe("the committed W1c artifacts", () => {
  it("pass every named check, with pair rates only", () => {
    expect(co(committed).length).toBeGreaterThan(100);
    expect(runPairingChecks(committed)).toEqual([]);
    for (const row of co(committed)) expect(Object.keys(row).sort()).toEqual(["anchor", "base_rate", "n_eff", "rate", "side", "template"]);
  });
});

describe("H1 --no-respondent-rows", () => {
  it("fails respondent records under an innocent key, and an unknown key at any depth", () => {
    const a = clone();
    (a.table as Record<string, unknown>).respondents = [{ id: 93703, foods: ["rice"] }];
    expect(checkNoRespondentRows(a).join()).toMatch(/table/);
    const b = clone();
    co(b)[0].occasion_time = 43200;
    expect(checkNoRespondentRows(b).length).toBeGreaterThan(0);
    const c = clone();
    (manifest(c).nhanes as Record<string, unknown>).extra = { a: 1 };
    expect(checkNoRespondentRows(c).join()).toMatch(/manifest\.nhanes/);
  });

  it("fails a survey id or survey field named anywhere", () => {
    const a = clone();
    co(a)[0].anchor = "SEQN";
    expect(checkNoRespondentRows(a).join()).toMatch(/SEQN/);
    const b = clone();
    (manifest(b).nhanes as Record<string, unknown>).occasions = "grouped by DR1_030Z";
    expect(checkNoRespondentRows(b).join()).toMatch(/DR1_030Z/);
  });
});

describe("H3 --min-effective-n 30", () => {
  it("fails a pair rate under 30 effective respondents", () => {
    const a = clone();
    co(a)[0].n_eff = 29;
    expect(checkMinEffectiveN(a)).toHaveLength(1);
    expect(checkAggregateSchema(a).length).toBeGreaterThan(0);
  });
});

describe("H4 --aggregate-schema", () => {
  it("fails NHANES-derived output without the ruling named at its approved hash", () => {
    const a = clone();
    manifest(a).ruling = null;
    expect(checkAggregateSchema(a).join()).toMatch(/approved hash/);
    const b = clone();
    (manifest(b).ruling as Record<string, unknown>).sha256 = "0".repeat(64);
    expect(checkAggregateSchema(b).join()).toMatch(/approved hash/);
  });

  it("fails a table co with no shipped co row, and a pair off the formula", () => {
    expect(runPairingChecks(withCoTable())).toEqual([]);
    const a = withCoTable();
    a.co = co(a).slice(1);
    expect(checkAggregateSchema(a).join()).toMatch(/no matching co-consumption row/);
    const b = withCoTable();
    rows(b)[0].pair = 1;
    expect(checkAggregateSchema(b).join()).toMatch(/formula/);
  });

  it("fails a row that is not a pair rate", () => {
    const a = clone();
    co(a)[0].grams = 120;
    expect(checkAggregateSchema(a).length).toBeGreaterThan(0);
  });
});

describe("H5 --no-sensitive-axes", () => {
  it("fails a race or ethnicity key, value or cohort", () => {
    const a = clone();
    co(a)[0].race = "x";
    expect(checkNoSensitiveAxes(a).length).toBeGreaterThan(0);
    const b = clone();
    (manifest(b).nhanes as Record<string, unknown>).population = "Non-Hispanic adults";
    expect(checkNoSensitiveAxes(b).length).toBeGreaterThan(0);
    const c = clone();
    co(c)[0].anchor = "RIDRETH3";
    expect(checkNoSensitiveAxes(c).length).toBeGreaterThan(0);
  });
});

describe("--licences", () => {
  it("fails an excluded or non-commercial source", () => {
    const a = clone();
    (manifest(a).sources as Record<string, unknown>[]).push({ id: "flavordb", name: "FlavorDB", url: "https://x.test", licence: "cc-by-4.0" });
    expect(checkLicences(a).join()).toMatch(/FlavorDB/);
    const b = clone();
    (manifest(b).sources as Record<string, unknown>[]).push({ id: "ahn-2011", name: "Ahn flavor network", url: "https://x.test",
      licence: "cc-by-nc-sa-3.0" });
    expect(checkLicences(b).join()).toMatch(/not cleared/);
  });
});
