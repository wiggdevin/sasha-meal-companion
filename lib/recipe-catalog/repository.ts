import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type { CatalogRecipe, RecipeIngredient, RecipeSearch, RecipeSource } from "./types";
import { cuisineSearchPattern } from "./cuisine";

type Root = { id: string; slug: string; author: string; source_url: string | null;
  rights_kind: RecipeSource["rightsKind"]; rights_record: string; source_revision: string;
  kitchen_tested: boolean; current_revision_id: string | null;
  publication_state: CatalogRecipe["publicationState"]; withdrawal_reason: string | null };
type Revision = { id: string; recipe_id: string; name: string; cuisine: string | null;
  dish_tags: string[]; active_minutes: number | null; total_minutes: number | null;
  effort: CatalogRecipe["effort"]; servings: number; yield_grams: number | null;
  yield_status: CatalogRecipe["yieldStatus"]; min_serving_fraction: number;
  max_serving_fraction: number; nutrition_per_serving: CatalogRecipe["nutritionPerServing"] };
type Item = { recipe_revision_id: string; seq: number; name: string;
  food_ref_id: string | null; food_revision_id: number | null; food_db_id: string | null;
  quantity: number; unit: string; grams: number | null; state: RecipeIngredient["state"];
  required: boolean; purchase_grams: number | null;
  purchase_conversion_status: RecipeIngredient["purchaseConversionStatus"];
  nutrition: RecipeIngredient["nutrition"]; allergen_evidence: RecipeIngredient["allergenEvidence"] };
type Step = { recipe_revision_id: string; seq: number; instruction: string };

function failed(error: unknown): never {
  throw new HttpError(503, "recipe_catalog_unavailable", "Recipes are unavailable. Try again shortly.",
    { cause: error });
}

async function hydrate(client: SupabaseClient, revisions: Revision[],
  options: { pinned?: boolean } = {}): Promise<CatalogRecipe[]> {
  if (revisions.length === 0) return [];
  const ids = revisions.map((r) => r.id);
  const [rootsResult, itemsResult, stepsResult] = await Promise.all([
    client.from("recipe_catalog").select("id,slug,author,source_url,rights_kind,rights_record,source_revision,kitchen_tested,current_revision_id,publication_state,withdrawal_reason")
      .in("id", revisions.map((r) => r.recipe_id)),
    client.from("recipe_catalog_items").select("*").in("recipe_revision_id", ids).order("seq"),
    client.from("recipe_catalog_steps").select("*").in("recipe_revision_id", ids).order("seq"),
  ]);
  if (rootsResult.error || itemsResult.error || stepsResult.error) {
    failed(rootsResult.error ?? itemsResult.error ?? stepsResult.error);
  }
  const roots = new Map(((rootsResult.data ?? []) as Root[]).map((row) => [row.id, row]));
  const items = (itemsResult.data ?? []) as Item[];
  const steps = (stepsResult.data ?? []) as Step[];
  return revisions.flatMap((revision) => {
    const root = roots.get(revision.recipe_id);
    if (!root) return [];
    // A pinned read (an accepted plan's own revision) keeps a superseded or withdrawn revision:
    // the plan still holds those ingredients, so they are what the current rules must judge.
    if (!options.pinned
      && (root.publication_state !== "published" || root.current_revision_id !== revision.id)) return [];
    const ingredients = items.filter((row) => row.recipe_revision_id === revision.id)
      .sort((a, b) => a.seq - b.seq).map((row): RecipeIngredient => ({
        seq: row.seq, name: row.name, foodRefId: row.food_ref_id,
        catalogFoodRevisionId: row.food_revision_id, foodDbId: row.food_db_id,
        quantity: Number(row.quantity), unit: row.unit, grams: row.grams === null ? null : Number(row.grams),
        state: row.state, required: row.required,
        purchaseGrams: row.purchase_grams === null ? null : Number(row.purchase_grams),
        purchaseConversionStatus: row.purchase_conversion_status,
        nutrition: row.nutrition, allergenEvidence: row.allergen_evidence,
      }));
    const method = steps.filter((row) => row.recipe_revision_id === revision.id)
      .sort((a, b) => a.seq - b.seq).map((row) => ({ seq: row.seq, text: row.instruction }));
    // A published title without required ingredients and a method is an idea, not a recipe. A
    // pinned plan revision only needs its ingredients: those are what current rules judge.
    if (ingredients.length === 0 || (method.length === 0 && !options.pinned)) return [];
    return [{
      sourceKind: "shared" as const, recipeId: root.id, revisionId: revision.id,
      publicationState: root.publication_state, withdrawalReason: root.withdrawal_reason,
      name: revision.name, cuisine: revision.cuisine, dishTags: revision.dish_tags,
      activeMinutes: revision.active_minutes, totalMinutes: revision.total_minutes,
      effort: revision.effort, servings: Number(revision.servings),
      yieldGrams: revision.yield_grams === null ? null : Number(revision.yield_grams),
      yieldStatus: revision.yield_status,
      minServingFraction: Number(revision.min_serving_fraction),
      maxServingFraction: Number(revision.max_serving_fraction),
      ingredients, steps: method, nutritionPerServing: revision.nutrition_per_serving,
      source: { author: root.author, sourceUrl: root.source_url,
        rightsKind: root.rights_kind, rightsRecord: root.rights_record,
        sourceRevision: root.source_revision, kitchenTested: root.kitchen_tested },
    }];
  });
}

