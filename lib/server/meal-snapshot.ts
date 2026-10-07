/**
 * `GET /api/foods/eligible?v=2` (Phase 17 O2, D2): the account's eligible foods with what the
 * ranking needs about each — parts, curated family and occasion affinity with its source — in one
 * versioned, account-scoped snapshot. The contract lives in lib/meals/snapshot.ts.
 *
 * The eligible set is exactly the v1 answer (`eligibleFoods`), returned beside the snapshot as
 * `eligible` so the phone needs one request. Occasion evidence per food follows the ladder:
 * the account's history where it qualifies (lib/server/history-affinity.ts), else the curated
 * prior, else a calibrated Jev v2 facet (O3, lib/server/occasion-facets.ts, only while the
 * calibration gate is open; shut, it reads nothing and every food abstains), else neutral.
 *
 * `inputsHash` covers the rules revision and flags, the Eats set and its exclusions, every food's
 * computed entry (so a role, name or nutrition change moves it), the facet calibration in use, the history watermark, the schedule and the local date: equal inputs, equal hash.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Food } from "@/lib/foods";
import { inferFoodRole } from "@/lib/foods/role";
import { curatedAffinity } from "@/lib/meals/affinity";
import { withFacetPrior } from "@/lib/meals/facet-affinity";
import { MEAL_OCCASIONS, type MealOccasion } from "@/lib/foods/occasion-gate";
import {
  occasionFacetEvidence, type OccasionFacetDeps, type OccasionFacetEvidence, type OccasionFacetFood,
} from "@/lib/server/occasion-facets";
import { OCCASIONS, type Occasion } from "@/lib/meals/occasion";
import { mealFamily, partsOf } from "@/lib/meals/parts";
import {
  RANKING_VERSION, SNAPSHOT_SCHEMA_VERSION, type MealSnapshotV2, type OccasionScore, type SnapshotFood,
} from "@/lib/meals/snapshot";
import type { FoodRole } from "@/lib/foods";
import { eligibleFoods, type EligibleFoods } from "@/lib/server/eligible-foods";
import type { HistoryScores } from "@/lib/meals/history";
import { historyAffinity, type HistoryFood } from "@/lib/server/history-affinity";
import { readMealSchedule } from "@/lib/server/log-occasion";
import { localDate } from "@/lib/server/target-recompute";


type RefRow = {
  id: string; kind: string; catalog_food_id: number | null; user_food_id: string | null;
  user_foods: OwnFood | OwnFood[] | null;
};
type OwnFood = { id: string; user_id: string; name: string; per_100g: Record<string, unknown> | null;
  catalog_food_id: number | null };

export type SnapshotResponse = MealSnapshotV2 & { eligible: EligibleFoods };

const ROLES: readonly FoodRole[] = ["protein", "carb", "fat"];
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** A server Food for the curated part and family rules: per 100 g, the account's own role. */
function foodFor(id: string, name: string, per100g: Record<string, unknown> | null, role: FoodRole | null): Food {
  const perUnit = { protein: num(per100g?.protein), carbs: num(per100g?.carbohydrate), fat: num(per100g?.fat_total) };
  return { id, name, role: role ?? inferFoodRole(name, perUnit), unit: "g" as Food["unit"], perUnit,
    status: "eats", updatedAt: "" };
}

function occasionMap(food: Food, history: Partial<Record<Occasion, number>> | undefined,
  facets: Partial<Record<MealOccasion, number>> | undefined): Record<Occasion, OccasionScore> {
  const out = {} as Record<Occasion, OccasionScore>;
  for (const occasion of OCCASIONS) {
    const own = history?.[occasion];
    // The raw history score only: the phone takes max(history, curated) against its own curated
    // table, so a snapshot never pins an older curated prior inside a "history" number. A facet
    // score speaks only where curated is neutral (withFacetPrior); the phone re-places it on the
    // same ladder against its own curated table.
    const facet = (MEAL_OCCASIONS as readonly Occasion[]).includes(occasion)
      ? facets?.[occasion as MealOccasion] : undefined;
    out[occasion] = own === undefined ? withFacetPrior(curatedAffinity(food, occasion), facet, occasion)
      : { score: own, source: "history" };
  }
  return out;
}

