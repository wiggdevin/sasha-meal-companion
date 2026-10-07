/**
 * The FNDDS-inputs import (Phase 18 W4, spec §6 migration 3): the dedicated writer of
 * `catalog_food_inputs`. Reads the documented FNDDS 2021-2023 recipes from the offline workspace
 * (`pnpm exec tsx scripts/priors/fetch.ts` puts them there), resolves every input to its catalog
 * food (scripts/priors/fndds-inputs.ts), and writes one row per input of each dish's active
 * `fdc_fndds` revision. No model decomposes a dish; Jev is never called.
 *
 *   pnpm exec tsx scripts/import-fndds-inputs.ts [--dry-run]     plan only (the default): writes nothing
 *   pnpm exec tsx scripts/import-fndds-inputs.ts --commit         write to a LOCAL stack only
 *   pnpm exec tsx scripts/import-fndds-inputs.ts --commit --production --project-ref <ref>
 *                                                                 write to that remote project (owner step)
 *
 * Production is an OWNER-RUN step (docs/catalog/import.md "FNDDS inputs"), frozen until the owner
 * runs it. The guard (scripts/priors/import-guard.ts) refuses `--commit` to any non-loopback host
 * unless `--production` is passed and `--project-ref` equals the target URL's project.
 *
 * Before any write the run must prove one FNDDS release end to end (scripts/priors/fndds-release.ts):
 * the pinned zip, the files read from it, the catalog worker's ledger, the active catalog version,
 * a content fingerprint of that version's revisions in the TARGET database against the zip, and
 * every dish revision in that version. After the last write it proves the same release again. Any unresolved code, missing catalog food or release
 * mismatch refuses the whole run, which then writes nothing.
 *
 * Writes go through `catalog_replace_food_inputs` (migration 20261214100200): each call replaces
 * whole dishes in one transaction and refuses unless every named revision is active, so a failure
 * leaves every dish fully old or fully new. A re-run
 * converges and writes nothing new.
 *
 * Env: SUPABASE_URL and the service-role key (lib/server/admin.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminClient } from "@/lib/server/admin";
import { fetchAllChunked, fetchAllRows } from "@/lib/server/paged-read";
import { loadInputPlan, type InputPlan } from "@/scripts/priors/fndds-inputs";
import {
  buildRows, diffRows, replaceBatches, type ActiveRevision, type CatalogFood, type InputRow, type RowDiff,
  type RowsResult, type StoredRow,
} from "@/scripts/priors/fndds-inputs-rows";
import {
  nutrientKey, portionKey, postWriteFindings, readReleaseFiles, releaseFindings, type CatalogVersion, type FingerprintRow, type ReleaseEvidence,
} from "@/scripts/priors/fndds-release";
import { assertImportTarget, parseImportArgs } from "@/scripts/priors/import-guard";
import { FNDDS_FILES, FNDDS_RELEASE, FOUNDATION_SOURCE, INPUT_SOURCES, SR_FILES } from "@/scripts/priors/input-sources";
import { sha256File } from "@/scripts/priors/inputs";
import { licenceFindings } from "@/scripts/priors/sources";
import { resolveWorkspace } from "@/scripts/priors/workspace";

const SOURCES = ["fdc_fndds", "fdc_sr_legacy", "fdc_foundation"];

type Catalog = { foods: CatalogFood[]; active: ActiveRevision[]; versions: CatalogVersion[] };

async function readCatalog(admin: SupabaseClient): Promise<Catalog> {
  const versions = await fetchAllRows<CatalogVersion>((from, to) => admin.from("catalog_versions")
    .select("id,source,version_label,is_active").eq("source", FNDDS_RELEASE.catalogSource).order("id").range(from, to));
  const foods = await fetchAllRows<CatalogFood>((from, to) => admin.from("catalog_foods")
    .select("id,source,source_id").in("source", SOURCES).order("id").range(from, to));
  const dishIds = foods.filter((food) => food.source === "fdc_fndds").map((food) => Number(food.id));
  const active = await fetchAllChunked<number, ActiveRevision>(dishIds, (batch, from, to) => admin
    .from("catalog_food_revisions").select("id,catalog_food_id,catalog_version_id").eq("is_active", true)
    .in("catalog_food_id", batch).order("id").range(from, to));
  return { foods, active, versions };
}

/**
 * The label-matched version's revisions as stored, with their nutrients and portions: the target
 * database's half of the release fingerprint (fndds-release.ts check 5).
 */