const PILOT_CAP = 64;
const PAGE = 25;

/**
 * The current revision of every published recipe (W038): the pilot cap counts these only, never a
 * superseded or withdrawn revision an accepted plan still pins. One extra row makes an over-cap
 * catalog an explicit error instead of hiding a feasible dish; any failed page fails the search.
 */
async function currentRevisionIds(client: SupabaseClient): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset <= PILOT_CAP; offset += PAGE) {
    const size = Math.min(PAGE, PILOT_CAP + 1 - offset);
    const result = await client.from("recipe_catalog").select("id,current_revision_id")
      .eq("publication_state", "published").not("current_revision_id", "is", null)
      .order("id").range(offset, offset + size - 1);
    if (result.error) failed(result.error);
    const rows = (result.data ?? []) as { current_revision_id: string | null }[];
    ids.push(...rows.flatMap((row) => row.current_revision_id ? [row.current_revision_id] : []));
    if (rows.length < size) break;
  }
  if (ids.length > PILOT_CAP) {
    throw new HttpError(503, "recipe_catalog_cap", "The recipe catalog exceeds the reviewed pilot limit.");
  }
  return ids;
}

/** Published, complete recipe content only. Caller must apply account eligibility before exposure. */
export async function searchCatalog(client: SupabaseClient, input: RecipeSearch): Promise<CatalogRecipe[]> {
  // Scan the whole bounded pilot before eligibility/ranking.
  // Query words are scored in memory (lib/recipes/candidates.ts) and never narrow the read: search
  // ranks, and only explicit filters remove a recipe (O4a review round 3).
  const currentIds = await currentRevisionIds(client);
  if (currentIds.length === 0) return [];
  const revisions: Revision[] = [];
  for (let offset = 0; offset < currentIds.length; offset += PAGE) {
    let query = client.from("recipe_catalog_revisions")
      .select("id,recipe_id,name,cuisine,dish_tags,active_minutes,total_minutes,effort,servings,yield_grams,yield_status,min_serving_fraction,max_serving_fraction,nutrition_per_serving")
      .in("id", currentIds).order("name").order("id").range(offset, offset + PAGE - 1);
    // A family contains match ("Italian" finds "Italian-inspired"); account policy and ingredient
    // eligibility still run on every row after this, so a wider match never widens what is shown.
    if (input.cuisine) query = query.ilike("cuisine", cuisineSearchPattern(input.cuisine));
    if (input.maxMinutes !== undefined) query = query.lte("total_minutes", input.maxMinutes);
    if (input.effort === "none") query = query.eq("effort", "none");
    if (input.effort === "minimal") query = query.in("effort", ["none", "minimal"]);
    const result = await query;
    if (result.error) failed(result.error);
    revisions.push(...(result.data ?? []) as Revision[]);
    if ((result.data ?? []).length < PAGE) break;
  }
  const recipes: CatalogRecipe[] = [];
  for (let offset = 0; offset < revisions.length; offset += PAGE) {
    recipes.push(...await hydrate(client, revisions.slice(offset, offset + PAGE)));
  }
  return recipes;
}

/**
 * The exact revisions accepted plans hold, whatever their publication state now. Only for judging
 * already-planned content against current rules; never for offering a recipe.
 */
export async function getPinnedRecipeRevisions(client: SupabaseClient,
  revisionIds: readonly string[]): Promise<CatalogRecipe[]> {
  const ids = [...new Set(revisionIds)];
  if (ids.length === 0) return [];
  const result = await client.from("recipe_catalog_revisions")
    .select("id,recipe_id,name,cuisine,dish_tags,active_minutes,total_minutes,effort,servings,yield_grams,yield_status,min_serving_fraction,max_serving_fraction,nutrition_per_serving")
    .in("id", ids);
  if (result.error) failed(result.error);
  return hydrate(client, (result.data ?? []) as Revision[], { pinned: true });
}

export async function getCatalogRecipe(client: SupabaseClient, id: string): Promise<CatalogRecipe | null> {
  const rootResult = await client.from("recipe_catalog")
    .select("id,publication_state,current_revision_id,withdrawal_reason")
    .eq("id", id).maybeSingle();
  if (rootResult.error) failed(rootResult.error);
  if (!rootResult.data) return null;
  if (rootResult.data.publication_state === "withdrawn") {
    throw new HttpError(410, "recipe_withdrawn", "This recipe is no longer available for new plans.");
  }
  if (rootResult.data.publication_state !== "published" || !rootResult.data.current_revision_id) return null;
  const result = await client.from("recipe_catalog_revisions")
    .select("id,recipe_id,name,cuisine,dish_tags,active_minutes,total_minutes,effort,servings,yield_grams,yield_status,min_serving_fraction,max_serving_fraction,nutrition_per_serving")
    .eq("id", rootResult.data.current_revision_id).maybeSingle();
  if (result.error) failed(result.error);
  return (await hydrate(client, result.data ? [result.data as Revision] : []))[0] ?? null;
}
