import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureCatalogRevisionFacets, ensureUserFoodFacets, type EnsureFacetsResult }
  from "@/lib/foods/facet-warm";
import { facetRubricVersion, rubricVersionsFor, type Facet } from "@/lib/foods/facets";
import { OCCASION_FACETS } from "@/lib/foods/facet-vocabulary";
import { catalogWarmFood, type CatalogWarmRow } from "@/lib/foods/catalog-ingredients";
import { normalizeInputHash, warmFoodCacheKey } from "@/lib/foods/facet-keys";
import { activeRevisionsByFood } from "@/lib/server/log-evidence";
import { fetchAllChunked, fetchAllRows } from "@/lib/server/paged-read";

/**
 * Nothing warms foods on a user's Eats list: `food_facets` holds roughly 46 `human_food` rows
 * total, so a packaged/prepared Eats food can never carry the facet plan-sheet suggestions and
 * profile rules need (lib/coach/suggest-policy.ts), while a plain whole food passes by name alone.
 * This walks one user's Eats list, skips whatever is already cached, and warms the rest through
 * the same idempotent, never-throwing `ensure*Facets` calls the barcode and commit paths use —
 * charged to that same user's daily Jev spend cap.
 */
export type WarmEatsFacetsOptions = {
  /** Foods actually sent to Jev this run; the rest wait for the next one. Default 40. */
  maxFoods?: number;
  deadlineMs?: number;
  /** Test seam for a deterministic clock. Only used for the one-line log below. */
  now?: () => number;
};

export type WarmEatsFacetsResult = {
  /** Distinct Eats-list foods (catalog + user) this run could resolve a revision/row for. */
  foods: number;
  /** Facets actually written this run (summed across both ensure* calls). */
  warmed: number;
  /** Already cached, or resolved but left for a later run (cap or an early stop). */
  skipped: number;
  errors: number;
  /** A batch reported a spend-cap/circuit/provider failure, so the rest of this run was left for
   *  next time rather than hammering the same trouble again. */
  stoppedEarly: boolean;
};

const DEFAULT_MAX_FOODS = 40;
/**
 * A food is warm when it carries every sentinel at its current rubric revision AND its current
 * input hash (a row for an older input of the same food key is stale): `human_food`
 * (rubric v1, the first facet every warm writes) and all four occasion facets (v2 since Phase 17
 * O3). A food warmed before O3, or one whose v2 warm wrote only some occasion answers, lacks one,
 * so it is picked again and `ensureFacets` re-judges only its missing facets. Foods holding the
 * fewest sentinels go first (never-warmed before partly warmed).
 */
const SENTINELS: readonly Facet[] = ["human_food", ...OCCASION_FACETS];

const EMPTY: WarmEatsFacetsResult = { foods: 0, warmed: 0, skipped: 0, errors: 0, stoppedEarly: false };

type Candidate =
  | { kind: "catalog"; key: string; revisionId: number }
  | { kind: "user"; key: string; userFoodId: string };

type UserFoodRow = { id: string; rev: number; name: string; brand: string | null;
  ingredients_text: string | null };
type SentinelRow = { food_key: unknown; input_hash: unknown; facet: unknown; rubric_version: unknown };

/** The fields the warm job hashes a catalog revision from (lib/foods/facet-warm.ts). */
const REVISION_SELECT = "id,description,brand,category,prep_state,"
  + "catalog_ingredients(seq,name,raw_text,allergen_tags),catalog_portions(seq,description,is_default)";

type FoodRefRow = { id: string; kind: string; user_food_id: string | null;
  catalog_food_id: number | null };

/**
 * Warms every Eats-list food of `userId` that is not warm at the current rubric revisions yet, up to
 * `maxFoods` for this run. Never throws: a read failure is reported as one error and an empty
 * result, exactly like the `ensure*Facets` functions this delegates to. Every read is paged past
 * the API row cap (t18 r5); a failed page warms nothing and calls no model, never a partial list.
 */
