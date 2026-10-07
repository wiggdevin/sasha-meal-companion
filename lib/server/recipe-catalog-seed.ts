/** Privileged ingestion of original pilot content. Never imported by a user request route. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FOOD_DB } from "@/lib/food-db";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { RECIPE_MACROS, type CatalogRecipe } from "@/lib/recipe-catalog/types";
import type { RecipeIngredient } from "@/lib/recipe-catalog/types";
import { pilotSrLegacySource } from "@/lib/recipe-catalog/pilot-sr-legacy";
import { resolvePilotCatalogRevisions, type PilotCatalogIdentity }
  from "@/lib/server/recipe-pilot-identity";

const FOOD_BY_ID = new Map(FOOD_DB.map((food) => [food.id, food]));
const PILOT_REVISION = "original-pilot-v1";

export type PilotManifest = { recipes: number; ingredientLines: number; foodDbIds: number; steps: number };

/** Fail before any database request if the reviewed source bundle has drifted. */
export function pilotManifest(recipes: CatalogRecipe[] = pilotRecipes()): PilotManifest {
  const slugs = new Set<string>();
  const foodIds = new Set<string>();
  let ingredientLines = 0;
  let steps = 0;
  for (const recipe of recipes) {
    if (slugs.has(recipe.recipeId)) throw new Error("Pilot manifest has a duplicate slug");
    slugs.add(recipe.recipeId);
    const source = recipe.source;
    if (source.rightsKind !== "original" || source.author !== "Meal Companion"
      || source.sourceUrl !== null || source.sourceRevision !== PILOT_REVISION
      || source.kitchenTested !== false || !source.rightsRecord.includes("Not kitchen-tested")) {
      throw new Error(`Pilot provenance failed for ${recipe.recipeId}`);
    }
    if (recipe.ingredients.length === 0 || recipe.steps.length === 0) {
      throw new Error(`Pilot content incomplete for ${recipe.recipeId}`);
    }
    ingredientLines += recipe.ingredients.length;
    steps += recipe.steps.length;
    for (const line of recipe.ingredients) {
      const id = line.foodDbId;
      const food = FOOD_BY_ID.get(id ?? "");
      if (!id || !food || food.sr.startsWith("label:") || !pilotSrLegacySource(id)) {
        throw new Error(`Pilot food provenance failed for ${recipe.recipeId}`);
      }
      foodIds.add(id);
      if (RECIPE_MACROS.some((key) => line.nutrition[key]?.status !== "estimated"
        || line.nutrition[key]?.sourceKey !== `food-db:${id}`)) {
        throw new Error(`Pilot ingredient nutrition provenance failed for ${recipe.recipeId}`);
      }
    }
    if (RECIPE_MACROS.some((key) => recipe.nutritionPerServing[key]?.status !== "estimated"
      || recipe.nutritionPerServing[key]?.sourceKey !== `${PILOT_REVISION}:food-db.json`)) {
      throw new Error(`Pilot serving nutrition provenance failed for ${recipe.recipeId}`);
    }
  }
  const manifest = { recipes: recipes.length, ingredientLines, foodDbIds: foodIds.size, steps };
  if (manifest.recipes !== 24 || manifest.ingredientLines !== 119 || manifest.foodDbIds !== 30) {
    throw new Error("Pilot source counts differ from docs/recipes/pilot-source-rights.md");
  }
  return manifest;
}

export type SeedPreflight = { manifest: PilotManifest; toCreate: number; skipped: number };

/** Read-only. Drafts require a separate diagnosis because inserts are immutable. */
export async function preflightPilotCatalog(client: SupabaseClient): Promise<SeedPreflight> {
  const recipes = pilotRecipes();
  const manifest = pilotManifest(recipes);
  let toCreate = 0;
  let skipped = 0;
  for (const recipe of recipes) {
    const existing = await client.from("recipe_catalog")
      .select("id,publication_state,author,source_url,rights_kind,rights_record,source_revision,kitchen_tested,current_revision_id")
      .eq("slug", recipe.recipeId).maybeSingle();
    if (existing.error) throw new Error(`Preflight lookup failed for ${recipe.recipeId}`);
    if (!existing.data) { toCreate += 1; continue; }
    if (existing.data.publication_state === "draft") {
      const revisions = await client.from("recipe_catalog_revisions").select("id,rev")
        .eq("recipe_id", existing.data.id);
      if (revisions.error) throw new Error(`Draft revision lookup failed for ${recipe.recipeId}`);
      const first = (revisions.data ?? []).find((row) => row.rev === 1);
      let itemCount = 0;
      let stepCount = 0;
      if (first) {
        const items = await client.from("recipe_catalog_items").select("seq")
          .eq("recipe_revision_id", first.id);
        const steps = await client.from("recipe_catalog_steps").select("seq")
          .eq("recipe_revision_id", first.id);
        if (items.error || steps.error) throw new Error(`Draft content lookup failed for ${recipe.recipeId}`);
        itemCount = items.data?.length ?? 0;
        stepCount = steps.data?.length ?? 0;
      }
      const source = recipe.source;
      const provenanceMatches = existing.data.author === source.author
        && existing.data.source_url === source.sourceUrl
        && existing.data.rights_kind === source.rightsKind
        && existing.data.rights_record === source.rightsRecord
        && existing.data.source_revision === source.sourceRevision
        && existing.data.kitchen_tested === source.kitchenTested;
      throw new Error(`Unpublished pilot draft at ${recipe.recipeId}: provenance ${provenanceMatches ? "matches" : "differs"}, ${revisions.data?.length ?? 0} revisions, ${itemCount}/${recipe.ingredients.length} items, ${stepCount}/${recipe.steps.length} steps. Stop for reviewed recovery; preflight made no writes.`);
    }
    if (!["published", "withdrawn", "superseded"].includes(existing.data.publication_state)) {
      throw new Error(`Unexpected pilot state at ${recipe.recipeId}; stop for review.`);
    }
    skipped += 1;
  }
  return { manifest, toCreate, skipped };
}