async function readVersionRows(admin: SupabaseClient, versions: readonly CatalogVersion[]): Promise<FingerprintRow[]> {
  const match = versions.filter((v) => v.source === FNDDS_RELEASE.catalogSource && v.version_label === FNDDS_RELEASE.versionLabel);
  if (match.length !== 1) return [];
  const version = match[0].id;
  type Food = { source_id: string };
  type Revision = { id: number; description: string; content_hash: string; catalog_foods: Food | Food[] | null };
  const revisions = await fetchAllRows<Revision>((from, to) => admin.from("catalog_food_revisions")
    .select("id,description,content_hash,catalog_foods(source_id)").eq("catalog_version_id", version)
    .order("id").range(from, to));
  const byId = new Map(revisions.map((row) => {
    const food = Array.isArray(row.catalog_foods) ? row.catalog_foods[0] : row.catalog_foods;
    return [Number(row.id), { fdcId: food?.source_id ?? "", description: row.description, contentHash: row.content_hash,
      nutrients: [] as string[], portions: [] as string[] }];
  }));
  const nutrients = await fetchAllRows<{ food_revision_id: number; nutrient_code: string; amount_per_100g: unknown }>(
    (from, to) => admin.from("catalog_food_nutrients")
      .select("food_revision_id,nutrient_code,amount_per_100g,catalog_food_revisions!inner(catalog_version_id)")
      .eq("catalog_food_revisions.catalog_version_id", version).neq("nutrient_code", "energy_kcal_calc")
      .order("food_revision_id").order("nutrient_code").range(from, to));
  for (const row of nutrients) byId.get(Number(row.food_revision_id))?.nutrients.push(nutrientKey(row.nutrient_code, row.amount_per_100g));
  const portions = await fetchAllRows<{ food_revision_id: number; seq: number; description: string; gram_weight: unknown;
    is_default: boolean }>((from, to) => admin.from("catalog_portions")
    .select("food_revision_id,seq,description,gram_weight,is_default,catalog_food_revisions!inner(catalog_version_id)")
    .eq("catalog_food_revisions.catalog_version_id", version).order("food_revision_id").order("seq").range(from, to));
  for (const row of portions) {
    byId.get(Number(row.food_revision_id))?.portions.push(portionKey(row.seq, row.description, row.gram_weight, row.is_default));
  }
  return [...byId.values()];
}

/** Checks 4 and 5 of fndds-release.ts against the target, plus the dish revisions' version. */
async function proveRelease(admin: SupabaseClient, files: Omit<ReleaseEvidence, "versions" | "dbRows">) {
  const catalog = await readCatalog(admin);
  const evidence: ReleaseEvidence = { ...files, versions: catalog.versions,
    dbRows: await readVersionRows(admin, catalog.versions) };
  return { catalog, release: releaseFindings(evidence) };
}

async function readStored(admin: SupabaseClient): Promise<StoredRow[]> {
  try {
    return await fetchAllRows<StoredRow>((from, to) => admin.from("catalog_food_inputs")
      .select("food_revision_id,seq,input_catalog_food_id,grams,source,estimated")
      .order("food_revision_id").order("seq").range(from, to));
  } catch (error) {
    throw new Error(`catalog_food_inputs read failed (${error instanceof Error ? error.message : String(error)}); `
      + "apply migrations 20261214100000, 20261214100100 and 20261214100200 first");
  }
}

function printPlan(plan: InputPlan, workspace: string): void {
  const r = plan.report;
  console.log("sources (sha256):");
  for (const file of [FNDDS_RELEASE.zip, FNDDS_FILES.inputs, FNDDS_FILES.codes, SR_FILES.foods, SR_FILES.descriptions,
    FOUNDATION_SOURCE.files[0]]) console.log(`  ${file} ${sha256File(join(workspace, file))}`);
  console.log(`FNDDS foods ${r.fnddsFoods}; listing inputs ${r.dishesListingInputs}; with stored inputs ${r.dishesWithStoredInputs}`);
  console.log(`source rows ${r.sourceRows}; stored ${r.storedRows} (fndds ${r.byKind.fndds}, sr_legacy ${r.byKind.sr_legacy}, `
    + `foundation ${r.byKind.foundation}, sr_modified ${r.byKind.sr_modified}); fortificant rows not stored `
    + `${r.fortificantRows} (${r.fortificantCodes.join(", ")}); single-input foods ${r.singleInputDishes}`);
  console.log(`unresolved codes ${r.unresolved.length}`);
  for (const item of r.unresolved.slice(0, 50)) {
    console.log(`  dish ${item.dishFdcId} seq ${item.seq}: ${item.code} "${item.description}"`);
  }
}