const ABSTAIN: OccasionFacetEvidence = { status: "abstain", hashPart: "abstain", scores: {}, errors: 0 };

export type MealSnapshotDeps = {
  facets?: OccasionFacetDeps;
  /** An eligible read the caller already made inside its own token window (snapshot v3, W8). */
  eligible?: EligibleFoods;
};

async function readTimeZone(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await client.from("user_settings").select("time_zone").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as { time_zone?: string | null } | null)?.time_zone ?? null;
}

/** One snapshot food: its id, the server Food the part and family rules read, and its refs. */
export type SnapshotRow = { id: string; food: Food; refs: HistoryFood };

/** The snapshot's foods and the identities history may name them by. */
async function snapshotFoods(client: SupabaseClient, userId: string, eligible: EligibleFoods):
  Promise<{ id: string; food: Food; refs: HistoryFood }[]> {
  const refIds = [...eligible.eligibleRefIds].sort();
  if (!refIds.length) return [];
  const [refsResult, rolesResult] = await Promise.all([
    client.from("food_refs")
      .select("id,kind,catalog_food_id,user_food_id,user_foods(id,user_id,name,per_100g,catalog_food_id)")
      .in("id", refIds),
    client.from("user_food_prefs").select("food_ref_id,role").eq("user_id", userId).in("food_ref_id", refIds),
  ]);
  if (refsResult.error) throw refsResult.error;
  if (rolesResult.error) throw rolesResult.error;
  const refs = (refsResult.data ?? []) as unknown as RefRow[];
  const roles = new Map(((rolesResult.data ?? []) as { food_ref_id: string; role: unknown }[])
    .filter((row) => ROLES.includes(row.role as FoodRole)).map((row) => [row.food_ref_id, row.role as FoodRole]));
  const catalogRefs = new Map(refs.filter((ref) => ref.kind === "catalog" && ref.catalog_food_id !== null)
    .map((ref) => [ref.catalog_food_id as number, ref.id]));
  const claimed = new Set<string>();
  const out: { id: string; food: Food; refs: HistoryFood }[] = [];
  for (const ref of refs.filter((row) => row.kind === "user").sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const own = Array.isArray(ref.user_foods) ? ref.user_foods[0] : ref.user_foods;
    if (!own || own.user_id !== userId || own.id !== ref.user_food_id) continue;
    const catalogRefId = own.catalog_food_id !== null ? catalogRefs.get(own.catalog_food_id) ?? null : null;
    if (catalogRefId) claimed.add(catalogRefId);
    out.push({ id: own.id, food: foodFor(own.id, own.name, own.per_100g, roles.get(ref.id) ?? null),
      refs: { id: own.id, userRefId: ref.id, catalogRefId, userFoodId: own.id, catalogFoodId: own.catalog_food_id } });
  }
  const loose = refs.filter((ref) => ref.kind === "catalog" && ref.catalog_food_id !== null && !claimed.has(ref.id));
  if (loose.length) {
    const { data, error } = await client.from("catalog_food_revisions")
      .select("catalog_food_id,description,catalog_food_nutrients(nutrient_code,amount_per_100g)")
      .in("catalog_food_id", loose.map((ref) => ref.catalog_food_id as number)).eq("is_active", true);
    if (error) throw error;
    // The active revision's own nutrition, so parts read the same as for an own food (a cooked
    // legume anchors, a mixed dish carries its starch) instead of zeros (Sol r5 WARN 3).
    const revisions = new Map(((data ?? []) as { catalog_food_id: number; description: string;
      catalog_food_nutrients?: { nutrient_code: string; amount_per_100g: number | null }[] | null }[])
      .map((row) => [row.catalog_food_id, { name: row.description, per100g: Object.fromEntries(
        (row.catalog_food_nutrients ?? []).map((n) => [n.nutrient_code, n.amount_per_100g])) }]));
    for (const ref of loose) {
      const revision = revisions.get(ref.catalog_food_id as number);
      if (!revision) continue;
      const id = `catalog:${ref.catalog_food_id}`;
      out.push({ id, food: foodFor(id, revision.name, revision.per100g, roles.get(ref.id) ?? null),
        refs: { id, userRefId: null, catalogRefId: ref.id, userFoodId: null, catalogFoodId: ref.catalog_food_id } });
    }
  }
  return out;
}

