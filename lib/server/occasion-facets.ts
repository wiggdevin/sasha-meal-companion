import "server-only";

/**
 * The snapshot's facets evidence source (Phase 17 O3, D7: "facets v2 calibrated → snapshot reads
 * them"). For each snapshot food it reads the cached v2 occasion facets and maps them, through the
 * calibration gate and its per-occasion thresholds, to `{ score, source: "facets" }` affinities.
 * The ladder (lib/meals/facet-affinity.ts `withFacetPrior`) puts them below curated and above
 * neutral; history (O2) sits above both.
 *
 * Gate shut (the default until a passing calibration is stored): no database read at all, every
 * food abstains, and `hashPart` is "abstain". Gate open: one bounded cache read
 * (lib/foods/facets.ts readFacets, which already filters each facet to its own rubric revision, so
 * a v1 occasion row never reads as v2). Any read failure abstains for the affected foods; it never
 * fails the snapshot.
 *
 * Food facets are D0/D1 food-only data with no account in them (`food_facets` holds a food's
 * judgment, never who ate it). Nothing account-derived is written here or read from anywhere but
 * the account's own eligible foods.
 *
 * Caller: lib/server/meal-snapshot.ts `mealSnapshot` passes each snapshot food's own user-food id or
 * catalog food id, places the scores with `withFacetPrior` in `occasionMap` (history above, curated
 * above, neutral below), and folds `hashPart` into `inputsHash`. The phone collects the resulting
 * `source: "facets"` rows into MealEvidence.facets (lib/meals/snapshot.ts `mealEvidence`).
 *
 * (`food_facets` is service-role only, so the client is the admin client.) A user food is read back
 * here with an explicit `user_id` filter, so a food id that is not the account's own, or is
 * deleted, gets no facet evidence whatever the caller passes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogWarmFood, type CatalogWarmRow } from "@/lib/foods/catalog-ingredients";
import { warmFoodCacheKey } from "@/lib/foods/facet-keys";
import { OCCASION_FACETS } from "@/lib/foods/facet-vocabulary";
import { facetCacheKey, readFacets, type FacetCacheKey } from "@/lib/foods/facets";
import {
  MEAL_OCCASIONS, OCCASION_FACET_OF, occasionFacetGate, type MealOccasion, type OccasionGate,
} from "@/lib/foods/occasion-gate";
import { facetOccasionScore } from "@/lib/meals/facet-affinity";
import { adminClient } from "@/lib/server/admin";
import { activeRevisionsByFood } from "@/lib/server/log-evidence";
import { fetchAllChunked } from "@/lib/server/paged-read";

export type OccasionFacetFood =
  | { id: string; kind: "user_food"; userFoodId: string }
  | { id: string; kind: "catalog"; catalogFoodId: number };

/** Mapped facet scores per snapshot food id; a missing occasion abstains (neutral). */
export type OccasionFacetScores = Record<string, Partial<Record<MealOccasion, number>>>;

export type OccasionFacetEvidence = {
  status: "abstain" | "open";
  /** Why the gate is shut, when it is. */
  reason?: string;
  /** For the snapshot's inputsHash: "abstain", or the calibration the scores came from. */
  hashPart: string;
  scores: OccasionFacetScores;
  /** Cache read failures (counted, never thrown). */
  errors: number;
};

export type OccasionFacetDeps = {
  gate?: OccasionGate;
  /** The service-role client to use when the caller passes none (tests). */
  admin?: SupabaseClient;
  readFacets?: typeof readFacets;
  activeRevisionsByFood?: typeof activeRevisionsByFood;
};

const REVISION_SELECT = "id,description,brand,category,prep_state,"
  + "catalog_ingredients(seq,name,raw_text,allergen_tags),catalog_portions(seq,description,is_default)";

export async function occasionFacetEvidence(
  admin: SupabaseClient | null, userId: string, foods: readonly OccasionFacetFood[],
  deps: OccasionFacetDeps = {},
): Promise<OccasionFacetEvidence> {
  const gate = deps.gate ?? occasionFacetGate();
  if (!gate.open) return { status: "abstain", reason: gate.reason, hashPart: "abstain", scores: {}, errors: 0 };
  const hashPart = `facets:${gate.calibrationId}`;
  if (foods.length === 0) return { status: "open", hashPart, scores: {}, errors: 0 };

  let db: SupabaseClient;
  try {
    db = admin ?? deps.admin ?? adminClient();
  } catch {
    return { status: "open", hashPart, scores: {}, errors: 1 };
  }
  const { keys, errors: keyErrors } = await cacheKeys(db, userId, foods, deps);
  const read = deps.readFacets ?? readFacets;
  const cached = await read([...new Map([...keys.values()].map((key) => [facetCacheKey(key), key])).values()],
    OCCASION_FACETS, db);

  const scores: OccasionFacetScores = {};
  for (const food of foods) {
    const key = keys.get(food.id);
    const judgments = key ? cached.get(facetCacheKey(key)) : undefined;
    if (!judgments) continue;
    const own: Partial<Record<MealOccasion, number>> = {};
    for (const occasion of MEAL_OCCASIONS) {
      const score = facetOccasionScore(judgments[OCCASION_FACET_OF[occasion]]?.p, gate.thresholds[occasion]);
      if (score !== null) own[occasion] = score;
    }
    if (Object.keys(own).length > 0) scores[food.id] = own;
  }
  return { status: "open", hashPart, scores, errors: keyErrors + cached.errors };
}

