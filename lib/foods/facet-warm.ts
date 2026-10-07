import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JEV_MODEL } from "@/lib/ai/models";
import { facetPayload } from "@/lib/ai/payloads";
import { systemOne, type NoulAnswer } from "@/lib/ai/typesafe";
import { catalogWarmFood, type CatalogWarmRow, type FacetWarmFood } from "@/lib/foods/catalog-ingredients";
import { FACETS, type Facet } from "@/lib/foods/facets";
import { looksLikeCompleteList } from "@/lib/policy/allergens";
import { avoidedAllergensFor, recordAllergenEvidence } from "@/lib/server/allergen-evidence";
import { foodKey, inputHash, warmFoodHashInput, type FacetFoodInput } from "@/lib/foods/facet-keys";
import { facetRubricVersion, rubricVersionsFor } from "@/lib/foods/facet-vocabulary";
import { adminClient } from "@/lib/server/admin";
import { fetchAllChunked } from "@/lib/server/paged-read";

export type { FacetWarmFood } from "@/lib/foods/catalog-ingredients";

/** System One's documented shared input budget is about 32k tokens. */
export const FACET_PROVIDER_TOKEN_LIMIT = 32_000;
/** Warm requests use at most half of that budget, preserving at least 50% headroom. */
export const FACET_BATCH_TOKEN_LIMIT = FACET_PROVIDER_TOKEN_LIMIT / 2;

const MODEL_ALIAS = JEV_MODEL;
const DEFAULT_DEADLINE_MS = 3_000;

export type EnsureFacetsOptions = {
  admin?: SupabaseClient;
  /** Accounting identity required for the shared daily spend cap. Never enters provider state. */
  userId?: string;
  deadlineMs?: number;
  dryRun?: boolean;
};

export type FacetBatchPlan = {
  foods: number;
  questions: number;
  estimatedTokens: number;
};

export type EnsureFacetsResult = {
  foods: number;
  judged: number;
  skipped: number;
  unknown: number;
  writes: number;
  errors: number;
  batches: FacetBatchPlan[];
  retryableUnknown: number;
  nonRetryable: { foodKey: string; unknown: number; reason: "oversized" }[];
  /**
   * Phase 13 §5: allergen evidence recorded for the warmed foods, and coverage — the share of
   * them with any evidence beyond no_evidence — so false exclusions can be measured.
   */
  allergenEvidence?: { written: number; errors: number; coverage: number };
};

type PreparedFood = {
  food: FacetWarmFood;
  foodKey: string;
  inputHash: string;
  missing: Facet[];
};

type Batch = {
  foods: PreparedFood[];
  payload: ReturnType<typeof facetPayload>;
  bindings: Record<string, { food: PreparedFood; facet: Facet }>;
  estimatedTokens: number;
};

type ExistingRow = {
  food_key: unknown;
  input_hash: unknown;
  facet: unknown;
  rubric_version: unknown;
};

type UserFoodWarmRow = {
  id: string; user_id: string; name: string; brand: string | null;
  ingredients_text: string | null; rev: number; kind?: string; allergen_tags?: string[] | null;
};

/**
 * Conservative byte-based estimator shared with the facet evaluator. It measures the exact JSON
 * request body and assumes four UTF-8 bytes per token; the 16k ceiling supplies the required 50%
 * headroom beneath the provider's documented 32k shared input budget.
 */
export function estimateFacetRequestTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}

/**
 * Fill missing food facets off the interactive path. A facet is missing when no row carries its
 * current rubric revision (`facetRubricVersion`): occasion rows judged under rubric v1 are re-warmed
 * at v2 rather than reinterpreted, and the v1 rows are left as they are. Cache, provider, cap, and write failures
 * are returned as unknown counts and never escape to the caller.
 */
