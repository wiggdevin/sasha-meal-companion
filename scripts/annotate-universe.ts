/**
 * Annotates the Phase 18 universe's catalog revisions (docs/catalog/universe.md, slice W1): each
 * item's allergen evidence (`food_allergen_evidence`) and `policy_categories`, from deterministic
 * rules only (never Jev).
 *
 *   pnpm exec tsx scripts/annotate-universe.ts                      read-only report, any project
 *   pnpm exec tsx scripts/annotate-universe.ts --commit             write, on a branch or local db
 *   pnpm exec tsx scripts/annotate-universe.ts --commit --production   an owner step, never a default
 *
 * The write guard is scripts/food-membership-audit.ts's own (`--commit` stands in for its
 * `--fix`): `--commit` refuses production unless `--production` is passed too, and refuses outright
 * when SUPABASE_URL names no identifiable project. A refused run opens no connection.
 *
 * Per item, the report checks the identity first: exactly one active `fdc_sr_legacy` revision for
 * the item's pinned FoodData Central id, whose description and food group are the bundled row's.
 * An item that fails is reported and never written. Then:
 *   - `policy_categories` = lib/catalog/category-map.ts over that revision, written where the stored
 *     array differs (a NULL is always written: NULL means "never annotated").
 *   - evidence through lib/server/allergen-evidence.ts `recordAllergenEvidence`, the warm path's
 *     own writer: the revision's description, no ingredient text. It never downgrades a stored
 *     `listed` and writes a stored Jev hold back unchanged (W2a), so a re-run is idempotent.
 * The whole-food clearance is not stored; readers derive it (lib/foods/universe/derive.ts).
 *
 * Env: SUPABASE_URL (else SUPABASE_TEST_URL) and the service-role key, read by adminClient().
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { policyCategoriesFor } from "@/lib/catalog/category-map";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE, UNIVERSE_VERSION } from "@/lib/foods/universe/manifest";
import {
  EVIDENCE_KEYS, evidenceFromInputs, mergeEvidence, type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import { adminClient } from "@/lib/server/admin";
import {
  readAllergenEvidence, recordAllergenEvidence, type EvidenceByFood, type EvidenceFood,
} from "@/lib/server/allergen-evidence";
import { fetchAllChunked } from "@/lib/server/paged-read";
import { assertWriteTarget } from "./food-membership-audit";

export const SR_SOURCE = "fdc_sr_legacy";

export type CatalogRevision = {
  id: number; source_id: string; description: string; category: string | null;
  policy_categories: string[] | null; is_active: boolean;
};

export type AnnotationPlan = {
  problems: string[];
  /** Revisions whose `policy_categories` differ from the computed keys. */
  categoryWrites: { revisionId: number; itemId: string; keys: string[] }[];
  /** One evidence food per identified item (what `recordAllergenEvidence` is given). */
  evidenceFoods: EvidenceFood[];
  /** Evidence rows a write would add or change, as `<item>:<allergen>`. */
  evidenceChanges: string[];
};

/** The shared guard, with `--commit` in the place of `--fix`. */
export function assertCommitTarget(argv: readonly string[], url: string | undefined): void {
  const mapped = argv.map((arg) => (arg === "--commit" ? "--fix" : arg))
    .filter((arg) => arg === "--fix" || arg === "--production");
  try {
    assertWriteTarget(mapped, url);
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : String(error)).replaceAll("--fix", "--commit"));
  }
}

const sameKeys = (stored: string[] | null, next: string[]) => stored !== null
  && stored.length === next.length && [...stored].sort().every((key, i) => key === [...next].sort()[i]);

const sameEvidence = (a: StoredAllergenEvidence | undefined, b: StoredAllergenEvidence) =>
  !!a && a.level === b.level && a.labelComplete === b.labelComplete && !!a.held === !!b.held;

