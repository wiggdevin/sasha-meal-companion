/**
 * Grok pass 2, HIGH 3: nothing the browser loads may reach a `node:` builtin.
 *
 * Next would either fail the build or ship a polyfill for it, and neither is a thing to discover
 * in production. The graph is walked from the modules the client actually imports, following
 * every relative and `@/` import, and stopping at `lib/server/` — that boundary is server-only by
 * construction and has its own guard inside each file.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)["'](@\/[^"']+|\.[^"']+)["']/g;

/** Every module reachable from `entry`, as repo-relative paths without extensions resolved. */
function graphFrom(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const source = readFileSync(path.join(ROOT, file), "utf8");
    seen.set(file, source);
    for (const [, spec] of source.matchAll(IMPORT_RE)) {
      const base = spec.startsWith("@/")
        ? spec.slice(2)
        : path.join(path.dirname(file), spec);
      // The server boundary is not part of the client graph: each file in it throws on `window`.
      if (base.startsWith("lib/server/")) continue;
      const resolved = [".ts", ".tsx", "/index.ts"]
        .map((ext) => `${base}${ext}`)
        .find((candidate) => existsSync(path.join(ROOT, candidate)));
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/** The client modules T0 touched, each the root of its own browser-side graph. */
const CLIENT_ENTRIES = [
  "lib/log-commit-client.ts",
  "lib/log-client.ts",
  "lib/capture-client.ts",
  "lib/barcode/client.ts",
  "lib/coach-client.ts",
  "lib/catalog-client.ts",
  "lib/timing.ts",
  "lib/warm-client.ts",
  "lib/fetch-with-deadline.ts",
];

describe("the client import graph", () => {
  it.each(CLIENT_ENTRIES)("%s reaches no node: builtin", (entry) => {
    const offenders: string[] = [];
    for (const [file, source] of graphFrom(entry)) {
      if (/["']node:[a-z_/]+["']/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("walks far enough to be worth trusting", () => {
    expect(graphFrom("lib/log-commit-client.ts").size).toBeGreaterThan(5);
  });
});