export async function ensureFacets(
  foods: readonly FacetWarmFood[],
  opts: EnsureFacetsOptions = {},
): Promise<EnsureFacetsResult> {
  const prepared = uniqueFoods(foods);
  const result: EnsureFacetsResult = {
    foods: prepared.length, judged: 0, skipped: 0,
    unknown: prepared.length * FACETS.length, writes: 0, errors: 0, batches: [],
    retryableUnknown: 0, nonRetryable: [],
  };
  if (prepared.length === 0) return finalResult(result);

  let admin: SupabaseClient;
  try {
    admin = opts.admin ?? adminClient();
    const existing = await existingFacets(admin, prepared);
    if (existing === null) return finalResult({ ...result, errors: 1 });
    for (const item of prepared) {
      item.missing = FACETS.filter((facet) => !existing.has(rowKey(item, facet)));
      result.skipped += FACETS.length - item.missing.length;
    }
  } catch {
    return finalResult({ ...result, errors: 1 });
  }

  const { batches, oversized } = makeBatches(prepared.filter((item) => item.missing.length > 0));
  result.batches = batches.map((batch) => ({ foods: batch.foods.length,
    questions: Object.keys(batch.payload.questions).length, estimatedTokens: batch.estimatedTokens }));
  result.nonRetryable = oversized.map((item) => ({
    foodKey: item.foodKey, unknown: item.missing.length, reason: "oversized",
  }));
  result.errors += oversized.length;
  result.unknown -= result.skipped;
  if (opts.dryRun) return finalResult(result);
  if (batches.length === 0) return finalResult(await withEvidence(admin, prepared, result, opts.userId));

  // systemOne only applies the daily spend brake when it has an accounting user. Never bypass it.
  if (!opts.userId) {
    return finalResult(await withEvidence(admin, prepared, { ...result, errors: result.errors + 1 },
      opts.userId));
  }

  for (const batch of batches) {
    try {
      const answers = await systemOne(batch.payload, {
        deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
        userId: opts.userId,
      });
      if (!answers) {
        result.errors += 1;
        continue;
      }
      const rows = rowsFromAnswers(batch, answers as Record<string, NoulAnswer>);
      if (rows.length === 0) {
        result.errors += 1;
        continue;
      }
      const { error } = await admin.from("food_facets").upsert(rows, {
        onConflict: "food_key,input_hash,facet,rubric_version",
        ignoreDuplicates: true,
      });
      if (error) {
        result.errors += 1;
        continue;
      }
      result.judged += rows.length;
      result.writes += rows.length;
      result.unknown -= rows.length;
    } catch {
      result.errors += 1;
    }
  }
  return finalResult(await withEvidence(admin, prepared, result, opts.userId));
}

/**
 * Phase 13 §5: record allergen evidence for every warmed food from its ingredient text, label
 * completeness, legacy tags and name, then log coverage. Phase 18 W2a: Jev facets are not read
 * here — no allergen evidence comes from Jev. Coverage is scoped to the accounting user's own
 * avoided fixed allergens (finding #11) when one is given; a catalog-wide warm with no single
 * account in view falls back to "any fixed key has evidence". Failures never escape.
 */
async function withEvidence(
  admin: SupabaseClient, prepared: readonly PreparedFood[], result: EnsureFacetsResult,
  userId?: string,
): Promise<EnsureFacetsResult> {
  try {
    const avoidedFixed = userId ? await avoidedAllergensFor(admin, userId) : undefined;
    const recorded = await recordAllergenEvidence(admin, prepared.map((item) => ({
      foodKey: item.foodKey,
      userId: item.food.identity.kind === "user_food" ? item.food.ownerUserId ?? null : null,
      ingredientsText: item.food.ingredientsText,
      labelComplete: item.food.labelComplete === true,
      tags: item.food.allergenTags ?? null,
      foodName: item.food.name, foodBrand: item.food.brand,
    })), avoidedFixed);
    const coverage = prepared.length === 0 ? 0 : recorded.withEvidence / prepared.length;
    // sol BLOCK (r2): without an account key, a per-call ratio cannot be rolled up into that
    // account's real "share of recent foods" coverage over time (§5); null marks a catalog-wide warm.
    console.info("[allergen-coverage]", JSON.stringify({ userId: userId ?? null, foods: prepared.length,
      withEvidence: recorded.withEvidence, coverage: Math.round(coverage * 1000) / 1000 }));
    return { ...result, allergenEvidence: { written: recorded.written, errors: recorded.errors,
      coverage } };
  } catch {
    return { ...result, allergenEvidence: { written: 0, errors: 1, coverage: 0 } };
  }
}

