import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const COACH = path.join(ROOT, "lib/coach");
const FORBIDDEN = ["lib/server/", "lib/foods/facets", "lib/coach/suggest-policy"];

function moduleSpecifiers(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly
        && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specs;
}

function resolveImport(file: string, spec: string): string | null {
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return null;
  const base = spec.startsWith("@/") ? spec.slice(2) : path.join(path.dirname(file), spec);
  return [".ts", ".tsx", "/index.ts", "/index.tsx"]
    .map((extension) => `${base}${extension}`)
    .find((candidate) => existsSync(path.join(ROOT, candidate))) ?? null;
}

function graphFrom(entry: string): { seen: Set<string>; offenders: string[] } {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const spec of moduleSpecifiers(file, source)) {
      const base = spec.startsWith("@/") ? spec.slice(2) : path.join(path.dirname(file), spec);
      if (FORBIDDEN.some((prefix) => base === prefix || base.startsWith(prefix))) {
        offenders.push(`${file} -> ${base}`);
      }
      const resolved = resolveImport(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return { seen, offenders };
}

function clientModules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return clientModules(absolute);
    if (!/\.tsx?$/.test(entry.name)) return [];
    const source = readFileSync(absolute, "utf8");
    return /^"use client";/m.test(source) ? [path.relative(ROOT, absolute)] : [];
  });
}

describe("coach client import boundaries", () => {
  // This walks every "use client" module under lib/coach and recursively parses+resolves its whole
  // import graph from disk (clientModules + graphFrom). That's real, CPU/IO-bound work, not a hang —
  // under the full suite's default parallelism (many worker processes doing synchronous fs + TS
  // parsing at once) it can exceed Vitest's 5s default, so it gets a longer budget here.
  it("keeps every use-client coach module out of server recipe evidence", () => {
    const entries = clientModules(COACH);
    const offenders = entries.flatMap((entry) => graphFrom(entry).offenders);
    expect(entries).toContain("lib/coach/apply-entries.ts");
    expect(graphFrom("lib/coach/apply-client.ts").seen.size).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  }, 20_000);
});
