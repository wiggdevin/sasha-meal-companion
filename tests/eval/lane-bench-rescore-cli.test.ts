/**
 * GPT-6 Sol review round 1, spec finding: lane-bench.ts's own documented `--rescore`
 * reproduction command (scripts/eval/lane-bench.ts:25-26, echoed at
 * docs/evals/2026-09-23-lane-bench.md:20) omits `--conditions=react-server`, which the SAME
 * file's header says is required for the adapters' `server-only` marker to resolve. Running the
 * printed command verbatim crashes before doing any work — `Error: This module cannot be
 * imported from a Client Component module` at lib/ai/deepseek.ts:1, because the whole module's
 * imports (including the deepseek adapter) are evaluated eagerly, even though the `--rescore`
 * path itself makes no model call.
 *
 * No test exercised the `--rescore` CLI path before this (only score.ts's pure functions were
 * unit-tested), so the broken command went uncaught. This test extracts the documented command
 * from lane-bench.ts's own module doc — a single source of truth — and actually runs it against
 * a disposable copy of a saved run, so drift in the doc (the flag going missing again) fails here
 * instead of at a maintainer's terminal.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Pulls the `--rescore` reproduction command out of lane-bench.ts's own doc comment, as tokens
 *  (minus the path argument, which the caller substitutes with a disposable copy). */
function documentedRescoreTokens(): string[] {
  const src = readFileSync(path.join(REPO_ROOT, "scripts/eval/lane-bench.ts"), "utf8");
  const match = src.match(
    /\*\s+(pnpm exec tsx.*--rescore.*)\\\s*\n\s*\*\s+\[--rescored-at ([^\]]+)\]/,
  );
  if (!match) throw new Error("lane-bench.ts's --rescore doc command has changed shape");
  const [, commandLine, rescoredAt] = match;
  const tokens = commandLine.trim().split(/\s+/);
  expect(tokens[0]).toBe("pnpm");
  expect(tokens[1]).toBe("exec");
  expect(tokens[2]).toBe("tsx");
  return [...tokens.slice(3), "--rescored-at", rescoredAt];
}

describe("the documented --rescore command", () => {
  it("names --conditions=react-server, the flag its own header says server-only needs", () => {
    const tokens = documentedRescoreTokens();
    expect(tokens).toContain("--conditions=react-server");
  });

  it("is also printed correctly in the committed report (docs/evals/2026-09-23-lane-bench.md)", () => {
    const md = readFileSync(path.join(REPO_ROOT, "docs/evals/2026-09-23-lane-bench.md"), "utf8");
    const commandText = md.match(/`pnpm exec tsx[^`]*--rescore[^`]*`/)?.[0];
    expect(commandText).toBeTruthy();
    expect(commandText).toContain("--conditions=react-server");
  });

  it("runs to completion exactly as printed, against a disposable copy of a saved run", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "lane-bench-rescore-"));
    const savedRunPath = path.join(tmpDir, "run.json");
    const original = readFileSync(
      path.join(REPO_ROOT, "docs/evals/2026-09-23-lane-bench.json"), "utf8",
    );
    writeFileSync(savedRunPath, original);

    const tokens = documentedRescoreTokens();
    const jsonArgIndex = tokens.findIndex((t) => t.endsWith(".json"));
    tokens[jsonArgIndex] = savedRunPath;

    const out = execFileSync("npx", ["tsx", ...tokens], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
    expect(out).toContain("# Lane bench — 2026-09-23");
    expect(out).toContain("## Verdicts against the current pins");
  }, 30_000);
});