/** The exact cache identity the warm job stored each food under (lib/foods/facet-warm.ts). */
async function cacheKeys(
  db: SupabaseClient, userId: string, foods: readonly OccasionFacetFood[], deps: OccasionFacetDeps,
): Promise<{ keys: Map<string, FacetCacheKey>; errors: number }> {
  const keys = new Map<string, FacetCacheKey>();
  const [own, catalog] = await Promise.all([userFoodKeys(db, userId, foods), catalogKeys(db, foods, deps)]);
  for (const [id, key] of [...own.keys, ...catalog.keys]) keys.set(id, key);
  return { keys, errors: own.errors + catalog.errors };
}

type UserFoodRow = { id: string; rev: number; name: string; brand: string | null; ingredients_text: string | null };

/** The account's own live user foods, keyed as ensureUserFoodFacets stores them. */
async function userFoodKeys(
  db: SupabaseClient, userId: string, foods: readonly OccasionFacetFood[],
): Promise<{ keys: Map<string, FacetCacheKey>; errors: number }> {
  const keys = new Map<string, FacetCacheKey>();
  const wanted = foods.filter((food): food is Extract<OccasionFacetFood, { kind: "user_food" }> =>
    food.kind === "user_food");
  if (wanted.length === 0) return { keys, errors: 0 };
  try {
    // Paged (t18): a failed page rejects, and every user food then abstains.
    const data = await fetchAllChunked<string, UserFoodRow>([...new Set(wanted.map((food) => food.userFoodId))],
      (ids, from, to) => db.from("user_foods").select("id,rev,name,brand,ingredients_text")
        .in("id", ids).eq("user_id", userId).is("deleted_at", null).order("id").range(from, to));
    const rows = new Map(data.map((row) => [row.id, row]));
    for (const food of wanted) {
      const row = rows.get(food.userFoodId);
      if (!row) continue;
      keys.set(food.id, warmFoodCacheKey({ identity: { kind: "user_food", id: row.id, rev: row.rev },
        name: row.name, brand: row.brand, ingredientsText: row.ingredients_text }));
    }
    return { keys, errors: 0 };
  } catch {
    return { keys, errors: 1 };
  }
}

/** Shared catalog foods, at their newest active revision. */
async function catalogKeys(
  db: SupabaseClient, foods: readonly OccasionFacetFood[], deps: OccasionFacetDeps,
): Promise<{ keys: Map<string, FacetCacheKey>; errors: number }> {
  const keys = new Map<string, FacetCacheKey>();
  const catalog = foods.filter((food): food is Extract<OccasionFacetFood, { kind: "catalog" }> =>
    food.kind === "catalog");
  if (catalog.length === 0) return { keys, errors: 0 };
  try {
    const active = await (deps.activeRevisionsByFood ?? activeRevisionsByFood)(db,
      [...new Set(catalog.map((food) => food.catalogFoodId))]);
    // One revision per food, the newest active one, so a food never mixes two revisions' answers.
    const revisionOf = new Map([...active].map(([foodId, ids]) => [foodId, Math.max(...ids)]));
    const revisionIds = [...new Set(revisionOf.values())];
    if (revisionIds.length === 0) return { keys, errors: 0 };
    const data = await fetchAllChunked<number, CatalogWarmRow>(revisionIds, (ids, from, to) =>
      db.from("catalog_food_revisions").select(REVISION_SELECT).in("id", ids).order("id").range(from, to) as
        unknown as PromiseLike<{ data: CatalogWarmRow[] | null; error: { message: string } | null }>);
    const byRevision = new Map(data
      .map((row) => [row.id, warmFoodCacheKey(catalogWarmFood(row))]));
    for (const food of catalog) {
      const revision = revisionOf.get(food.catalogFoodId);
      const key = revision === undefined ? undefined : byRevision.get(revision);
      if (key) keys.set(food.id, key);
    }
    return { keys, errors: 0 };
  } catch {
    return { keys, errors: 1 };
  }
}