export async function warmEatsFacets(
  client: SupabaseClient, userId: string, opts: WarmEatsFacetsOptions = {},
): Promise<WarmEatsFacetsResult> {
  const maxFoods = opts.maxFoods ?? DEFAULT_MAX_FOODS;
  try {
    const refIds = await eatsRefIds(client, userId);
    if (refIds.length === 0) return EMPTY;

    const refRows = await fetchAllChunked<string, FoodRefRow>(refIds, (ids, from, to) =>
      client.from("food_refs").select("id,kind,user_food_id,catalog_food_id")
        .in("id", ids).order("id").range(from, to));

    const catalogFoodIds = [...new Set(refRows
      .filter((r) => r.kind === "catalog" && r.catalog_food_id != null)
      .map((r) => r.catalog_food_id as number))];
    const userFoodIds = [...new Set(refRows
      .filter((r) => r.kind === "user" && r.user_food_id != null)
      .map((r) => r.user_food_id as string))];

    const activeByFood = catalogFoodIds.length === 0 ? new Map<number, number[]>()
      : await activeRevisionsByFood(client, catalogFoodIds);
    const revisionIds = [...new Set([...activeByFood.values()].flat())];

    // Only the caller's OWN, un-deleted rows: a stale ref to a food that moved or was removed
    // warms nothing, and this never trusts a ref alone to prove ownership.
    const userFoodRows = await fetchAllChunked<string, UserFoodRow>(userFoodIds,
      (ids, from, to) => client.from("user_foods").select("id,rev,name,brand,ingredients_text")
        .in("id", ids).eq("user_id", userId).is("deleted_at", null).order("id").range(from, to));
    const revById = new Map(userFoodRows.map((row) => [row.id, row.rev]));
    const ownedUserFoodIds = userFoodIds.filter((id) => revById.has(id));

    const foods = catalogFoodIds.length + ownedUserFoodIds.length;
    if (revisionIds.length === 0 && ownedUserFoodIds.length === 0) return { ...EMPTY, foods };

    const allCandidates: Candidate[] = [
      ...revisionIds.map((revisionId): Candidate =>
        ({ kind: "catalog", key: `catalog_revision:${revisionId}`, revisionId })),
      ...ownedUserFoodIds.map((userFoodId): Candidate =>
        ({ kind: "user", key: `user_food:${userFoodId}:${revById.get(userFoodId)}`, userFoodId })),
    ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    // Round-2 BLOCK 2: a sentinel counts only at the food's CURRENT input hash, the one the warm
    // job would store it under now; a row for an older input of the same key is a stale judgment.
    let expected: Map<string, string>;
    try {
      expected = await expectedHashes(client, allCandidates, userFoodRows);
    } catch {
      return { ...EMPTY, foods, errors: 1 };
    }
    let cached: SentinelRow[];
    try { // Paged by primary key (t18); a failed page counts nothing as warm and warms nothing.
      cached = await fetchAllChunked<string, SentinelRow>(allCandidates.map((c) => c.key),
        (keys, from, to) => client.from("food_facets").select("food_key,input_hash,facet,rubric_version")
          .in("rubric_version", rubricVersionsFor(SENTINELS)).in("facet", [...SENTINELS])
          .in("food_key", keys)
          .order("food_key").order("input_hash").order("facet").order("rubric_version").range(from, to));
    } catch {
      return { ...EMPTY, foods, errors: 1 };
    }
    const held = new Map<string, Set<string>>();
    for (const row of cached) {
      if (typeof row.food_key !== "string" || !SENTINELS.includes(row.facet as Facet)) continue;
      if (Number(row.rubric_version) !== facetRubricVersion(row.facet as Facet)) continue;
      const want = expected.get(row.food_key);
      if (!want || normalizeInputHash(row.input_hash) !== want) continue;
      held.set(row.food_key, (held.get(row.food_key) ?? new Set()).add(row.facet as string));
    }
    const sentinelsHeld = (key: string) => held.get(key)?.size ?? 0;

    // Cold foods (no current sentinel) first, then partly warmed ones.
    const toWarm = allCandidates.filter((c) => sentinelsHeld(c.key) < SENTINELS.length)
      .sort((a, b) => sentinelsHeld(a.key) - sentinelsHeld(b.key));
    const selected = toWarm.slice(0, maxFoods);
    const skippedCachedOrCapped = allCandidates.length - selected.length;

    const catalogToWarm = selected.filter((c): c is Extract<Candidate, { kind: "catalog" }> =>
      c.kind === "catalog").map((c) => c.revisionId);
    const userToWarm = selected.filter((c): c is Extract<Candidate, { kind: "user" }> =>
      c.kind === "user").map((c) => c.userFoodId);

    let warmed = 0;
    let errors = 0;
    let stoppedEarly = false;
    let skippedByStop = 0;

    if (catalogToWarm.length > 0) {
      const result = await ensureCatalogRevisionFacets(catalogToWarm,
        { admin: client, userId, deadlineMs: opts.deadlineMs });
      warmed += result.judged;
      errors += result.errors;
      stoppedEarly = isProviderTrouble(result);
    }

    if (userToWarm.length > 0) {
      if (stoppedEarly) {
        skippedByStop += userToWarm.length;
      } else {
        const result = await ensureUserFoodFacets(userToWarm,
          { admin: client, userId, deadlineMs: opts.deadlineMs });
        warmed += result.judged;
        errors += result.errors;
        stoppedEarly = isProviderTrouble(result);
      }
    }

    console.info("[eats-facet-warm]", JSON.stringify({ userId, at: (opts.now ?? Date.now)(),
      foods, warmed, stoppedEarly }));
    return { foods, warmed, skipped: skippedCachedOrCapped + skippedByStop, errors, stoppedEarly };
  } catch {
    return { ...EMPTY, errors: 1 };
  }
}

/**
 * Each candidate's current input hash, computed exactly as `ensure*Facets` stores it: a user food
 * from its own name, brand and ingredients; a catalog revision from its row through
 * `catalogWarmFood` (paged; a failed page rejects, so nothing counts as warm). A candidate with no
 * computable hash has no entry and so stays cold.
 */
async function expectedHashes(client: SupabaseClient, candidates: readonly Candidate[],
  userFoods: readonly UserFoodRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ownById = new Map(userFoods.map((row) => [row.id, row]));
  for (const candidate of candidates) {
    if (candidate.kind !== "user") continue;
    const row = ownById.get(candidate.userFoodId);
    if (!row) continue;
    const key = warmFoodCacheKey({ identity: { kind: "user_food", id: row.id, rev: row.rev }, name: row.name,
      brand: row.brand, ingredientsText: row.ingredients_text });
    if (key.foodKey === candidate.key) out.set(candidate.key, key.inputHash);
  }
  const revisionIds = candidates.flatMap((c) => (c.kind === "catalog" ? [c.revisionId] : []));
  const revisions = await fetchAllChunked<number, CatalogWarmRow>(revisionIds, (ids, from, to) =>
    client.from("catalog_food_revisions").select(REVISION_SELECT).in("id", ids).order("id").range(from, to) as
      unknown as PromiseLike<{ data: CatalogWarmRow[] | null; error: { message: string } | null }>);
  for (const revision of revisions) {
    const key = warmFoodCacheKey(catalogWarmFood(revision));
    out.set(key.foodKey, key.inputHash);
  }
  return out;
}

async function eatsRefIds(client: SupabaseClient, userId: string): Promise<string[]> {
  const rows = await fetchAllRows<{ food_ref_id: string }>((from, to) =>
    client.from("user_food_prefs").select("food_ref_id")
      .eq("user_id", userId).eq("status", "eats").order("food_ref_id").range(from, to));
  return [...new Set(rows.map((row) => row.food_ref_id))];
}

/** A batch's own errors or still-retryable unknowns read as a spend-cap, circuit, or provider
 *  failure — never worth a second batch in the same run (facet-warm.ts's own shared brake). */
function isProviderTrouble(result: EnsureFacetsResult): boolean {
  return result.errors > 0 || result.retryableUnknown > 0;
}
