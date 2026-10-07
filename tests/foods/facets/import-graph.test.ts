import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const LOCAL_IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s]+\s+from\s+)?["'](@\/[^"']+)["']/g;

function sourcePath(specifier: string): string | null {
  const stem = resolve(ROOT, specifier.slice(2));
  return [`${stem}.ts`, `${stem}.tsx`, resolve(stem, "index.ts")].find(existsSync) ?? null;
}

function reachableSources(entry: string): string[] {
  const pending = [resolve(ROOT, entry)];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(LOCAL_IMPORT)) {
      const imported = sourcePath(match[1]);
      if (imported) pending.push(imported);
    }
  }
  return [...seen].map((file) => relative(ROOT, file));
}

describe("facet cache read import graph", () => {
  it("never reaches a lib/ai module", () => {
    expect(reachableSources("lib/foods/facets.ts").filter((file) => file.startsWith("lib/ai/")))
      .toEqual([]);
  });

  it.each(["lib/foods/facet-warm.ts", "scripts/warm-facets.ts",
    "scripts/annotate-policy-categories.ts"])("makes %s use the shared catalog mapper", (entry) => {
    expect(reachableSources(entry)).toContain("lib/foods/catalog-ingredients.ts");
  });
});
