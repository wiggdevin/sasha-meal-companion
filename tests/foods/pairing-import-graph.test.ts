/**
 * Phase 18 W1c, acceptance 3 (docs/specs/phase-18-open-world-foods.md D9): Jev pair labels are
 * offline only. No runtime import reaches the label script or the Jev transport from lib/meals/*
 * or from the bundled pairing modules: the graph is walked through every relative and `@/` module
 * reference — `import … from`, `export … from`, side-effect `import "…"`, dynamic `import(…)` and
 * `require(…)` (round 2) — with lib/server/ included, and must not contain scripts/ or
 * lib/ai/{typesafe,call,payloads}.ts. No shipped module imports the offline pairing build.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** `from "x"` (import and export), `import "x"`, `import("x")`, `require("x")`. */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](@\/[^"']+|\.{1,2}\/[^"']+)["']/g;
const FORBIDDEN = /^scripts\/|^lib\/ai\/(typesafe|call|payloads)\.ts$/;

function graphFrom(entry: string, root = "."): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(path.join(root, file), "utf8").matchAll(IMPORT_RE)) {
      const base = spec.startsWith("@/") ? spec.slice(2) : path.join(path.dirname(file), spec);
      const resolved = [".ts", ".tsx", "/index.ts", ""].map((ext) => `${base}${ext}`)
        .find((candidate) => /\.tsx?$/.test(candidate) && existsSync(path.join(root, candidate)));
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? tsFiles(full) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const ENTRIES = [...tsFiles("lib/meals"), "lib/foods/pairing/table.ts", "lib/foods/pairing/gate.ts",
  "lib/foods/pairing/schema.ts", "lib/foods/pairing/artifacts.ts"];

describe("acceptance 3: no runtime path to the Jev labels", () => {
  it("walks a real graph", () => {
    expect(ENTRIES.length).toBeGreaterThan(15);
    expect(graphFrom("lib/meals/plate.ts").size).toBeGreaterThan(20);
  });

  it.each(ENTRIES)("%s reaches neither scripts/ nor the Jev transport", (entry) => {
    expect([...graphFrom(entry)].filter((file) => FORBIDDEN.test(file))).toEqual([]);
  });

  it("the walk does catch the transport where it is imported", () => {
    expect([...graphFrom("lib/coach/suggest.ts")].some((file) => FORBIDDEN.test(file))).toBe(true);
  });

  it.each([
    ["a side-effect import", `import "@/scripts/pairing/jev-labels";`],
    ["a relative side-effect import", `import "../../scripts/pairing/jev-labels";`],
    ["require()", `const x = require("@/scripts/pairing/jev-labels");`],
    ["export … from", `export { run } from "@/scripts/pairing/jev-labels";`],
    ["export * from", `export * from "@/lib/ai/typesafe";`],
    ["a dynamic import", `const x = await import("@/lib/ai/typesafe");`],
    ["a multi-line import", `import {\n  a,\n} from "@/lib/ai/call";`],
  ])("catches %s", (_name, line) => {
    const root = mkdtempSync(path.join(tmpdir(), "w1c-graph-"));
    try {
      for (const file of ["lib/meals/entry.ts", "scripts/pairing/jev-labels.ts", "lib/ai/typesafe.ts", "lib/ai/call.ts"]) {
        mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
        writeFileSync(path.join(root, file), "export const run = 1;\n");
      }
      writeFileSync(path.join(root, "lib/meals/entry.ts"), `${line}\n`);
      expect([...graphFrom("lib/meals/entry.ts", root)].filter((file) => FORBIDDEN.test(file))).not.toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no module under app/, lib/ or components/ imports the offline pairing build", () => {
    const hits = ["app", "lib", "components"].flatMap(tsFiles)
      .filter((file) => /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'][^"']*scripts\/pairing/.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });
});
