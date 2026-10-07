/**
 * Phase 18 W2a (docs/specs/phase-18-open-world-foods.md D4, §10 W2a): Jev-only allergen holds.
 *
 * A stored `food_allergen_evidence` row with `level = 'listed', source = 'jev'` is a HOLD: the app
 * reads it as "Not verified", never as clear (lib/policy/allergen-holds.ts storedEvidenceFromRow). This
 * script reports holds, re-derives the ones that are really name, tag or text matches, and runs a
 * logged review of one hold. It never deletes a row.
 *
 *   (no flag)                       read-only report: held rows by allergen, how many the food's
 *                                   own deterministic inputs would re-derive, and how many holds
 *                                   a review has released. No food key or name is printed.
 *   --rederive                      every hold whose food's own name, tag or ingredient text names
 *                                   the allergen becomes a deterministic `listed` (still blocked),
 *                                   through the logged review path (reviewed_by 'w2a-rederive').
 *                                   Idempotent; prints counts. Releases nothing.
 *   --review --reviewer <name> --food-key <key> --allergen <key>
 *                                   replaces ONE hold with the food's deterministic evidence
 *                                   (`listed`, or `not_listed` from a complete label) and records
 *                                   the reviewer. Refuses when the food has no deterministic
 *                                   evidence: the hold stays.
 *   --production                    required with --rederive or --review on production.
 *
 * The production count for W2a acceptance 3: run the report before merge (after --rederive) and
 * after merge. `heldTotal` and `heldByAllergen` must match, and `releasedByReview` must not grow.
 * The migration-level guarantee behind it: only a logged review can lower a held row
 * (supabase/migrations/20261212090000_allergen_evidence_review.sql).
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogWarmFood, type CatalogWarmRow } from "@/lib/foods/catalog-ingredients";
import {
  allergenKey, deriveEvidence, looksLikeCompleteList, textNames, type StoredAllergenEvidence,
} from "@/lib/policy/allergens";
import { JEV_EVIDENCE_SOURCE } from "@/lib/policy/allergen-holds";
import { adminClient } from "@/lib/server/admin";
import {
  infoLookupKey, loadFoodInfo, loadJevListedRows, projectRef, redactedFoodKey,
  type EvidenceRow, type FoodInfo,
} from "@/scripts/allergen-evidence-repair";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";
export const REDERIVE_REVIEWER = "w2a-rederive";

export type HeldRow = EvidenceRow;

/** A stored row that is a hold. */
export function isHeld(row: Pick<EvidenceRow, "level" | "source">): boolean {
  return row.level === "listed" && row.source === JEV_EVIDENCE_SOURCE;
}

/** Held rows per normalized allergen key, sorted by key. Pure. */
export function heldCountsByAllergen(rows: readonly EvidenceRow[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isHeld(row)) continue;
    const key = allergenKey(row.allergen);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * True when the food's own deterministic inputs name the allergen: a tag (its own key or a family
 * word, e.g. a bare "wheat" tag for gluten), the ingredient text, or the name. The same inputs
 * `deriveEvidence` lists on. Pure.
 */
export function deterministicallyListed(allergen: string, info: FoodInfo): boolean {
  const key = allergenKey(allergen);
  const familyTag = (info.tags ?? []).some((tag) => textNames(key, tag));
  return familyTag || deriveEvidence(key, { ingredientsText: info.ingredientsText ?? null,
    labelComplete: false, tags: info.tags, foodName: info.foodName }).level === "listed";
}

export type RederivePlan = { foodKey: string; allergen: string; userId: string | null; updatedAt: string };

/**
 * The holds that are really deterministic matches (spec Fixture C: "whey protein powder" stored
 * with source 'jev'). A food with no readable info is left held: unknown never re-derives. Pure.
 */
export function planRederive(
  rows: readonly EvidenceRow[], foodInfo: (foodKey: string) => FoodInfo | undefined,
): RederivePlan[] {
  return rows.flatMap((row) => {
    if (!isHeld(row)) return [];
    const info = foodInfo(row.food_key);
    if (!info || !deterministicallyListed(row.allergen, info)) return [];
    return [{ foodKey: row.food_key, allergen: row.allergen, userId: row.user_id,
      updatedAt: row.updated_at }];
  });
}

