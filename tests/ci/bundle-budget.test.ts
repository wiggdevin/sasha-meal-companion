import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkBudget, entryFiles } from "../../scripts/bundle-budget";

/** W079: the Build job's bundle gate reads each route's entry chunks and fails over budget. */
describe("bundle budget", () => {
  it("reads the entry chunks of every segment in a client reference manifest, once each", () => {
    const source = 'globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n'
      + 'globalThis.__RSC_MANIFEST["/foods/page"] = {"entryJSFiles":{"[project]/app/layout":["a.js","b.js"],'
      + '"[project]/app/foods/page":["b.js","c.js"]}};\n';
    expect(entryFiles(source)).toEqual(["a.js", "b.js", "c.js"]);
  });

  it("passes inside the budget and names each route and the total that go over", () => {
    const budget = { firstLoadKb: 100, totalKb: 300 };
    expect(checkBudget([{ route: "/", kb: 90 }], 200, budget).ok).toBe(true);
    const over = checkBudget([{ route: "/a", kb: 50 }, { route: "/b", kb: 120 }], 310, budget);
    expect(over.ok).toBe(false);
    expect(over.routes[0].route).toBe("/b");
    expect(over.errors).toEqual(["/b: 120 KB first load, budget 100 KB", "all client chunks: 310 KB, budget 300 KB"]);
  });

  it("fails when the build left no routes to measure", () => {
    expect(checkBudget([], 0, { firstLoadKb: 1, totalKb: 1 }).ok).toBe(false);
  });

  it("runs both gates in the Build job", () => {
    const ci = readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/^ {8}run: pnpm exec tsx scripts\/bundle-budget\.ts$/m);
    expect(ci).toMatch(/^ {10}node scripts\/page-gate\/gate\.mjs http:\/\/localhost:3000$/m);
  });
});
