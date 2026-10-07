/**
 * Phase 18 W5, acceptance 4 (docs/specs/phase-18-open-world-foods.md D2, D8, D10): an account with
 * no `country_code`, or a country other than `US`, gets a neutral prior (every P_f = 0); an account
 * with `US` gets the U.S. prior, and only while the NCHS gate is open. The cohort comes from the
 * stored sex and the birth year on the suggestion date; W1b ships the national adult root only, so
 * every U.S. adult reads `national` today. Nothing else about the account is read.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAccountPrior, loadPopulationPrior } from "@/lib/foods/universe/artifacts";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import {
  accountPrior, ageOn, ARTIFACT_DIR, GRAPH_FILE, MANIFEST_FILE, NATIONAL_COHORT, NHANES_RULING_PATH, PRIOR_FILE,
  priorScores, type PopulationPrior,
} from "@/lib/foods/universe/prior";

const parts = Object.fromEntries(UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null)
  .map((item) => [item.entry.id, item.parts]));
const DATE = "2026-10-06";
const fixtures: string[] = [];

function checkout(withRuling: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), "w5-prior-"));
  fixtures.push(root);
  mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
  for (const file of [PRIOR_FILE, GRAPH_FILE, MANIFEST_FILE]) {
    copyFileSync(path.join(ARTIFACT_DIR, file), path.join(root, ARTIFACT_DIR, file));
  }
  if (withRuling) {
    mkdirSync(path.dirname(path.join(root, NHANES_RULING_PATH)), { recursive: true });
    copyFileSync(NHANES_RULING_PATH, path.join(root, NHANES_RULING_PATH));
  }
  return root;
}

const allZero = (prior: PopulationPrior, cohort: string) =>
  Object.values(priorScores(prior, cohort, parts)).every((value) => value === 0);

afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("accountPrior (D2): only an account that chose the U.S. gets the U.S. prior", () => {
  const loaded = loadPopulationPrior(checkout(true));

  it("the bundled table is loaded under the ruling (the precondition of the cases below)", () => {
    expect(loaded.status).toBe("loaded");
    expect(allZero(loaded, NATIONAL_COHORT)).toBe(false);
  });

  it("is neutral with no country_code, whatever the sex and birth year", () => {
    for (const countryCode of [undefined, null]) {
      const { prior, cohort } = accountPrior(loaded, { countryCode, sex: "female", birthYear: 1990 }, DATE);
      expect(prior).toEqual({ status: "neutral", reason: "country_unset" });
      expect(cohort).toBe(NATIONAL_COHORT);
      expect(allZero(prior, cohort)).toBe(true);
    }
  });

  it("is neutral for every country other than US, including near-misses", () => {
    for (const countryCode of ["CA", "GB", "MX", "us", "USA", " US", "UM"]) {
      const { prior } = accountPrior(loaded, { countryCode, sex: "male", birthYear: 1980 }, DATE);
      expect(prior).toEqual({ status: "neutral", reason: "country_not_us" });
      expect(allZero(prior, NATIONAL_COHORT)).toBe(true);
    }
  });

  it("gives a US account the loaded U.S. prior with real P_f values", () => {
    const { prior, cohort } = accountPrior(loaded, { countryCode: "US", sex: "female", birthYear: 1990 }, DATE);
    expect(prior).toBe(loaded);
    // W1b ships the national adult root only; a sex-by-age cohort appears only once the build enables it.
    expect(cohort).toBe(NATIONAL_COHORT);
    expect(allZero(prior, cohort)).toBe(false);
  });

  it("reads the cohort from sex and the birth year on the date when the table has that cohort", () => {
    const national = new Map([["a", 0.2]]);
    const table: PopulationPrior = { status: "loaded",
      byCohort: new Map([["national", national], ["female_30_39", new Map([["a", 0.4]])]]) };
    expect(accountPrior(table, { countryCode: "US", sex: "female", birthYear: 1990 }, DATE).cohort).toBe("female_30_39");
    // 2026 − 1997 = 29: the 18–29 band, which this table lacks → national.
    expect(accountPrior(table, { countryCode: "US", sex: "female", birthYear: 1997 }, DATE).cohort).toBe("national");
    expect(accountPrior(table, { countryCode: "US", sex: null, birthYear: 1990 }, DATE).cohort).toBe("national");
    expect(accountPrior(table, { countryCode: "US", sex: "female", birthYear: null }, DATE).cohort).toBe("national");
    // Under 18 reads the adult national root.
    expect(accountPrior(table, { countryCode: "US", sex: "female", birthYear: 2012 }, DATE).cohort).toBe("national");
  });

  it("keeps a shut NCHS gate neutral for a US account", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = checkout(true);
    writeFileSync(path.join(root, NHANES_RULING_PATH), `${readFileSync(NHANES_RULING_PATH, "utf8")}\nRefused.\n`);
    const { prior, cohort } = loadAccountPrior({ countryCode: "US", sex: "male", birthYear: 1985 }, DATE, root);
    expect(prior).toEqual({ status: "neutral", reason: "ruling_changed" });
    expect(allZero(prior, cohort)).toBe(true);
    const missing = checkout(false);
    expect(loadAccountPrior({ countryCode: "US" }, DATE, missing).prior)
      .toEqual({ status: "neutral", reason: "ruling_missing" });
    warn.mockRestore();
  });

  it("loadAccountPrior: US under an open gate is loaded; other countries never read the table", () => {
    const root = checkout(true);
    expect(loadAccountPrior({ countryCode: "US", sex: "female", birthYear: 1990 }, DATE, root).prior.status).toBe("loaded");
    // A root with no artifacts at all: a non-US account still answers neutral for its country, not a load fault.
    const empty = mkdtempSync(path.join(tmpdir(), "w5-prior-empty-"));
    fixtures.push(empty);
    expect(loadAccountPrior({ countryCode: "FR" }, DATE, empty).prior)
      .toEqual({ status: "neutral", reason: "country_not_us" });
    expect(loadAccountPrior({ countryCode: null }, DATE, empty).prior)
      .toEqual({ status: "neutral", reason: "country_unset" });
  });
});

describe("ageOn", () => {
  it("is the year difference on the date, or null", () => {
    expect(ageOn(1990, DATE)).toBe(36);
    expect(ageOn(null, DATE)).toBeNull();
    expect(ageOn(1990.5, DATE)).toBeNull();
    expect(ageOn(1990, "06/10/2026")).toBeNull();
    expect(ageOn(2030, DATE)).toBeNull();
  });
});
