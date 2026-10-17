/**
 * W045: the population prior is read once per checkout. A second load with the same files does no
 * file read; an edit, replacement or removal of the ruling, the manifest or the table is seen at
 * once, so the NCHS gate still shuts the moment its ruling changes.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_DIR, GRAPH_FILE, MANIFEST_FILE, NHANES_RULING_PATH, PRIOR_FILE } from "@/lib/foods/universe/prior";

const reads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const readFileSync = ((file: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    reads.paths.push(String(file));
    return (actual.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const { loadAccountPrior, loadPopulationPrior } = await import("@/lib/foods/universe/artifacts");

const fixtures: string[] = [];

function checkout(): string {
  const root = mkdtempSync(path.join(tmpdir(), "w045-prior-"));
  fixtures.push(root);
  mkdirSync(path.join(root, ARTIFACT_DIR), { recursive: true });
  for (const file of [PRIOR_FILE, GRAPH_FILE, MANIFEST_FILE]) {
    copyFileSync(path.join(ARTIFACT_DIR, file), path.join(root, ARTIFACT_DIR, file));
  }
  mkdirSync(path.dirname(path.join(root, NHANES_RULING_PATH)), { recursive: true });
  copyFileSync(NHANES_RULING_PATH, path.join(root, NHANES_RULING_PATH));
  return root;
}

const readsUnder = (root: string) => reads.paths.filter((p) => p.startsWith(root)).length;

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
  reads.paths.length = 0;
});

describe("the memoized population prior", () => {
  it("reads the files once: a second load and an account load do no file read", () => {
    const root = checkout();
    const first = loadPopulationPrior(root);
    expect(first.status).toBe("loaded");
    const after = readsUnder(root);
    expect(after).toBeGreaterThan(0);
    expect(loadPopulationPrior(root)).toBe(first);
    expect(loadAccountPrior({ countryCode: "US", sex: "female", birthYear: 1990 }, "2026-10-17", root).prior)
      .toBe(first);
    expect(readsUnder(root)).toBe(after);
  });

  it("shuts the gate at once when the ruling is replaced or removed after a load", () => {
    const root = checkout();
    expect(loadPopulationPrior(root).status).toBe("loaded");
    writeFileSync(path.join(root, NHANES_RULING_PATH), `${readFileSync(NHANES_RULING_PATH, "utf8")}\nRefused.\n`);
    expect(loadPopulationPrior(root)).toEqual({ status: "neutral", reason: "ruling_changed" });
    rmSync(path.join(root, NHANES_RULING_PATH));
    expect(loadPopulationPrior(root)).toEqual({ status: "neutral", reason: "ruling_missing" });
  });

  it("re-reads when the table changes after a load", () => {
    const root = checkout();
    expect(loadPopulationPrior(root).status).toBe("loaded");
    writeFileSync(path.join(root, ARTIFACT_DIR, PRIOR_FILE), "[]");
    expect(loadPopulationPrior(root)).toEqual({ status: "neutral", reason: "artifact_invalid" });
  });
});
