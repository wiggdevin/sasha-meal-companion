/**
 * Loads docs/catalog/synonyms.csv into catalog_synonyms (contracts §7), so the table equals the
 * file: every row is upserted on `term`, and every term in the table that the file no longer
 * names is deleted. tests/search/recall.test.ts measures recall against the file, so a table that
 * has drifted from it would make that measurement a lie.
 *
 *   pnpm exec tsx scripts/load-synonyms.ts [--dry-run] [--csv <path>]
 *
 * Env: SUPABASE_URL and the service-role key, read only inside adminClient() (the two variable
 * names are in .env.example; the key's name is deliberately written in lib/server/admin.ts and
 * nowhere else — lib/server/admin.test.ts guards that). For a Supabase branch, export both from
 * the SUPABASE_TEST_* values that `scripts/db-branch.sh env` prints, then run the command above.
 *
 * A single malformed row refuses the whole run, the same as scripts/apply-food-mapping.ts: a
 * half-loaded vocabulary silently changes what search returns.
 */

import { readFileSync } from "node:fs";
import { adminClient } from "@/lib/server/admin";

const DEFAULT_CSV = "docs/catalog/synonyms.csv";
const HEADER = ["term", "expansion", "source"];

type Row = { term: string; expansion: string; source: string };

function parseCsv(text: string): Row[] {
  const lines = text.trim().split("\n").filter((l) => l.trim().length > 0);
  const head = (lines[0] ?? "").split(",").map((h) => h.trim());
  if (head.join(",") !== HEADER.join(",")) {
    throw new Error(`unexpected CSV header.\n  expected: ${HEADER.join(",")}\n  got:      ${head.join(",")}`);
  }
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",");
    if (cells.length !== HEADER.length) {
      throw new Error(`line ${i + 2}: expected ${HEADER.length} cells, got ${cells.length}`);
    }
    return { term: cells[0], expansion: cells[1], source: cells[2] };
  });
}

function validate(rows: Row[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const normalised = r.term.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (r.term !== normalised) problems.push(`  "${r.term}": term must be lowercase and unaccented`);
    if (r.term.trim() !== r.term) problems.push(`  "${r.term}": term has surrounding whitespace`);
    if (r.term.length === 0) problems.push("  a row has an empty term");
    if (r.term.split(" ").length > 2) {
      problems.push(`  "${r.term}": catalog_expand_query matches one or two tokens, not ${r.term.split(" ").length}`);
    }
    if (r.expansion.trim().length === 0) problems.push(`  "${r.term}": empty expansion`);
    if (r.expansion === r.term) problems.push(`  "${r.term}": expands into itself`);
    if (seen.has(r.term)) problems.push(`  "${r.term}": named twice`);
    seen.add(r.term);
  }
  if (problems.length > 0) {
    throw new Error(`${problems.length} problem(s) in the synonym sheet:\n${problems.join("\n")}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const csvAt = argv.indexOf("--csv");
  const csvPath = csvAt >= 0 ? argv[csvAt + 1] : DEFAULT_CSV;

  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  validate(rows);

  const admin = adminClient();
  const { data, error: readError } = await admin.from("catalog_synonyms").select("term");
  if (readError) throw new Error(`catalog_synonyms read failed: ${readError.message}`);
  const present = new Set(((data ?? []) as { term: string }[]).map((r) => r.term));
  const wanted = new Set(rows.map((r) => r.term));
  const stale = [...present].filter((t) => !wanted.has(t));

  console.log(`${rows.length} rows in ${csvPath}; ${present.size} in the table; ${stale.length} to delete`);

  if (dryRun) {
    for (const r of rows) console.log(`  would upsert ${r.term} -> ${r.expansion} (${r.source})`);
    for (const t of stale) console.log(`  would delete ${t}`);
    console.log("dry run: nothing written");
    return;
  }

  const { error: upsertError } = await admin
    .from("catalog_synonyms")
    .upsert(rows, { onConflict: "term" });
  if (upsertError) throw new Error(`catalog_synonyms upsert failed: ${upsertError.message}`);

  if (stale.length > 0) {
    const { error: deleteError } = await admin.from("catalog_synonyms").delete().in("term", stale);
    if (deleteError) throw new Error(`catalog_synonyms delete failed: ${deleteError.message}`);
  }
  console.log(`loaded ${rows.length} synonyms, deleted ${stale.length}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
