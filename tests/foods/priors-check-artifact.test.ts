/**
 * Phase 18 W1b, acceptance 5 and 7 (docs/specs/phase-18-open-world-foods.md D10): the named checks
 * of scripts/priors/check-artifact.ts pass on the committed artifacts, and each one catches its
 * own fault: H1 a respondent row, H3 a small cell, H4 a non-aggregate field or an unnamed ruling,
 * H5 a race or ethnicity axis, and the licence check an excluded or non-commercial source.
 */
import { describe, expect, it } from "vitest";
import { ARTIFACT_DIR } from "@/lib/foods/universe/prior";
import {
  checkAggregateSchema, checkLicences, checkMinEffectiveN, checkNoRespondentRows, checkNoSensitiveAxes, readArtifacts,
  runChecks, type Artifacts,
} from "@/scripts/priors/check-artifact";
import { EXCLUDED_SOURCES, licenceFindings, SOURCES } from "@/scripts/priors/sources";

const committed = readArtifacts(ARTIFACT_DIR);
const clone = (): Artifacts => JSON.parse(JSON.stringify(committed));
const rows = (a: Artifacts) => a.prior as Record<string, unknown>[];

describe("the committed W1b artifacts", () => {
  it("pass every named check", () => {
    expect(committed.prior).not.toBeNull();
    expect(committed.manifest).not.toBeNull();
    expect(runChecks(committed)).toEqual([]);
  });
});

describe("H1 --no-respondent-rows (strict allowlist schemas)", () => {
  it("fails respondent records smuggled under an innocent key (the round-1 probe)", () => {
    const a = clone();
    (a.graph as Record<string, unknown>).respondents = [{ id: 12345, age: 45, foods: ["banana"] }];
    expect(checkNoRespondentRows(a).join()).toMatch(/graph/);
  });
  it("fails an unknown key at any depth of any artifact", () => {
    const deep = clone();
    (deep.manifest as { nhanes: { mapping: Record<string, unknown> } }).nhanes.mapping.extra = [{ a: 1 }];
    expect(checkNoRespondentRows(deep).join()).toMatch(/manifest\.nhanes\.mapping/);
    const edge = clone();
    ((edge.graph as { edges: Record<string, unknown>[] }).edges[0]).people = 3;
    expect(checkNoRespondentRows(edge).length).toBeGreaterThan(0);
    const row = clone();
    rows(row)[0].notes = "x";
    expect(checkNoRespondentRows(row).length).toBeGreaterThan(0);
  });

  it("fails a row keyed by a respondent", () => {
    const a = clone();
    rows(a).push({ cohort: "93703", food_key: "banana", rate: 0.5, n_eff: 40 });
    expect(checkNoRespondentRows(a).length).toBeGreaterThan(0);
  });
  it("fails a respondent id field or a survey field name anywhere", () => {
    const a = clone();
    rows(a)[0].SEQN = 93703;
    expect(checkNoRespondentRows(a).join()).toMatch(/SEQN/);
    const b = clone();
    (b.manifest as Record<string, unknown>).note = "joined on DR1IFDCD";
    expect(checkNoRespondentRows(b).join()).toMatch(/DR1IFDCD/);
  });
});

describe("H3 --min-effective-n 30", () => {
  it("fails a shipped cell under 30 effective respondents", () => {
    const a = clone();
    rows(a)[0].n_eff = 29;
    expect(checkMinEffectiveN(a, 30)).toHaveLength(1);
  });
});

describe("H4 --aggregate-schema", () => {
  it("fails an extra field, a non-rate or a manifest that does not name the ruling", () => {
    const a = clone();
    rows(a)[0].grams = 12;
    expect(checkAggregateSchema(a).length).toBeGreaterThan(0);
    const b = clone();
    rows(b)[0].rate = 1.2;
    expect(checkAggregateSchema(b).length).toBeGreaterThan(0);
    const c = clone();
    (c.manifest as { ruling: unknown }).ruling = null;
    expect(checkAggregateSchema(c).join()).toMatch(/approved hash/);
    const d = clone();
    (d.manifest as { ruling: { sha256: string } }).ruling.sha256 = "0".repeat(64);
    expect(checkAggregateSchema(d).join()).toMatch(/approved hash/);
  });
  it("fails NHANES-derived metrics in a manifest without the ruling, even with no table", () => {
    const a = clone();
    a.prior = null;
    (a.manifest as { prior: unknown; ruling: unknown }).prior = null;
    (a.manifest as { ruling: unknown }).ruling = null;
    expect(checkAggregateSchema(a).join()).toMatch(/NHANES-derived output/);
  });
  it("fails a source without checksums", () => {
    const a = clone();
    (a.manifest as { sources: { files: unknown[] }[] }).sources[0].files = [{ path: "x.xpt" }];
    expect(checkAggregateSchema(a).join()).toMatch(/sha256/);
  });
});