function printRows(rows: RowsResult, diff: RowDiff, batches: number, commit: boolean): void {
  console.log(`catalog: ${rows.dishes} dishes, ${rows.rows.length} rows resolved; ${rows.problems.length} problem(s)`);
  for (const problem of rows.problems.slice(0, 50)) console.log(`  problem: ${problem}`);
  console.log(`${commit ? "writing" : "would write"}: ${diff.upserts.length} new or changed row(s), ${diff.deletes.length} `
    + `stale row(s), ${diff.unchanged} unchanged; ${batches} atomic dish batch(es)`);
}

/** The writer port: one call replaces the named dish revisions' rows in one transaction. */
export type ReplaceDishes = (revisionIds: number[], rows: InputRow[]) => Promise<void>;

export function rpcReplace(admin: SupabaseClient): ReplaceDishes {
  return async (revisionIds, rows) => {
    const { error } = await admin.rpc("catalog_replace_food_inputs", { p_revision_ids: revisionIds, p_rows: rows });
    if (error) throw new Error(`catalog_replace_food_inputs failed: ${error.message}`);
  };
}

/** Replaces every changed dish, whole dishes per call; the first failure stops the run. */
export async function writeDishes(batches: readonly InputRow[][], replace: ReplaceDishes): Promise<number> {
  let written = 0;
  for (const batch of batches) {
    await replace([...new Set(batch.map((row) => row.food_revision_id))], batch);
    written += batch.length;
  }
  return written;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseImportArgs(argv);
  // The same URL adminClient() resolves (lib/server/admin.ts), so the guard sees the real target.
  assertImportTarget(args, process.env.SUPABASE_URL ?? process.env.SUPABASE_TEST_URL);
  const licence = licenceFindings(INPUT_SOURCES, false);
  if (licence.length) throw new Error(licence.map((item) => `${item.source}: ${item.problem}`).join("; "));

  const workspace = resolveWorkspace(process.cwd());
  const plan = loadInputPlan(workspace);
  printPlan(plan, workspace);
  const admin = adminClient();
  const files = readReleaseFiles(workspace);
  const { catalog, release } = await proveRelease(admin, files);
  for (const finding of release.findings) console.log(`  ${finding}`);
  console.log(`release: ${release.versionId === null ? "NOT proven" : `catalog version ${release.versionId}`} `
    + `(${FNDDS_RELEASE.catalogSource} ${FNDDS_RELEASE.versionLabel}, zip ${FNDDS_RELEASE.zipSha256.slice(0, 12)}…)`);
  // An unproven release refuses on its own findings; no per-dish list is built against it.
  const rows: RowsResult = release.versionId === null ? { rows: [], problems: [], dishes: 0, revisionIds: new Set() }
    : buildRows(plan, catalog.foods, catalog.active, release.versionId);
  const diff = diffRows(rows.rows, await readStored(admin), rows.revisionIds);
  const batches = replaceBatches(rows.rows, diff);
  printRows(rows, diff, batches.length, args.commit);
  const refused = plan.report.unresolved.length + rows.problems.length + release.findings.length;
  if (refused) {
    console.error(`refused, nothing written: ${plan.report.unresolved.length} unresolved code(s), `
      + `${release.findings.length} release finding(s), ${rows.problems.length} catalog problem(s)`);
    return 1;
  }
  if (!args.commit) {
    console.log("dry run: nothing written (pass --commit; a remote target also needs --production --project-ref <ref>)");
    return 0;
  }
  await writeDishes(batches, rpcReplace(admin));
  // Sol W4 r2 WARN 3: the release must still be the one proven before the writes.
  const recheck = await proveRelease(admin, files);
  const moved = [...postWriteFindings(release.versionId!, recheck.release),
    ...buildRows(plan, recheck.catalog.foods, recheck.catalog.active, recheck.release.versionId ?? -1).problems];
  if (moved.length) {
    for (const finding of moved.slice(0, 50)) console.error(`  ${finding}`);
    console.error("verify failed: the catalog changed during the import; re-run the dry run, then the import");
    return 1;
  }
  const after = diffRows(rows.rows, await readStored(admin), rows.revisionIds);
  if (after.upserts.length || after.deletes.length) {
    console.error(`verify failed: ${after.upserts.length} row(s) still differ, ${after.deletes.length} stale`);
    return 1;
  }
  console.log(`verified: ${rows.rows.length} rows for ${rows.dishes} dishes match the plan`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
