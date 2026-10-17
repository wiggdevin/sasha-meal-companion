import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * The Build job's bundle gate (W079). After `next build` it reads, for every app route, the
 * JavaScript a first visit downloads: the root main files from `.next/build-manifest.json` plus
 * every entry chunk the route's client reference manifest lists for its segments. It sizes each
 * file gzipped and fails when a route goes over `scripts/perf-budget.json` (`firstLoadKb`, the
 * heaviest route) or when all client chunks together go over `totalKb`. The CI log prints every
 * route's size, heaviest first.
 *
 * Raising a budget is a deliberate edit to the JSON in the same PR that grows the bundle.
 */

export type Budget = { firstLoadKb: number; totalKb: number };
export type RouteSize = { route: string; kb: number };
export type BudgetVerdict = { ok: boolean; routes: RouteSize[]; totalKb: number; errors: string[] };

/** The `entryJSFiles` of one `page_client-reference-manifest.js`, all segments together. */
export function entryFiles(manifestSource: string): string[] {
  // `globalThis.__RSC_MANIFEST["/route/page"] = {…};` after a one-line guard.
  const at = manifestSource.indexOf("] = ");
  if (at < 0) throw new Error("not a client reference manifest");
  const json = manifestSource.slice(at + 4).trim().replace(/;$/, "");
  const manifest = JSON.parse(json) as { entryJSFiles?: Record<string, string[]> };
  return [...new Set(Object.values(manifest.entryJSFiles ?? {}).flat())];
}

export function checkBudget(routes: RouteSize[], totalKb: number, budget: Budget): BudgetVerdict {
  const errors: string[] = [];
  const sorted = [...routes].sort((a, b) => b.kb - a.kb || a.route.localeCompare(b.route));
  if (sorted.length === 0) errors.push("no app routes found: did next build run?");
  for (const r of sorted)
    if (r.kb > budget.firstLoadKb) errors.push(`${r.route}: ${r.kb} KB first load, budget ${budget.firstLoadKb} KB`);
  if (totalKb > budget.totalKb) errors.push(`all client chunks: ${totalKb} KB, budget ${budget.totalKb} KB`);
  return { ok: errors.length === 0, routes: sorted, totalKb, errors };
}

function walk(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full, name) : d.name === name ? [full] : [];
  });
}

const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

export function measure(nextDir: string): { routes: RouteSize[]; totalKb: number } {
  const gz = new Map<string, number>();
  const size = (file: string): number => {
    let bytes = gz.get(file);
    if (bytes === undefined) {
      bytes = gzipSync(readFileSync(path.join(nextDir, file))).length;
      gz.set(file, bytes);
    }
    return bytes;
  };
  const build = JSON.parse(readFileSync(path.join(nextDir, "build-manifest.json"), "utf8")) as { rootMainFiles?: string[] };
  const root = build.rootMainFiles ?? [];
  const appDir = path.join(nextDir, "server", "app");
  const routes = walk(appDir, "page_client-reference-manifest.js").map((file) => {
    const files = new Set([...root, ...entryFiles(readFileSync(file, "utf8"))]);
    const dir = path.relative(appDir, path.dirname(file)).split(path.sep).join("/");
    return { route: `/${dir}`, kb: kb([...files].reduce((n, f) => n + size(f), 0)) };
  });
  const chunks = path.join(nextDir, "static", "chunks");
  const totalBytes = readdirSync(chunks, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".js"))
    .reduce((n, d) => n + size(path.relative(nextDir, path.join(d.parentPath, d.name))), 0);
  return { routes, totalKb: kb(totalBytes) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const budget = JSON.parse(readFileSync(path.join(repo, "scripts", "perf-budget.json"), "utf8")).bundle as Budget;
  const { routes, totalKb } = measure(path.join(repo, ".next"));
  const verdict = checkBudget(routes, totalKb, budget);
  for (const r of verdict.routes) console.log(`${String(r.kb).padStart(8)} KB  ${r.route}`);
  console.log(`${String(verdict.totalKb).padStart(8)} KB  (all client chunks)`);
  console.log(`budget: ${budget.firstLoadKb} KB per route, ${budget.totalKb} KB in all (gzipped)`);
  if (!verdict.ok) {
    for (const e of verdict.errors) console.error(`over budget: ${e}`);
    process.exit(1);
  }
}
