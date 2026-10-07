/**
 * The commit path's own policy evidence, read through RLS and batched: one query per table rather
 * than one per item. Split out of lib/server/log.ts (its 380-line budget, T9 §2) when the stored
 * user food's name and ingredient text joined its tags (sol BLOCK, t2b review).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LogItemInput } from "@/lib/log/contract";
import type { PolicyEvidence } from "@/lib/policy/constraints";
import { labelPolicyEvidence, LABEL_FOOD_PLACEHOLDER_REF, type LabelFoodInput } from "@/lib/server/log-label-food";
import { fetchAllChunked } from "@/lib/server/paged-read";

/** A revision with no catalog_ingredients row has NO allergen evidence — `null`, not `[]`. */
async function allergenTagsByRevision(
  client: SupabaseClient, revisionIds: number[]
): Promise<Map<number, string[]>> {
  const byRevision = new Map<number, string[]>();
  if (revisionIds.length === 0) return byRevision;
  // t18: a revision holds one row per ingredient, so a multi-item log can pass the API row cap.
  // Paged by primary key (food_revision_id, seq); any failed page throws, never a partial map.
  const rows = await fetchAllChunked<number, { food_revision_id: number;
    allergen_tags: string[] | null }>(revisionIds, (batch, from, to) =>
    client.from("catalog_ingredients").select("food_revision_id, allergen_tags")
      .in("food_revision_id", batch).order("food_revision_id").order("seq").range(from, to));
  for (const row of rows) {
    const tags = byRevision.get(row.food_revision_id) ?? [];
    byRevision.set(row.food_revision_id, [...tags, ...(row.allergen_tags ?? [])]);
  }
  return byRevision;
}

type RefRow = { kind: string; user_food_id: string | null; catalog_food_id: number | null };

async function refsById(client: SupabaseClient, ids: string[]): Promise<Map<string, RefRow>> {
  const byId = new Map<string, RefRow>();
  if (ids.length === 0) return byId;
  const { data, error } = await client.from("food_refs")
    .select("id, kind, user_food_id, catalog_food_id").in("id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as ({ id: string } & RefRow)[]) {
    byId.set(row.id, { kind: row.kind, user_food_id: row.user_food_id,
      catalog_food_id: row.catalog_food_id });
  }
  return byId;
}

/** A catalog item that names its food_ref but pins no revision is judged on the food's ACTIVE
 *  revisions — otherwise a client could skip the policy by dropping food_revision_id. Exported so
 *  lib/coach/suggest-policy.ts resolves the same unpinned items to the same revision. */
export async function activeRevisionsByFood(
  client: SupabaseClient, catalogFoodIds: number[]
): Promise<Map<number, number[]>> {
  const byFood = new Map<number, number[]>();
  if (catalogFoodIds.length === 0) return byFood;
  // t18 r5: an Eats list can name more than 1,000 foods; paged and chunked, any failed page throws.
  const rows = await fetchAllChunked<number, { id: number; catalog_food_id: number }>(catalogFoodIds,
    (ids, from, to) => client.from("catalog_food_revisions").select("id, catalog_food_id")
      .eq("is_active", true).in("catalog_food_id", ids).order("id").range(from, to));
  for (const row of rows) {
    byFood.set(row.catalog_food_id, [...(byFood.get(row.catalog_food_id) ?? []), row.id]);
  }
  return byFood;
}

type UserFoodEvidence = {
  allergenTags: string[]; foodName: string | null;
  ingredientsText: string | null; ingredientsTextIsLabel: boolean;
  /** 2026-10-02 DeepSeek audit (F2, MED): the stored food's own brand, when it has one. */
  foodBrand: string | null;
};

/**
 * The stored user food's tags AND the fields §9 R1's tuna rule reads: its name and ingredient
 * text, the latter a genuine printed label only on a "label_scan" row (§9 R2, the same test
 * lib/coach/suggest-policy.ts and lib/server/coach-ports.ts apply). sol BLOCK (t2b review): tags
 * alone let an idempotent retry of a stored "Canned tuna" label lose its mark whenever
 * loadSuggestionEvidence was unavailable.
 */
async function userFoodEvidence(
  client: SupabaseClient, userFoodIds: string[]
): Promise<Map<string, UserFoodEvidence>> {
  const byId = new Map<string, UserFoodEvidence>();
  if (userFoodIds.length === 0) return byId;
  const { data, error } = await client.from("user_foods")
    .select("id, name, brand, kind, ingredients_text, allergen_tags").in("id", userFoodIds);
  if (error) throw error;
  for (const row of (data ?? []) as { id: string; name: string | null; brand: string | null;
    kind: string | null; ingredients_text: string | null; allergen_tags: string[] | null }[]) {
    byId.set(row.id, { allergenTags: row.allergen_tags ?? [], foodName: row.name ?? null,
      ingredientsText: row.ingredients_text ?? null,
      ingredientsTextIsLabel: row.kind === "label_scan", foodBrand: row.brand ?? null });
  }
  return byId;
}

