/**
 * Fixture catalog rows for the Phase 2 branch suites. Lane F's import is not a dependency: these
 * rows are inserted with the admin client and are enough to exercise snapshots, totals and
 * export. Nutrient codes and units match lib/nutrients/codes.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createChunks, stringToBase64URL } from "@supabase/ssr";

export type Fixture = {
  versionId: number; foodId: number; revisionId: number; foodRefId: string;
  per100g: Record<string, number | null>; description: string; versionLabel: string;
  source: string;
};

const NUTRIENTS = [
  { code: "energy_kcal", name: "Energy", unit: "kcal", derivation: "measured" },
  { code: "protein", name: "Protein", unit: "g", derivation: "measured" },
  { code: "carbohydrate", name: "Carbohydrate", unit: "g", derivation: "measured" },
  { code: "fat_total", name: "Total fat", unit: "g", derivation: "measured" },
  { code: "fiber_total", name: "Fiber", unit: "g", derivation: "measured" },
  { code: "sugars_total", name: "Sugars", unit: "g", derivation: "measured" },
  { code: "iron", name: "Iron", unit: "mg", derivation: "measured" },
  { code: "calcium", name: "Calcium", unit: "mg", derivation: "measured" },
  { code: "potassium", name: "Potassium", unit: "mg", derivation: "measured" },
  { code: "sodium", name: "Sodium", unit: "mg", derivation: "measured" },
  { code: "vitamin_d", name: "Vitamin D", unit: "µg", derivation: "measured" },
];

export async function seedNutrients(admin: SupabaseClient): Promise<void> {
  const { error } = await admin.from("catalog_nutrients").upsert(NUTRIENTS, { onConflict: "code" });
  if (error) throw error;
}

/** One active catalog food with the given per-100 g values, plus its food_refs row. */
export async function seedCatalogFood(admin: SupabaseClient, userId: string, args: {
  sourceId: string; description: string; brand?: string | null; source?: string;
  versionLabel?: string; per100g: Record<string, number | null>;
  portions?: { description: string; gram_weight: number; is_default: boolean; seq: number }[];
  /** contracts §9a(d): a food whose one ingredient row carries these tags is the allergen
   *  evidence applyLogEntry's constraint policy reads at commit time. */
  allergenTags?: string[];
}): Promise<Fixture> {
  await seedNutrients(admin);
  // Default source is "fdc_branded", not "fdc_sr_legacy": on a branch that already carries a real
  // catalog import (integration's reused p1-catalog branch), every real fdc_* source except
  // fdc_branded already has an active catalog_versions row, and this upsert would otherwise
  // collide with catalog_versions_one_active_per_source. fdc_branded stays free until Phase 3.
  const source = args.source ?? "fdc_branded";
  const versionLabel = args.versionLabel ?? "test-1";

  const version = await admin.from("catalog_versions")
    .upsert({ source, version_label: versionLabel, is_active: true },
      { onConflict: "source,version_label" }).select("id").single();
  if (version.error) throw version.error;

  const food = await admin.from("catalog_foods")
    .upsert({ source, source_id: args.sourceId }, { onConflict: "source,source_id" })
    .select("id").single();
  if (food.error) throw food.error;

  const searchDoc = await admin.rpc("catalog_search_doc", {
    p_description: args.description,
    p_brand: args.brand ?? null,
    p_category: null,
  });
  if (searchDoc.error) throw searchDoc.error;

  const revision = await admin.from("catalog_food_revisions").upsert({
    description: args.description, brand: args.brand ?? null, catalog_food_id: food.data.id,
    catalog_version_id: version.data.id, quality_class: "analytical",
    search_doc: searchDoc.data, content_hash: `h-${args.sourceId}`, is_active: true,
  }, { onConflict: "catalog_food_id,catalog_version_id" }).select("id").single();
  if (revision.error) throw revision.error;

  const rows = Object.entries(args.per100g).map(([nutrient_code, amount_per_100g]) => ({
    food_revision_id: revision.data.id, nutrient_code, amount_per_100g }));
  const nutrients = await admin.from("catalog_food_nutrients")
    .upsert(rows, { onConflict: "food_revision_id,nutrient_code" });
  if (nutrients.error) throw nutrients.error;

  if (args.portions?.length) {
    const p = await admin.from("catalog_portions")
      .insert(args.portions.map((x) => ({ ...x, food_revision_id: revision.data.id })));
    if (p.error) throw p.error;
  }

  if (args.allergenTags?.length) {
    const i = await admin.from("catalog_ingredients").upsert({
      food_revision_id: revision.data.id, seq: 0, name: args.description,
      allergen_tags: args.allergenTags,
    }, { onConflict: "food_revision_id,seq" });
    if (i.error) throw i.error;
  }

  const ref = await admin.rpc("get_or_create_food_ref", { p_user_id: userId, p_kind: "catalog",
    p_catalog_food_id: food.data.id, p_user_food_id: null });
  if (ref.error) throw ref.error;

  return { versionId: version.data.id, foodId: food.data.id, revisionId: revision.data.id,
    foodRefId: ref.data as string, per100g: args.per100g, description: args.description,
    versionLabel, source };
}