/** Re-read canonical catalog fields after a barcode response, then warm without delaying it. */
export async function ensureCatalogRevisionFacets(
  revisionIds: readonly number[], opts: EnsureFacetsOptions,
): Promise<EnsureFacetsResult> {
  const ids = [...new Set(revisionIds)];
  if (ids.length === 0) return emptyResult();
  try {
    const admin = opts.admin ?? adminClient();
    const { data, error } = await admin.from("catalog_food_revisions")
      .select("id,description,brand,category,prep_state,catalog_ingredients(seq,name,raw_text,allergen_tags),catalog_portions(seq,description,is_default)")
      .in("id", ids);
    if (error) return failedResult(ids.length);
    const foods = ((data ?? []) as unknown as CatalogWarmRow[]).map(catalogWarmFood);
    const missingRows = ids.length - foods.length;
    const result = await ensureFacets(foods, { ...opts, admin });
    return missingRows === 0 ? result : finalResult({ ...result,
      foods: result.foods + missingRows, unknown: result.unknown + missingRows * FACETS.length,
      errors: result.errors + missingRows });
  } catch {
    return failedResult(ids.length);
  }
}

/** Re-read a newly created user food (including its real revision) before warming it. */
export async function ensureUserFoodFacets(
  userFoodIds: readonly string[], opts: EnsureFacetsOptions,
): Promise<EnsureFacetsResult> {
  const ids = [...new Set(userFoodIds)];
  if (ids.length === 0) return emptyResult();
  if (!opts.userId) return failedResult(ids.length);
  try {
    const admin = opts.admin ?? adminClient();
    const { data, error } = await admin.from("user_foods")
      .select("id,user_id,name,brand,ingredients_text,rev,kind,allergen_tags").in("id", ids)
      .eq("user_id", opts.userId).is("deleted_at", null);
    if (error) return failedResult(ids.length);
    const foods = ((data ?? []) as UserFoodWarmRow[]).map((row): FacetWarmFood => ({
      identity: { kind: "user_food", id: row.id, rev: row.rev }, name: row.name,
      brand: row.brand, ingredientsText: row.ingredients_text, ownerUserId: row.user_id,
      // §9 R2: a client-created custom food is never a complete label; a label scan may be.
      labelComplete: row.kind === "label_scan" && looksLikeCompleteList(row.ingredients_text),
      allergenTags: row.allergen_tags ?? [],
    }));
    const missingRows = ids.length - foods.length;
    const result = await ensureFacets(foods, { ...opts, admin });
    return missingRows === 0 ? result : finalResult({ ...result,
      foods: result.foods + missingRows, unknown: result.unknown + missingRows * FACETS.length,
      errors: result.errors + missingRows });
  } catch {
    return failedResult(ids.length);
  }
}

function uniqueFoods(foods: readonly FacetWarmFood[]): PreparedFood[] {
  const unique = new Map<string, PreparedFood>();
  for (const food of foods) {
    const key = foodKey(food.identity);
    const hash = inputHash(hashInput(food));
    const id = `${key}\0${hash}`;
    if (!unique.has(id)) unique.set(id, { food, foodKey: key, inputHash: hash, missing: [] });
  }
  return [...unique.values()];
}

function emptyResult(): EnsureFacetsResult {
  return { foods: 0, judged: 0, skipped: 0, unknown: 0, writes: 0, errors: 0, batches: [],
    retryableUnknown: 0, nonRetryable: [] };
}

function failedResult(foods: number): EnsureFacetsResult {
  return finalResult({ ...emptyResult(), foods, unknown: foods * FACETS.length, errors: 1 });
}

function finalResult(result: EnsureFacetsResult): EnsureFacetsResult {
  const permanent = result.nonRetryable.reduce((total, item) => total + item.unknown, 0);
  result.retryableUnknown = Math.max(0, result.unknown - permanent);
  return result;
}

/**
 * §9 R4: what Jev may see of a food. A user-authored record sends only its name, brand and
 * ingredient text, trimmed to the label-food schema lengths (lib/server/log-label-food.ts); an
 * ingredient list longer than its schema is never cut short (a cut list could hide an ingredient
 * and read as "absent"), so that food is left unjudged instead (see `userFoodTooLong`).
 */
const USER_FIELD_MAX = { name: 160, brand: 120, ingredientsText: 4_000 } as const;

function providerFood(food: FacetWarmFood): FacetFoodInput {
  if (food.identity.kind !== "user_food") return hashInput(food);
  return {
    name: food.name.slice(0, USER_FIELD_MAX.name),
    brand: food.brand ? food.brand.slice(0, USER_FIELD_MAX.brand) : null,
    ingredientsText: food.ingredientsText ?? null,
  };
}

