/**
 * Fills `catalog_food_revisions.policy_categories` from lib/catalog/category-map.ts — T1 §3.
 *
 *   pnpm exec tsx scripts/annotate-policy-categories.ts [--commit] [--out <dir>] [--limit <n>]
 *
 * Read-only by default: without `--commit` nothing is written and the counts are what a real run
 * WOULD write. Idempotent either way — a revision whose stored array already equals the computed
 * one is skipped, so a second run over an annotated catalog writes zero rows and reports the same
 * counts. That is what makes it safe to re-run after every import.
 *
 * `--out <dir>` writes one CSV per key, 30 rows each, for the panel's precision sample. The sample
 * is taken in revision-id order rather than at random, so two runs over the same catalog produce
 * the same rows and a rule change is visible as a diff.
 *
 * Env: SUPABASE_URL and the service-role key (read only inside adminClient()). A `--commit` facet
 * pass also requires FACET_WARM_USER_ID or SUPABASE_TEST_USER_ID for provider accounting.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { policyCategoriesFor, POLICY_CATEGORY_KEYS, type PolicyCategoryKey }
  from "@/lib/catalog/category-map";
import { catalogWarmFood } from "@/lib/foods/catalog-ingredients";
import { adminClient, adminClientForCli } from "@/lib/server/admin";

const PAGE = 1000;
const SAMPLE_ROWS = 30;
const CHILD_ARG = "--category-annotator-react-server-child";

type RevisionRow = {
  id: number;
  catalog_food_id: number;
  description: string;
  brand: string | null;
  category: string | null;
  prep_state: string | null;
  policy_categories: string[] | null;
  catalog_foods: { source: string } | null;
  catalog_ingredients: { seq: number; name: string; raw_text: string | null }[];
  catalog_portions: { seq: number; description: string | null; is_default: boolean }[];
};

type Annotated = { row: RevisionRow; keys: PolicyCategoryKey[] };

/**
 * NULL is never equal to `[]`. A never-annotated row and an annotated-clean row hold the same keys
 * — none — but they mean different things to `policyCategoriesOf`, so the first run has to write
 * '{}' over every NULL rather than skip it as "already correct".
 */
function sameKeys(stored: string[] | null, next: string[]): boolean {
  if (stored === null) return false;
  const a = [...stored].sort();
  const b = [...next].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Every active revision, a page at a time: the production catalog is ~13.7k rows. */
async function readActiveRevisions(
  admin: ReturnType<typeof adminClient>, limit: number | null,
): Promise<RevisionRow[]> {
  const out: RevisionRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const { data, error } = await admin
      .from("catalog_food_revisions")
      .select("id,catalog_food_id,description,brand,category,prep_state,policy_categories,catalog_foods(source),catalog_ingredients(seq,name,raw_text),catalog_portions(seq,description,is_default)")
      .eq("is_active", true)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`catalog_food_revisions read failed: ${error.message}`);
    const page = (data ?? []) as unknown as RevisionRow[];
    out.push(...page);
    if (page.length < PAGE) break;
    if (limit !== null && out.length >= limit) break;
  }
  return limit === null ? out : out.slice(0, limit);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function writeSamples(dir: string, annotated: Annotated[]): void {
  mkdirSync(dir, { recursive: true });
  for (const key of POLICY_CATEGORY_KEYS) {
    const rows = annotated.filter((a) => a.keys.includes(key)).slice(0, SAMPLE_ROWS);
    const lines = ["revision_id,catalog_food_id,source,category,description"];
    for (const { row } of rows) {
      lines.push([
        String(row.id), String(row.catalog_food_id), row.catalog_foods?.source ?? "",
        row.category ?? "", row.description,
      ].map(csvCell).join(","));
    }
    const file = path.join(dir, `${key}.csv`);
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    console.log(`  sample: ${rows.length} row(s) → ${file}`);
  }
}

async function writeAnnotations(
  admin: ReturnType<typeof adminClient>, changed: Annotated[],
): Promise<void> {
  for (const { row, keys } of changed) {
    const { error } = await admin
      .from("catalog_food_revisions")
      .update({ policy_categories: keys })
      .eq("id", row.id);
    if (error) throw new Error(`update failed for revision ${row.id}: ${error.message}`);
  }
}

/** C1b: category annotation completes before the offline, fail-open facet pass begins. */
async function warmFacets(
  admin: ReturnType<typeof adminClient>, rows: RevisionRow[], dryRun: boolean,
): Promise<void> {
  const { ensureFacets } = await import("@/lib/foods/facet-warm");
  const result = await ensureFacets(rows.map(catalogWarmFood), {
    admin, dryRun, userId: process.env.FACET_WARM_USER_ID ?? process.env.SUPABASE_TEST_USER_ID,
  });
  for (const [index, batch] of result.batches.entries()) console.log(
    `  facet batch ${index + 1}: ${batch.foods} food(s), ${batch.questions} question(s), `
      + `${batch.estimatedTokens}/16000 estimated tokens`,
  );
  console.log(`facet pass: ${result.judged} judged, ${result.skipped} skipped, `
    + `${result.unknown} unknown, ${result.writes} writes`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== CHILD_ARG);
  const commit = argv.includes("--commit");
  const outAt = argv.indexOf("--out");
  const outDir = outAt >= 0 ? argv[outAt + 1] : null;
  const limitAt = argv.indexOf("--limit");
  const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : null;
  if (limit !== null && !Number.isFinite(limit)) throw new Error("--limit needs a number");
  const accountingUserId = process.env.FACET_WARM_USER_ID ?? process.env.SUPABASE_TEST_USER_ID;
  if (commit && !accountingUserId) {
    throw new Error("--commit requires FACET_WARM_USER_ID or SUPABASE_TEST_USER_ID for facet accounting");
  }

  // Branch-first: the TEST names win when present; production needs an explicit --production.
  const admin = adminClientForCli({ production: argv.includes("--production") });
  const rows = await readActiveRevisions(admin, limit);
  console.log(`${rows.length} active revision(s) read`);

  const annotated: Annotated[] = rows.map((row) => ({
    row,
    keys: policyCategoriesFor({ description: row.description, category: row.category }),
  }));

  for (const key of POLICY_CATEGORY_KEYS) {
    console.log(`  ${key}: ${annotated.filter((a) => a.keys.includes(key)).length}`);
  }
  const matched = annotated.filter((a) => a.keys.length > 0).length;
  console.log(`  (rows with at least one key: ${matched})`);

  const changed = annotated.filter((a) => !sameKeys(a.row.policy_categories, a.keys));
  console.log(`${changed.length} revision(s) differ from what is stored`);

  if (outDir) writeSamples(outDir, annotated);

  if (!commit) {
    console.log("dry run: nothing written (pass --commit to write)");
  } else {
    await writeAnnotations(admin, changed);
    console.log(`annotated ${changed.length} revision(s)`);
  }
  await warmFacets(admin, rows, !commit);
}

if (!process.argv.includes(CHILD_ARG)) {
  const child = spawnSync(process.execPath, [...process.execArgv, "--conditions=react-server",
    fileURLToPath(import.meta.url), CHILD_ARG, ...process.argv.slice(2)], {
    stdio: "inherit", env: process.env,
  });
  if (child.error) console.error(child.error.message);
  process.exitCode = child.status ?? 1;
} else main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
