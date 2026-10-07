/**
 * Phase 18 W1b, acceptance 6 — the NCHS gate (docs/specs/phase-18-open-world-foods.md D10): the
 * build and the runtime load the NHANES-derived table only while
 * docs/decisions/2026-10-05-nhanes-aggregate-use.md exists at its approved sha256 and the strict
 * manifest names that path and hash. In a fixture checkout with the ruling deleted, or replaced at the
 * same path (a superseding refusal), the prior is neutral, every P_f is 0, and the reason is logged.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPopulationPrior, loadSubstituteGraph, nchsGateOpen } from "@/lib/foods/universe/artifacts";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import {
  ARTIFACT_DIR, GRAPH_FILE, MANIFEST_FILE, NHANES_RULING_PATH, PRIOR_CAP, PRIOR_FILE, priorCohort, priorScores,
} from "@/lib/foods/universe/prior";
import { buildGateOpen, buildGateReason } from "@/scripts/priors/artifact-io";

const parts = Object.fromEntries(UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null)
  .map((item) => [item.entry.id, item.parts]));
const fixtures: string[] = [];

function checkout(withRuling: boolean, manifestEdit?: (manifest: Record<string, unknown>) => void): string {
  const root = mkdtempSync(path.join(tmpdir(), "w1b-gate-"));
  fixtures.push(root);
  mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
  for (const file of [PRIOR_FILE, GRAPH_FILE]) copyFileSync(path.join(ARTIFACT_DIR, file), path.join(root, ARTIFACT_DIR, file));
  const manifest = JSON.parse(readFileSync(path.join(ARTIFACT_DIR, MANIFEST_FILE), "utf8"));
  manifestEdit?.(manifest);
  writeFileSync(path.join(root, ARTIFACT_DIR, MANIFEST_FILE), JSON.stringify(manifest));
  if (withRuling) {
    mkdirSync(path.dirname(path.join(root, NHANES_RULING_PATH)), { recursive: true });
    copyFileSync(NHANES_RULING_PATH, path.join(root, NHANES_RULING_PATH));
  }
  return root;
}

afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("the NCHS gate", () => {
  it("loads the table with the ruling present and named, and gives real P_f values", () => {
    const root = checkout(true);
    expect(nchsGateOpen(root)).toBe(true);
    expect(buildGateOpen(root)).toBe(true);
    const prior = loadPopulationPrior(root);
    expect(prior.status).toBe("loaded");
    expect(priorCohort(prior, "female", 15)).toBe("national");
    const scores = Object.values(priorScores(prior, priorCohort(prior, "female", 34), parts));
    expect(scores.some((value) => value !== 0)).toBe(true);
    expect(Math.max(...scores.map(Math.abs))).toBeLessThanOrEqual(PRIOR_CAP);
  });

  it("is neutral (every P_f = 0) when the ruling file is deleted from the checkout", () => {
    const root = checkout(true);
    rmSync(path.join(root, NHANES_RULING_PATH));
    expect(buildGateReason(root)).toBe("ruling_missing");
    expect(buildGateOpen(root)).toBe(false);
    const prior = loadPopulationPrior(root);
    expect(prior).toEqual({ status: "neutral", reason: "ruling_missing" });
    const scores = priorScores(prior, "national", parts);
    expect(Object.keys(scores)).toHaveLength(Object.keys(parts).length);
    expect(Object.values(scores).every((value) => value === 0)).toBe(true);
  });

  it("is neutral when the ruling is replaced at the same path (a superseding refusal)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = checkout(true);
    writeFileSync(path.join(root, NHANES_RULING_PATH), "# NHANES aggregate use\n\nRefused: do not use NHANES.\n");
    expect(buildGateReason(root)).toBe("ruling_changed");
    expect(buildGateOpen(root)).toBe(false);
    const prior = loadPopulationPrior(root);
    expect(prior).toEqual({ status: "neutral", reason: "ruling_changed" });
    expect(Object.values(priorScores(prior, "national", parts)).every((value) => value === 0)).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/ruling_changed/);
    warn.mockRestore();
  });

  it("is neutral when the manifest records another ruling hash, or names another path", () => {
    const hash = checkout(true, (manifest) => { (manifest.ruling as { sha256: string }).sha256 = "0".repeat(64); });
    expect(nchsGateOpen(hash)).toBe(false);
    expect(loadPopulationPrior(hash)).toEqual({ status: "neutral", reason: "manifest_unnamed" });
    const other = checkout(true, (manifest) => { (manifest.ruling as { path: string }).path = "docs/decisions/other.md"; });
    expect(loadPopulationPrior(other)).toEqual({ status: "neutral", reason: "manifest_invalid" });
  });

  it("is neutral when the manifest carries any unknown key", () => {
    const root = checkout(true, (manifest) => { manifest.respondents = [{ id: 1 }]; });
    expect(loadPopulationPrior(root)).toEqual({ status: "neutral", reason: "manifest_invalid" });
  });

  it("is neutral when the table breaks its schema", () => {
    const root = checkout(true);
    writeFileSync(path.join(root, ARTIFACT_DIR, PRIOR_FILE), JSON.stringify([{ cohort: "national", food_key: "x", rate: 0.2, n_eff: 12 }]));
    expect(loadPopulationPrior(root)).toEqual({ status: "neutral", reason: "artifact_invalid" });
  });

  it("still loads the substitute graph, which is not NHANES-derived", () => {
    expect(loadSubstituteGraph(checkout(false))).not.toBeNull();
  });

  it("gives a food the build could not map P_f = 0 and reads national for a cohort it lacks", () => {
    const prior = loadPopulationPrior(checkout(true));
    const scores = priorScores(prior, "male_70_plus", { ...parts, "not-a-food": ["veg"] });
    expect(scores["not-a-food"]).toBe(0);
    expect(priorCohort(prior, null, null)).toBe("national");
  });
});