function userFoodTooLong(food: FacetWarmFood): boolean {
  return food.identity.kind === "user_food"
    && (food.ingredientsText?.length ?? 0) > USER_FIELD_MAX.ingredientsText;
}

function hashInput(food: FacetWarmFood): FacetFoodInput {
  return warmFoodHashInput(food);
}

async function existingFacets(
  admin: SupabaseClient, foods: readonly PreparedFood[],
): Promise<Set<string> | null> {
  let data: ExistingRow[];
  try { // t18 r4: paged by primary key; a failed page fails the read (no model calls), never "missing".
    data = await fetchAllChunked<PreparedFood, ExistingRow>(foods, (chunk, from, to) => admin
      .from("food_facets").select("food_key,input_hash,facet,rubric_version")
      .in("rubric_version", rubricVersionsFor(FACETS))
      .in("food_key", [...new Set(chunk.map((item) => item.foodKey))])
      .in("input_hash", [...new Set(chunk.map((item) => item.inputHash))])
      .order("food_key").order("input_hash").order("facet").order("rubric_version").range(from, to));
  } catch { return null; }
  const wanted = new Set(foods.flatMap((item) => FACETS.map((facet) => rowKey(item, facet))));
  const found = new Set<string>();
  for (const row of data) {
    if (typeof row.food_key !== "string" || typeof row.input_hash !== "string"
      || typeof row.facet !== "string" || !(FACETS as readonly string[]).includes(row.facet)
      || Number(row.rubric_version) !== facetRubricVersion(row.facet as Facet)) continue;
    const key = `${row.food_key}\0${normalHash(row.input_hash)}\0${row.facet}`;
    if (wanted.has(key)) found.add(key);
  }
  return found;
}

function makeBatches(foods: readonly PreparedFood[]): {
  batches: Batch[]; oversized: PreparedFood[];
} {
  const batches: Batch[] = [];
  let pending: PreparedFood[] = [];
  const oversized: PreparedFood[] = [];
  for (const food of foods) {
    if (userFoodTooLong(food.food)) {
      oversized.push(food);
      continue;
    }
    const trial = batchFor([...pending, food]);
    if (trial.estimatedTokens <= FACET_BATCH_TOKEN_LIMIT) {
      pending = trial.foods;
      continue;
    }
    if (pending.length > 0) batches.push(batchFor(pending));
    const alone = batchFor([food]);
    if (alone.estimatedTokens > FACET_BATCH_TOKEN_LIMIT) {
      oversized.push(food);
      pending = [];
    } else pending = [food];
  }
  if (pending.length > 0) batches.push(batchFor(pending));
  return { batches, oversized };
}

function batchFor(foods: PreparedFood[]): Batch {
  // The builder owns the question ids (`food_<index>__<facet>`) and the rubric wording (§9 R3).
  // §9 R4: Jev always receives the same, full question set for every food; only the missing
  // facets are stored from its answers. Nothing about the user selects a question.
  const payload = facetPayload({ foods: foods.map((item) => ({
    food: providerFood(item.food), facets: FACETS })) });
  const bindings: Batch["bindings"] = {};
  foods.forEach((item, index) => {
    for (const facet of item.missing) bindings[`food_${index}__${facet}`] = { food: item, facet };
  });
  const request = { state: payload.state, model: MODEL_ALIAS, questions: payload.questions };
  return { foods, payload, bindings, estimatedTokens: estimateFacetRequestTokens(request) };
}

function rowsFromAnswers(batch: Batch, answers: Record<string, NoulAnswer>) {
  const rows: Record<string, unknown>[] = [];
  for (const [id, binding] of Object.entries(batch.bindings)) {
    const p = answers[id]?.noul;
    if (!Number.isFinite(p) || p < 0 || p > 1) continue;
    rows.push({ food_key: binding.food.foodKey, input_hash: binding.food.inputHash,
      facet: binding.facet, rubric_version: facetRubricVersion(binding.facet), p: Math.round(p * 1000) / 1000,
      model: MODEL_ALIAS, user_id: binding.food.food.ownerUserId ?? null });
  }
  return rows;
}

const rowKey = (food: PreparedFood, facet: Facet) => `${food.foodKey}\0${food.inputHash}\0${facet}`;

const normalHash = (value: string) =>
  value.startsWith("\\x") ? value.toLowerCase() : `\\x${value.toLowerCase()}`;