/**
 * Removes every fixture food this file seeded under `sourceIdPrefix` (e.g. "commit-") with the
 * rows that hang off it. Call it from
 * afterAll in every suite that calls seedCatalogFood: the seed upserts ACTIVE catalog rows, so on
 * a branch that carries a real import (integration's reused p1-catalog) a suite that never tears
 * down leaves synthetic rows competing with real FDC data in catalog_search — that is exactly what
 * skewed the AC8 relevance run on 2026-09-11, twice. The prefix scope keeps sibling suites' rows
 * untouched; the same query cleans up after a crashed run by hand.
 */
export async function dropCatalogFoods(admin: SupabaseClient, sourceIdPrefix: string,
  source = "fdc_branded"): Promise<void> {
  const foods = await admin.from("catalog_foods").select("id")
    .eq("source", source).like("source_id", `${sourceIdPrefix}%`);
  if (foods.error) throw foods.error;
  const foodIds = (foods.data ?? []).map((f) => (f as { id: number }).id);
  if (foodIds.length === 0) return;

  const refs = await admin.from("food_refs").select("id").in("catalog_food_id", foodIds);
  if (refs.error) throw refs.error;
  const refIds = (refs.data ?? []).map((r) => (r as { id: string }).id);

  // Children first: every FK below is NO ACTION (supabase/migrations/20260911000200_user_schema.sql).
  if (refIds.length > 0) {
    for (const table of ["log_items", "user_food_prefs", "favorites_foods", "favorites_meal_items",
      "recipe_items"]) {
      const { error } = await admin.from(table).delete().in("food_ref_id", refIds);
      if (error) throw error;
    }
    const { error } = await admin.from("food_refs").delete().in("id", refIds);
    if (error) throw error;
  }
  // Revisions cascade to catalog_food_nutrients and catalog_portions.
  const revisions = await admin.from("catalog_food_revisions").delete().in("catalog_food_id", foodIds);
  if (revisions.error) throw revisions.error;
  const dropped = await admin.from("catalog_foods").delete().in("id", foodIds);
  if (dropped.error) throw dropped.error;
  // The shared "test-1" catalog_versions row is left in place on purpose: suites run in parallel
  // by default, so a check-then-delete here could remove it between a sibling's version upsert
  // and its revision insert. A version row with no revisions is inert — catalog_search reads
  // catalog_food_revisions — and the next seed upserts the same row.
}

/** One of her own foods, so the user_vals branch of compute_item_snapshot is exercised too. */
export async function seedUserFood(admin: SupabaseClient, userId: string, args: {
  name: string; per100g: Record<string, number | null>;
}): Promise<Fixture> {
  await seedNutrients(admin);
  const food = await admin.from("user_foods").insert({ user_id: userId, name: args.name,
    kind: "custom", per_100g: args.per100g }).select("id, rev").single();
  if (food.error) throw food.error;
  const ref = await admin.rpc("get_or_create_food_ref", { p_user_id: userId, p_kind: "user",
    p_catalog_food_id: null, p_user_food_id: food.data.id });
  if (ref.error) throw ref.error;
  return { versionId: 0, foodId: 0, revisionId: 0, foodRefId: ref.data as string,
    per100g: args.per100g, description: args.name, versionLabel: String(food.data.rev),
    source: "user" };
}

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * requireUser reads the session from the Cookie header only (lib/supabase/server.ts). Build it
 * the way @supabase/ssr writes it — see tests/export/cross-user.test.ts (Phase 0).
 */
export async function sessionCookieFor(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error("no session");
  const ref = new URL(process.env.SUPABASE_TEST_URL ?? "https://ref.supabase.co").hostname.split(".")[0];
  const value = `base64-${stringToBase64URL(JSON.stringify(data.session))}`;
  return createChunks(`sb-${ref}-auth-token`, value).map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
}

export function pointRequestClientAtBranch(): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_TEST_ANON_KEY;
}