/** Everything the v2 body is computed from (shared with snapshot v3, lib/server/meal-snapshot-v3.ts). */
export type SnapshotParts = {
  eligible: EligibleFoods;
  rows: SnapshotRow[];
  schedule: Awaited<ReturnType<typeof readMealSchedule>>;
  today: string;
  history: { scores: HistoryScores; watermark: string };
  facets: OccasionFacetEvidence;
  foods: Record<string, SnapshotFood>;
};

/** The reads and per-food entries of a v2 body, before its hash. */
export async function mealSnapshotParts(client: SupabaseClient, userId: string, now: Date = new Date(),
  deps: MealSnapshotDeps = {}): Promise<SnapshotParts> {
  const eligible = deps.eligible ?? await eligibleFoods(client, userId);
  const [rows, schedule, zone] = await Promise.all([
    snapshotFoods(client, userId, eligible), readMealSchedule(client, userId), readTimeZone(client, userId),
  ]);
  const today = localDate(zone, now);
  // A history read that fails (the occasion migration not yet applied, a transient error) leaves
  // the snapshot curated-only rather than failing the eligible read the phone depends on.
  const history = await historyAffinity(client, userId, rows.map((row) => row.refs), today)
    .catch((error: unknown) => {
      console.error("meal snapshot: history unavailable", { error: error instanceof Error ? error.message : "unknown" });
      return { scores: {} as HistoryScores, watermark: "unavailable" };
    });
  // `food_facets` is food-only and service-role only: occasionFacetEvidence opens the admin client
  // itself, and only while the calibration gate is open. It re-reads user foods under this account.
  const facets = await occasionFacetEvidence(null, userId, rows.flatMap((row): OccasionFacetFood[] => row.refs.userFoodId
    ? [{ id: row.id, kind: "user_food" as const, userFoodId: row.refs.userFoodId }]
    : row.refs.catalogFoodId !== null ? [{ id: row.id, kind: "catalog" as const, catalogFoodId: row.refs.catalogFoodId }]
      : []), deps.facets).catch(() => ABSTAIN);
  const foods: Record<string, SnapshotFood> = {};
  for (const row of rows) {
    const family = mealFamily(row.food.name);
    foods[row.id] = { userRefId: row.refs.userRefId, catalogRefId: row.refs.catalogRefId,
      parts: partsOf(row.food), occasion: occasionMap(row.food, history.scores[row.id], facets.scores[row.id]),
      family: family?.key ?? null };
  }
  return { eligible, rows, schedule, today, history, facets, foods };
}

/** The v2 body for one account. */
export async function mealSnapshot(client: SupabaseClient, userId: string, now: Date = new Date(),
  deps: MealSnapshotDeps = {}): Promise<SnapshotResponse> {
  const { eligible, schedule, today, history, facets, foods } = await mealSnapshotParts(client, userId, now, deps);
  const inputsHash = createHash("sha256").update(JSON.stringify({
    ranking: RANKING_VERSION, rules: eligible.rulesRevision, flags: eligible.preferenceFlags ? [...eligible.preferenceFlags].sort() : null,
    eats: [...eligible.eligibleRefIds].sort(),
    excluded: eligible.excluded.map((row) => `${row.refId}:${row.verdict}`).sort(),
    facets: facets.hashPart, history: history.watermark, today,
    // What each food is (name, role, nutrition → parts and family) changes the answer too.
    foods: Object.keys(foods).sort().map((id) => [id, foods[id]]),
    schedule: { ...schedule, slotTimes: Object.keys(schedule.slotTimes).sort()
      .map((slot) => [slot, schedule.slotTimes[slot]]) },
  })).digest("hex").slice(0, 32);
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, rankingVersion: RANKING_VERSION, accountId: userId,
    computedAt: now.toISOString(), inputsHash, foods, eligible };
}
