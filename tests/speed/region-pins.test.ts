/**
 * Scale S1: every serverless function runs next to the database. The Supabase project is in
 * us-west-1 (N. California), so vercel.json sets `"regions": ["sfo1"]` for the whole deployment, and
 * a route that also pins `preferredRegion` must name the same region. Ten routes once pinned iad1
 * on the belief that the database was in us-east-1, and every query crossed the country.
 *
 * Scanned from source text on purpose: a route that is never imported by a test is still deployed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return /^route\.(ts|tsx|js)$/.test(entry.name) ? [path] : [];
  });
}

const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { regions?: unknown };
const pins = routeFiles(join(ROOT, "app")).flatMap((file) => {
  const text = readFileSync(file, "utf8");
  if (!/\bpreferredRegion\b/.test(text)) return [];
  const literal = /export\s+const\s+preferredRegion\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/.exec(text)?.[1];
  return [{ route: relative(ROOT, file), literal }];
});

describe("function regions", () => {
  it("vercel.json runs every function in sfo1, beside the us-west-1 database", () => {
    expect(vercel.regions).toEqual(["sfo1"]);
  });

  it("finds the pinned routes, so the next case cannot pass by matching nothing", () => {
    expect(pins.length).toBeGreaterThanOrEqual(10);
  });

  it.each(pins.map((p) => [p.route, p.literal] as const))(
    "%s pins the vercel.json region and no other", (_route, literal) => {
      expect(literal, "preferredRegion must be a string-array literal").toMatch(/^\[/);
      const regions = JSON.parse((literal ?? "").replace(/'/g, "\"").replace(/,\s*\]/, "]")) as unknown;
      expect(regions).toEqual(vercel.regions);
    });
});