async function resolveCatalogIdentity(client: SupabaseClient, ingredient: RecipeIngredient,
  identities: ReadonlyMap<string, PilotCatalogIdentity>):
  Promise<{ foodRefId: string | null; revisionId: number | null }> {
  const revision = identities.get(ingredient.foodDbId ?? "");
  if (!revision) return { foodRefId: null, revisionId: null };
  const refs = await client.from("food_refs").select("id")
    .eq("kind", "catalog").eq("catalog_food_id", revision.catalogFoodId).limit(2);
  if (refs.error) throw new Error("Food reference lookup failed");
  if (refs.data?.length !== 1) return { foodRefId: null, revisionId: null };
  return { foodRefId: refs.data[0].id, revisionId: revision.revisionId };
}

/** A replay skips published/withdrawn history and diagnoses partial drafts. */
export async function seedPilotCatalog(client: SupabaseClient): Promise<{ created: number; skipped: number }> {
  await preflightPilotCatalog(client);
  const foodDbIds = pilotRecipes().flatMap((recipe) => recipe.ingredients.map((line) => line.foodDbId))
    .filter((id): id is string => id !== null);
  const identities = await resolvePilotCatalogRevisions(client, foodDbIds);
  let created = 0;
  let skipped = 0;
  for (const recipe of pilotRecipes()) {
    const existing = await client.from("recipe_catalog").select("id,publication_state")
      .eq("slug", recipe.recipeId).maybeSingle();
    if (existing.error) throw new Error(`Seed lookup failed for ${recipe.recipeId}`);
    if (existing.data) {
      if (existing.data.publication_state === "draft") {
        throw new Error(`Incomplete or unpublished pilot draft at ${recipe.recipeId}; stop for reviewed recovery.`);
      }
      skipped += 1; continue;
    }
    const root = await client.from("recipe_catalog").insert({
      slug: recipe.recipeId, author: recipe.source.author, source_url: recipe.source.sourceUrl,
      rights_kind: recipe.source.rightsKind, rights_record: recipe.source.rightsRecord,
      source_revision: recipe.source.sourceRevision, kitchen_tested: recipe.source.kitchenTested,
      publication_state: "draft",
    }).select("id").single();
    if (root.error || !root.data) throw new Error(`Could not create pilot root for ${recipe.recipeId}; rerun preflight before retrying`);
    const revision = await client.from("recipe_catalog_revisions").insert({
      recipe_id: root.data.id, rev: 1, name: recipe.name, cuisine: recipe.cuisine,
      dish_tags: recipe.dishTags, active_minutes: recipe.activeMinutes,
      total_minutes: recipe.totalMinutes, effort: recipe.effort, servings: recipe.servings,
      yield_grams: recipe.yieldGrams, yield_status: recipe.yieldStatus,
      min_serving_fraction: recipe.minServingFraction,
      max_serving_fraction: recipe.maxServingFraction,
      nutrition_per_serving: recipe.nutritionPerServing,
    }).select("id").single();
    if (revision.error || !revision.data) throw new Error(`Could not create pilot revision for ${recipe.recipeId}; rerun preflight before retrying`);
    const items = [];
    for (const line of recipe.ingredients) {
      const mapped = await resolveCatalogIdentity(client, line, identities);
      items.push({ recipe_revision_id: revision.data.id, seq: line.seq, name: line.name,
        food_ref_id: mapped.foodRefId, food_revision_id: mapped.revisionId,
        food_db_id: line.foodDbId, quantity: line.quantity, unit: line.unit,
        grams: line.grams, state: line.state, required: line.required,
        purchase_grams: line.purchaseGrams,
        purchase_conversion_status: line.purchaseConversionStatus,
        nutrition: line.nutrition, allergen_evidence: line.allergenEvidence });
    }
    const itemResult = await client.from("recipe_catalog_items").insert(items);
    if (itemResult.error) throw new Error(`Could not create pilot items for ${recipe.recipeId}; rerun preflight before retrying`);
    const stepResult = await client.from("recipe_catalog_steps").insert(recipe.steps.map((step) => ({
      recipe_revision_id: revision.data.id, seq: step.seq, instruction: step.text,
    })));
    if (stepResult.error) throw new Error(`Could not create pilot steps for ${recipe.recipeId}; rerun preflight before retrying`);
    const publish = await client.from("recipe_catalog")
      .update({ current_revision_id: revision.data.id, publication_state: "published" })
      .eq("id", root.data.id).eq("publication_state", "draft").select("id").single();
    if (publish.error || !publish.data) throw new Error(`Could not publish ${recipe.recipeId}; rerun preflight before retrying`);
    created += 1;
  }
  return { created, skipped };
}