export type ReviewInput = {
  ingredientsText: string | null; labelComplete: boolean; tags: readonly string[] | null;
  foodName: string | null;
};

/**
 * The deterministic evidence a review may replace a hold with, or null when there is none (the
 * hold stays). Never reads a Jev facet, the whole-food class or a user's product check. Pure.
 */
export function reviewReplacement(allergen: string, food: ReviewInput): StoredAllergenEvidence | null {
  const derived = deriveEvidence(allergenKey(allergen), food);
  const family = (food.tags ?? []).some((tag) => textNames(allergenKey(allergen), tag));
  if (family || derived.level === "listed") return { level: "listed", labelComplete: derived.labelComplete };
  return derived.level === "not_listed" ? derived : null;
}

/** Throws when the flags would write somewhere they should not. Pure. */
export function assertHoldsWriteTarget(argv: readonly string[], url: string | undefined): void {
  const ref = projectRef(url);
  const production = ref === PRODUCTION_REF;
  const writes = argv.includes("--rederive") || argv.includes("--review");
  const optIn = argv.includes("--production");
  if (argv.includes("--rederive") && argv.includes("--review")) {
    throw new Error("--rederive and --review are separate runs");
  }
  if (optIn && !writes) throw new Error("--production only applies with --rederive or --review");
  if (optIn && !production) {
    throw new Error(`--production given, but SUPABASE_URL is not production project ${PRODUCTION_REF}`);
  }
  if (!writes) return;
  if (ref === null) throw new Error("refuses: cannot identify the Supabase project from SUPABASE_URL");
  if (production && !optIn) {
    throw new Error(`refuses production project ${PRODUCTION_REF} without --production`);
  }
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

async function releasedByReview(admin: SupabaseClient): Promise<number | string> {
  const { count, error } = await admin.from("food_allergen_evidence")
    .select("food_key", { count: "exact", head: true })
    .not("reviewed_at", "is", null).neq("level", "listed");
  if (error) return `n/a (${error.message.slice(0, 120)})`;
  return count ?? "n/a (no count)";
}

async function report(admin: SupabaseClient): Promise<void> {
  const rows = await loadJevListedRows(admin);
  const info = await loadFoodInfo(admin, rows);
  const plan = planRederive(rows, (key) => info.get(infoLookupKey(key)));
  console.log(JSON.stringify({
    heldTotal: rows.filter(isHeld).length,
    heldByAllergen: heldCountsByAllergen(rows),
    rederivable: plan.length,
    releasedByReview: await releasedByReview(admin),
  }));
}

async function rederive(admin: SupabaseClient): Promise<void> {
  const rows = await loadJevListedRows(admin);
  const info = await loadFoodInfo(admin, rows);
  const plan = planRederive(rows, (key) => info.get(infoLookupKey(key)));
  let updated = 0;
  let skipped = 0;
  for (const item of plan) {
    // Re-asserts the hold and the exact row version read, so a row changed since the scan is
    // skipped, never overwritten. The level stays `listed`: this is a block, never a release.
    let query = admin.from("food_allergen_evidence").update({
      source: "ingredients", reviewed_at: new Date().toISOString(), reviewed_by: REDERIVE_REVIEWER,
      updated_at: new Date().toISOString(),
    }, { count: "exact" }).eq("food_key", item.foodKey).eq("allergen", item.allergen)
      .eq("level", "listed").eq("source", JEV_EVIDENCE_SOURCE).eq("updated_at", item.updatedAt);
    query = item.userId === null ? query.is("user_id", null) : query.eq("user_id", item.userId);
    const { error, count } = await query;
    if (error) throw new Error(`rederive failed for ${redactedFoodKey(item.foodKey)}/${item.allergen}: ${error.message}`);
    if (count === 1) updated += 1;
    else skipped += 1;
  }
  console.log(JSON.stringify({ heldBefore: rows.filter(isHeld).length, rederivable: plan.length,
    rederived: updated, skippedChangedSinceScan: skipped }));
}

type UserFoodRow = { id: string; name: string; ingredients_text: string | null; kind: string;
  allergen_tags: string[] | null; rev: number };

async function reviewInputFor(admin: SupabaseClient, foodKey: string): Promise<ReviewInput | null> {
  const catalog = /^catalog_revision:([0-9]+)$/.exec(foodKey);
  if (catalog) {
    const { data, error } = await admin.from("catalog_food_revisions")
      .select("id,description,brand,category,prep_state,catalog_ingredients(seq,name,raw_text,allergen_tags),catalog_portions(seq,description,is_default)")
      .eq("id", Number(catalog[1]));
    if (error) throw new Error(error.message);
    const row = (data as unknown as CatalogWarmRow[] | null)?.[0];
    if (!row) return null;
    const food = catalogWarmFood(row);
    return { ingredientsText: food.ingredientsText ?? null, labelComplete: food.labelComplete === true,
      tags: food.allergenTags ?? null, foodName: food.name };
  }
  const user = /^user_food:([0-9a-f-]{36}):([0-9]+)$/i.exec(foodKey);
  if (!user) return null;
  const { data, error } = await admin.from("user_foods")
    .select("id,name,ingredients_text,kind,allergen_tags,rev").eq("id", user[1]);
  if (error) throw new Error(error.message);
  const row = (data as UserFoodRow[] | null)?.[0];
  // A review judges the revision the evidence row belongs to; a food edited since needs its own row.
  if (!row || String(row.rev) !== user[2]) return null;
  return { ingredientsText: row.ingredients_text,
    // §9 R2: a client-created custom food is never a complete label; a label scan may be.
    labelComplete: row.kind === "label_scan" && looksLikeCompleteList(row.ingredients_text),
    tags: row.allergen_tags, foodName: row.name };
}

async function review(admin: SupabaseClient, argv: readonly string[]): Promise<void> {
  const reviewer = flagValue(argv, "--reviewer")?.trim();
  const foodKey = flagValue(argv, "--food-key");
  const allergenArg = flagValue(argv, "--allergen");
  if (!reviewer || !foodKey || !allergenArg) {
    throw new Error("--review needs --reviewer <name> --food-key <key> --allergen <key>");
  }
  const allergen = allergenKey(allergenArg);
  const { data, error } = await admin.from("food_allergen_evidence")
    .select("food_key,allergen,level,label_complete,source,user_id,updated_at")
    .eq("food_key", foodKey).eq("allergen", allergen);
  if (error) throw new Error(error.message);
  const row = (data as EvidenceRow[] | null)?.[0];
  if (!row || !isHeld(row)) throw new Error(`no hold for ${redactedFoodKey(foodKey)}/${allergen}`);
  const input = await reviewInputFor(admin, foodKey);
  const replacement = input ? reviewReplacement(allergen, input) : null;
  if (!replacement) {
    console.log(JSON.stringify({ foodKey: redactedFoodKey(foodKey), allergen, result: "stays_held",
      reason: "no deterministic evidence for this revision" }));
    return;
  }
  const now = new Date().toISOString();
  let query = admin.from("food_allergen_evidence").update({
    level: replacement.level, label_complete: replacement.labelComplete,
    source: replacement.labelComplete ? "label" : "ingredients",
    reviewed_at: now, reviewed_by: reviewer, updated_at: now,
  }, { count: "exact" }).eq("food_key", foodKey).eq("allergen", allergen)
    .eq("level", "listed").eq("source", JEV_EVIDENCE_SOURCE).eq("updated_at", row.updated_at);
  query = row.user_id === null ? query.is("user_id", null) : query.eq("user_id", row.user_id);
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  if (result.count !== 1) throw new Error("the row changed since it was read; nothing was reviewed");
  console.log(JSON.stringify({ foodKey: redactedFoodKey(foodKey), allergen, result: "reviewed",
    level: replacement.level, reviewer }));
}

export async function main(argv: string[]): Promise<void> {
  const flags = new Set(["--rederive", "--review", "--production"]);
  const valued = new Set(["--reviewer", "--food-key", "--allergen"]);
  for (let index = 0; index < argv.length; index += 1) {
    if (valued.has(argv[index])) { index += 1; continue; }
    if (!flags.has(argv[index])) throw new Error(`unknown argument: ${argv[index]}`);
  }
  // Before any client exists: a refused run opens no connection at all.
  assertHoldsWriteTarget(argv, process.env.SUPABASE_URL);
  const admin = adminClient();
  if (argv.includes("--rederive")) return rederive(admin);
  if (argv.includes("--review")) return review(admin, argv);
  return report(admin);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