/** Pure: what a run would write, from the catalog rows and stored evidence it read. */
export function planAnnotations(items: readonly UniverseItem[], revisions: readonly CatalogRevision[],
  stored: EvidenceByFood): AnnotationPlan {
  const plan: AnnotationPlan = { problems: [], categoryWrites: [], evidenceFoods: [], evidenceChanges: [] };
  for (const item of items) {
    const active = revisions.filter((row) => row.source_id === String(item.entry.fdcId) && row.is_active);
    if (active.length !== 1) {
      plan.problems.push(`${item.entry.id}: ${active.length} active ${SR_SOURCE} revisions for fdc ${item.entry.fdcId}`);
      continue;
    }
    const revision = active[0];
    if (revision.description !== item.row.sr || (revision.category ?? null) !== (item.row.srCategory ?? null)) {
      plan.problems.push(`${item.entry.id}: revision ${revision.id} reads "${revision.description}" `
        + `(${revision.category}), the bundled row "${item.row.sr}" (${item.row.srCategory})`);
      continue;
    }
    const keys = policyCategoriesFor({ description: revision.description, category: revision.category });
    if (!sameKeys(revision.policy_categories, keys)) {
      plan.categoryWrites.push({ revisionId: revision.id, itemId: item.entry.id, keys });
    }
    const foodKey = `catalog_revision:${revision.id}`;
    plan.evidenceFoods.push({ foodKey, userId: null, ingredientsText: null, labelComplete: false,
      foodName: revision.description });
    const derived = evidenceFromInputs({ ingredientsText: null, labelComplete: false,
      foodName: revision.description });
    const current = stored.get(foodKey) ?? {};
    for (const key of EVIDENCE_KEYS) {
      const next = current[key]?.held ? current[key] : mergeEvidence(current[key], derived[key]) ?? derived[key];
      if (!sameEvidence(current[key], next)) plan.evidenceChanges.push(`${item.entry.id}:${key}`);
    }
  }
  return plan;
}

async function readRevisions(admin: SupabaseClient, fdcIds: readonly string[]): Promise<CatalogRevision[]> {
  type Row = { source_id: string; catalog_food_revisions: Omit<CatalogRevision, "source_id">[] };
  const rows = await fetchAllChunked<string, Row>(fdcIds, (batch, from, to) => admin.from("catalog_foods")
    .select("source_id,catalog_food_revisions(id,description,category,policy_categories,is_active)")
    .eq("source", SR_SOURCE).in("source_id", batch).order("id").range(from, to));
  return rows.flatMap((row) => row.catalog_food_revisions.map((revision) =>
    ({ ...revision, source_id: row.source_id })));
}

export async function main(argv: string[]): Promise<void> {
  const allowed = new Set(["--commit", "--production"]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown.join(", ")}`);
  assertCommitTarget(argv, process.env.SUPABASE_URL ?? process.env.SUPABASE_TEST_URL);
  const commit = argv.includes("--commit");
  const admin = adminClient();
  const items = UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null);
  const revisions = await readRevisions(admin, items.map((item) => String(item.entry.fdcId)));
  const keys = revisions.filter((row) => row.is_active).map((row) => `catalog_revision:${row.id}`);
  const plan = planAnnotations(items, revisions, await readAllergenEvidence(admin, keys));
  console.log(`universe ${UNIVERSE_VERSION}: ${items.length} items, ${plan.evidenceFoods.length} identified`);
  for (const problem of plan.problems) console.log(`  problem: ${problem}`);
  console.log(`policy_categories: ${plan.categoryWrites.length} revision(s) ${commit ? "to write" : "would change"}`);
  console.log(`evidence: ${plan.evidenceChanges.length} row(s) ${commit ? "to write" : "would change"}`);
  if (!commit) {
    if (plan.problems.length > 0) throw new Error(`${plan.problems.length} universe item(s) not identified`);
    return;
  }
  for (const write of plan.categoryWrites) {
    const { error } = await admin.from("catalog_food_revisions")
      .update({ policy_categories: write.keys }).eq("id", write.revisionId);
    if (error) throw new Error(`policy_categories update failed for revision ${write.revisionId}: ${error.message}`);
  }
  const result = await recordAllergenEvidence(admin, plan.evidenceFoods);
  if (result.errors > 0) throw new Error("allergen evidence write failed");
  console.log(`wrote ${plan.categoryWrites.length} policy_categories and ${result.written} evidence row(s)`);
  if (plan.problems.length > 0) throw new Error(`${plan.problems.length} universe item(s) not identified`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