describe("H5 --no-sensitive-axes", () => {
  it("fails a race-keyed cohort, a survey race field or an ethnicity key", () => {
    const a = clone();
    rows(a)[0].cohort = "non-hispanic_black";
    expect(checkNoSensitiveAxes(a).length).toBeGreaterThan(0);
    const b = clone();
    (b.manifest as Record<string, unknown>).axes = ["RIDRETH3"];
    expect(checkNoSensitiveAxes(b).length).toBeGreaterThan(0);
    const c = clone();
    (c.graph as Record<string, unknown>).ethnicity = {};
    expect(checkNoSensitiveAxes(c).length).toBeGreaterThan(0);
  });
});

describe("acceptance 5: the licence allowlist", () => {
  const source = (licence: string) => ({ id: "x", name: "Some data", url: "https://example.org/data.zip", licence });
  it("passes the build's own sources with the ruling, and refuses NHANES without it", () => {
    expect(licenceFindings(SOURCES, true)).toEqual([]);
    expect(licenceFindings(SOURCES, false).map((finding) => finding.source)).toEqual(["nhanes-2017-2020", "nhanes-2021-2023"]);
  });
  it.each(EXCLUDED_SOURCES.map((excluded) => excluded.name))("fails an input from %s", (name) => {
    const bad = { ...source("cc0-1.0"), name: `${name} export` };
    expect(licenceFindings([bad], true).map((finding) => finding.problem).join()).toMatch(/excluded source/);
  });
  it.each(["No commercial use", "CC BY-NC-SA 3.0", "CC0 1.0", "cc-by-sa-4.0", "Apache-2.0", "", "free for research"])(
    "fails any licence outside the allowlist: %j", (licence) => {
      expect(licenceFindings([source(licence)], true)).toHaveLength(1);
    });
  it.each(["public-domain", "cc0-1.0", "cc-by-4.0"])("passes %s", (licence) => {
    expect(licenceFindings([source(licence)], false)).toEqual([]);
  });
  it("fails a graph term with no source, an unlisted source, NHANES data or a mismatched licence (W4)", () => {
    type Terms = Record<string, { sources: string[]; licences: string[] } | undefined>;
    const terms = (a: Artifacts) => (a.manifest as { graph: { terms: Terms } }).graph.terms;
    const none = clone();
    delete terms(none).ctx;
    expect(checkLicences(none).join()).toMatch(/graph term ctx names no source/);
    const unlisted = clone();
    terms(unlisted).ctx = { sources: ["ahn-2011"], licences: ["cc-by-4.0"] };
    expect(checkLicences(unlisted).join()).toMatch(/unlisted source/);
    const nhanes = clone();
    terms(nhanes).ctx = { sources: ["nhanes-2021-2023"], licences: ["nchs-dua"] };
    expect(checkLicences(nhanes).join()).toMatch(/uses NHANES data/);
    const relabelled = clone();
    terms(relabelled).ctx = { sources: ["fndds-2021-2023"], licences: ["public-domain"] };
    expect(checkLicences(relabelled).join()).toMatch(/differ from its sources'/);
    const absent = clone();
    terms(absent).comp = { sources: ["fndds-2021-2023"], licences: ["cc0-1.0"] };
    expect(checkLicences(absent).join()).toMatch(/graph term comp is absent/);
  });
  it("fails the manifest when a source is swapped for an excluded one", () => {
    const a = clone();
    (a.manifest as { sources: { name: string }[] }).sources[0].name = "FooDB compounds";
    expect(checkLicences(a).join()).toMatch(/FooDB/);
  });
});