/** Their own marks for the refs about to be logged, in one query. RLS scopes it to the caller. */
async function prefStatusByRef(
  client: SupabaseClient, refIds: string[]
): Promise<Map<string, "eats" | "avoid">> {
  const byRef = new Map<string, "eats" | "avoid">();
  if (refIds.length === 0) return byRef;
  const { data, error } = await client.from("user_food_prefs")
    .select("food_ref_id, status").in("food_ref_id", refIds);
  if (error) throw error;
  for (const row of (data ?? []) as { food_ref_id: string; status: "eats" | "avoid" }[]) {
    byRef.set(row.food_ref_id, row.status);
  }
  return byRef;
}

/**
 * Evidence for every item, batched: one query per table rather than one per item. A placeholder
 * label item reads the label body's own tags (unioned with anything the ingredients text names) —
 * evaluated before commitLabelFood ever inserts, so a blocked label never creates a user_foods row.
 *
 * `category` is not evidence the commit path has (it pins no revision for an unpinned item, and
 * the array lives on the revision). Their Eats/Avoid mark IS, since T1: the commit reads
 * `user_food_prefs` for every real ref, so an avoid-listed item comes back in `flagged`. It is
 * still never refused — docs/decisions/2026-09-14-logging-marks-never-refuses.md.
 */
export async function evidenceForItems(
  client: SupabaseClient, items: LogItemInput[], label: LabelFoodInput | null
): Promise<PolicyEvidence[]> {
  const real = items.filter((i) => i.food_ref_id !== LABEL_FOOD_PLACEHOLDER_REF);
  const pinned = [...new Set(real.filter((i) => i.food_revision_id != null)
    .map((i) => i.food_revision_id as number))];
  const refs = await refsById(client,
    [...new Set(real.filter((i) => i.food_revision_id == null).map((i) => i.food_ref_id))]);
  const refRows = [...refs.values()];
  const activeByFood = await activeRevisionsByFood(client, [...new Set(refRows
    .filter((r) => r.kind === "catalog" && r.catalog_food_id != null)
    .map((r) => r.catalog_food_id as number))]);
  const [tagsByRevision, byUserFood] = await Promise.all([
    allergenTagsByRevision(client, [...new Set([...pinned, ...[...activeByFood.values()].flat()])]),
    userFoodEvidence(client, [...new Set(refRows
      .filter((r) => r.kind === "user" && r.user_food_id != null)
      .map((r) => r.user_food_id as string))]),
  ]);
  const fromLabel = label ? labelPolicyEvidence(label) : { allergenTags: null };
  const prefs = await prefStatusByRef(client, [...new Set(real.map((i) => i.food_ref_id))]);

  /** null = no evidence at all; [] only when a row exists and names no allergen. */
  function tagsForRef(ref: RefRow | undefined): string[] | null {
    if (ref?.kind === "user" && ref.user_food_id) {
      return byUserFood.get(ref.user_food_id)?.allergenTags ?? null;
    }
    if (ref?.kind === "catalog" && ref.catalog_food_id != null) {
      const found = (activeByFood.get(ref.catalog_food_id) ?? [])
        .map((id) => tagsByRevision.get(id)).filter((t): t is string[] => t !== undefined);
      return found.length === 0 ? null : [...new Set(found.flat())];
    }
    return null;
  }

  return items.map((item) => {
    const pref = prefs.get(item.food_ref_id) ?? null;
    const base = { foodRefId: item.food_ref_id, category: null,
      onEatsList: pref === "eats", onAvoidList: pref === "avoid" };
    if (item.food_ref_id === LABEL_FOOD_PLACEHOLDER_REF) return { ...base, ...fromLabel };
    if (item.food_revision_id != null) {
      return { ...base, allergenTags: tagsByRevision.get(item.food_revision_id) ?? null };
    }
    const ref = refs.get(item.food_ref_id);
    const own = ref?.kind === "user" && ref.user_food_id ? byUserFood.get(ref.user_food_id) : undefined;
    return { ...base, allergenTags: tagsForRef(ref),
      ...(own ? { foodName: own.foodName, ingredientsText: own.ingredientsText,
        ingredientsTextIsLabel: own.ingredientsTextIsLabel,
        // 2026-10-02 DeepSeek audit (F2, MED): packaged by the same "label_scan" test as
        // `ingredientsTextIsLabel` above — a stored user food is packaged iff it came from a
        // label scan, whatever its own `brand` string reads (a blank brand is still packaged).
        foodBrand: own.foodBrand, packaged: own.ingredientsTextIsLabel } : {}) };
  });
}
