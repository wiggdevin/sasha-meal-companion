import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { integrationTestFiles } from "./ci-integration-files";

/**
 * The Integration job's skip gate (W040). The job writes a Vitest JSON report; this reads it and
 * fails when more tests were skipped than the recorded ceiling (scripts/ci-skip-ceiling.json,
 * explained in docs/ci/skipped-tests.md), or when any test in a throwaway-Postgres suite (a file
 * that names PG_BIN) was skipped: those must run in CI, never skip quietly. It prints every
 * skipped test by file, so the CI log is the per-run skip list.
 */

export type ReportTest = { status: string; fullName?: string; title?: string };
export type ReportFile = { name: string; assertionResults: ReportTest[] };
export type Report = { numTotalTests?: number; testResults?: ReportFile[] };

export type SkipVerdict = {
  ok: boolean;
  total: number;
  skipped: number;
  byFile: Map<string, string[]>;
  errors: string[];
};

const RAN = new Set(["passed", "failed"]);

export function checkSkips(report: Report, ceiling: number, pgFiles: ReadonlySet<string>, root: string):
  SkipVerdict {
  const errors: string[] = [];
  const byFile = new Map<string, string[]>();
  const files = Array.isArray(report.testResults) ? report.testResults : [];
  let total = 0;
  for (const file of files) {
    const rel = path.relative(root, file.name);
    for (const test of file.assertionResults ?? []) {
      total += 1;
      if (RAN.has(test.status)) continue;
      const names = byFile.get(rel) ?? [];
      names.push(test.fullName ?? test.title ?? "(unnamed)");
      byFile.set(rel, names);
    }
  }
  const skipped = [...byFile.values()].reduce((sum, names) => sum + names.length, 0);
  // An empty or truncated report must not pass as "nothing skipped".
  if (total === 0) errors.push("the report holds no tests");
  if (report.numTotalTests !== undefined && report.numTotalTests !== total) {
    errors.push(`the report lists ${total} tests but counts ${report.numTotalTests}`);
  }
  if (!Number.isInteger(ceiling) || ceiling < 0) errors.push(`invalid ceiling ${ceiling}`);
  if (skipped > ceiling) errors.push(`${skipped} tests skipped, above the ceiling of ${ceiling}`);
  for (const file of pgFiles) {
    const names = byFile.get(file);
    if (names) errors.push(`${file}: ${names.length} tests skipped in a throwaway-Postgres suite (PG_BIN or the database missing)`);
    else if (!files.some((f) => path.relative(root, f.name) === file)) {
      errors.push(`${file}: not in the report`);
    }
  }
  return { ok: errors.length === 0, total, skipped, byFile, errors };
}

/** Test files that start a throwaway Postgres from PG_BIN. */
export function pgSuites(root: string, files: readonly string[]): Set<string> {
  return new Set(files.filter((file) => /\bPG_BIN\b/.test(readFileSync(path.join(root, file), "utf8"))));
}

export function readCeiling(root: string): number {
  const raw: unknown = JSON.parse(readFileSync(path.join(root, "scripts", "ci-skip-ceiling.json"), "utf8"));
  const ceiling = (raw as { ceiling?: unknown }).ceiling;
  if (typeof ceiling !== "number") throw new Error("scripts/ci-skip-ceiling.json: ceiling is not a number");
  return ceiling;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const reportPath = process.argv[2];
  if (!reportPath || !existsSync(reportPath)) throw new Error(`no Vitest JSON report at ${reportPath ?? "(none)"}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  const verdict = checkSkips(report, readCeiling(root), pgSuites(root, integrationTestFiles(root)), root);
  console.log(`Skipped ${verdict.skipped} of ${verdict.total} tests:`);
  for (const [file, names] of [...verdict.byFile].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${file} (${names.length})`);
    for (const name of names) console.log(`    - ${name}`);
  }
  for (const error of verdict.errors) console.error(`::error::${error}`);
  if (!verdict.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
