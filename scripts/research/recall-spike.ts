/**
 * W159 spike: pull recent openFDA food enforcement records (free, no key) into
 * tests/fixtures/recalls/snapshot.json and report how many carry a usable UPC.
 *
 *   pnpm exec tsx scripts/research/recall-spike.ts [--limit 20]
 *
 * Read-only against a public API; writes only the snapshot file. Not part of CI.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { indexRecall, type RecallRecord } from "@/lib/shopping/recall-match";

const URL_BASE = "https://api.fda.gov/food/enforcement.json";
const OUT = resolve(process.cwd(), "tests/fixtures/recalls/snapshot.json");

async function main(): Promise<void> {
  const i = process.argv.indexOf("--limit");
  const limit = i > -1 ? Number(process.argv[i + 1]) : 20;
  const res = await fetch(`${URL_BASE}?limit=${limit}&sort=report_date:desc`);
  if (!res.ok) throw new Error(`openFDA answered HTTP ${res.status}`);
  const body = (await res.json()) as { results?: RecallRecord[] };
  const results = body.results ?? [];
  const indexed = results.map(indexRecall);
  const withUpc = indexed.filter((r) => r.gtin14.length > 0).length;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify({ fetchedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`records: ${results.length}`);
  console.log(`with a valid UPC/GTIN: ${withUpc} (${results.length ? Math.round((100 * withUpc) / results.length) : 0}%)`);
  console.log(`wrote ${OUT}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
