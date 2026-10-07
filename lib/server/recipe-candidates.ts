import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPackagedCatalogSource, policyCategoriesFor } from "@/lib/catalog/category-map";
import { getCatalogRecipe, getPinnedRecipeRevisions, searchCatalog } from "@/lib/recipe-catalog/repository";
import type {
  CatalogRecipe, RecipeCandidate, RecipeEligibility, RecipeSearch,
} from "@/lib/recipe-catalog/types";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import {
  recipeEligibility, withRecipeEligibility, type RecipeEligibilityInput,
} from "@/lib/recipes/eligibility";
import type { RuleMark } from "@/lib/types";
import { normalizePreferenceFlags } from "@/lib/profile/onboarding-state";

import { HttpError } from "@/lib/server/auth";
import { readAllergenChecks, readAllergenEvidence } from "@/lib/server/allergen-evidence";
import { getRuleReviewStatus } from "@/lib/server/constraints";
import { readAvoidList } from "@/lib/server/avoid-list";
import { readPolicyProfile } from "@/lib/server/policy-profile";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import { EMPTY_PROFILE, type PolicyEvidence } from "@/lib/policy/constraints";
import { avoidFoodDbIds } from "@/lib/recipe-catalog/avoid-food-db";
import { catalogWarmFood, type CatalogWarmRow } from "@/lib/foods/catalog-ingredients";
import { facetCacheKey, readFacets } from "@/lib/foods/facets";
import { foodKey, inputHash } from "@/lib/foods/facet-keys";
import { FOOD_DB } from "@/lib/food-db";
import { resolvePilotCatalogRevisions } from "@/lib/server/recipe-pilot-identity";

/**
 * One normalization everywhere (round 4 BLOCK 1): recipes are judged with exactly the flags the
 * selection GET publishes and the eligible-food path evaluates (`no_nuts` reads as `no_peanuts`,
 * an unknown flag is dropped).
 */
export function recipeFlagsFrom(dietPrefs: unknown): PolicyPreferenceFlag[] {
  const raw = (dietPrefs as { flags?: unknown } | null | undefined)?.flags;
  return normalizePreferenceFlags(Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string") : []) as PolicyPreferenceFlag[];
}

/** The marks, plus the normalized diet flags they were judged under (absent when unread). */
export type SelectionRuleMarks = Map<string, RuleMark | null> & { preferenceFlags?: string[] };

type Revision = CatalogWarmRow & { catalog_food_id: number;
  policy_categories: string[] | null;
  catalog_foods?: { source: string | null } | { source: string | null }[] | null };

/** The revision's catalog source; an array-shaped embed is tolerated like suggest-policy's. */
function revisionSource(row: Revision): string | null {
  const value = row.catalog_foods;
  const food = Array.isArray(value) ? value[0] ?? null : value ?? null;
  return food?.source ?? null;
}

const FOOD_BY_ID = new Map(FOOD_DB.map((food) => [food.id, food]));

export type AccountRecipeCandidates = {
  candidates: RecipeCandidate[];
  noResultReasons: string[];
  /** False when no recipe carries every query word: the list is the closest recipes. */
  exactMatch: boolean;
  /** Hash of account rules, active flags, Avoids and ingredient evidence at read time. */
  rulesFingerprint: string;
  /** The normalized diet flags every candidate was judged under (same as the selection GET's). */
  preferenceFlags: string[];
};

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function check(error: { message: string } | null): void {
  if (error) throw new HttpError(503, "recipe_policy_unavailable",
    "Your food rules could not be checked. Try again shortly.", { cause: error });
}

/**
 * The complete Avoid list (t18, 2026-10-05): paged past the API row cap, and a failed page is
 * an unread rule set (503), never a shorter list.
 */
async function readAvoid(client: SupabaseClient, userId: string) {
  try { return await readAvoidList(client, userId); }
  catch (cause) { throw new HttpError(503, "recipe_policy_unavailable",
    "Your food rules could not be checked. Try again shortly.", { cause }); }
}

async function revisionEvidence(client: SupabaseClient, userId: string,
  recipes: readonly CatalogRecipe[]): Promise<{ byRevision: Map<number, Partial<PolicyEvidence>>;
    mappedDb: Map<string, number> }> {
  const ids = [...new Set(recipes.flatMap((recipe) => recipe.ingredients)
    .map((item) => item.catalogFoodRevisionId)
    .filter((id): id is number => id !== null))];
  const out = new Map<number, Partial<PolicyEvidence>>();
  const dbIds = [...new Set(recipes.flatMap((recipe) => recipe.ingredients)
    .filter((item) => item.catalogFoodRevisionId === null && item.foodDbId)
    .map((item) => item.foodDbId as string))];
  let sourceMapped: Awaited<ReturnType<typeof resolvePilotCatalogRevisions>>;
  try { sourceMapped = await resolvePilotCatalogRevisions(client, dbIds); }
  catch (cause) { throw new HttpError(503, "recipe_policy_unavailable",
    "Your food rules could not be checked. Try again shortly.", { cause }); }
  const mappedDb = new Map([...sourceMapped].map(([id, identity]) => [id, identity.revisionId]));
  const allIds = [...new Set([...ids, ...mappedDb.values()])];
  if (allIds.length === 0) return { byRevision: out, mappedDb };
  const keys = allIds.map((id) => `catalog_revision:${id}`);
  const [rows, stored, checked] = await Promise.all([
    client.from("catalog_food_revisions")
      .select("id,catalog_food_id,description,brand,category,prep_state,policy_categories,catalog_ingredients(seq,name,raw_text,allergen_tags),catalog_portions(seq,description,is_default),catalog_foods(source)").in("id", allIds),
    readAllergenEvidence(client, keys),
    readAllergenChecks(client, userId, keys),
  ]);
  check(rows.error);
  const warm = ((rows.data ?? []) as unknown as Revision[]).map(catalogWarmFood);
  const warmById = new Map(warm.map((food) => [food.identity.id, food]));
  const facetKeys = warm.map((food) => ({ foodKey: foodKey(food.identity), inputHash: inputHash({
    name: food.name, brand: food.brand, description: food.category,
    preparation: food.serving, ingredientsText: food.ingredientsText,
  }) }));
  const facets = await readFacets(facetKeys);
  // Both reads degrade to empty on failure; a failed one means the rules were not fully read,
  // so no fingerprint or proof is made from it (the marked loaders turn this into unknown).
  if (checked.failed || facets.errors > 0) {
    throw new HttpError(503, "recipe_policy_unavailable",
      "Your food rules could not be checked. Try again shortly.");
  }
  for (const row of (rows.data ?? []) as Revision[]) {
    const key = `catalog_revision:${row.id}`;
    const facetKey = facetKeys.find((item) => item.foodKey === key);
    const food = warmById.get(row.id);
    out.set(row.id, {
      category: row.policy_categories ?? policyCategoriesFor({ description: row.description,
        category: row.category }),
      foodName: row.description,
      // Phase 18 W2a (review r1 BLOCK 1): the identity the whole-food clearance needs. A branded
      // or packaged catalog row is never cleared as a plain whole food.
      foodBrand: row.brand ?? null,
      packaged: isPackagedCatalogSource(revisionSource(row)),
      ingredientsText: food?.ingredientsText ?? null,
      // A joined catalog ingredient list can prove presence, never absence on a product label.
      ingredientsTextIsLabel: food?.labelComplete === true,
      allergenTags: food?.allergenTags ?? [],
      allergenEvidence: stored.get(key) ?? {}, checkedAllergens: checked.get(key) ?? [],
      ...(facetKey && facets.has(facetCacheKey(facetKey))
        ? { facets: facets.get(facetCacheKey(facetKey)) } : {}),
    });
  }
  return { byRevision: out, mappedDb };
}

async function accountContext(client: SupabaseClient, userId: string,
  recipes: readonly CatalogRecipe[], asOf: Date) {
  const review = await getRuleReviewStatus(client, userId);
  if (review.required) throw new HttpError(409, "rule_review_required",
    "Review your existing food rules before getting recipe suggestions.");
  const [policy, avoid, stars, foodStars, settings, evidence] = await Promise.all([
    readPolicyProfile(client, userId, asOf),
    readAvoid(client, userId),
    client.from("favorites_catalog_recipes").select("recipe_id")
      .eq("user_id", userId).is("deleted_at", null),
    client.from("favorites_foods").select("food_ref_id")
      .eq("user_id", userId).is("deleted_at", null),
    client.from("user_settings").select("diet_prefs,rev")
      .eq("user_id", userId).maybeSingle(),
    revisionEvidence(client, userId, recipes),
  ]);
  for (const result of [stars, foodStars, settings]) check(result.error);
  const { refIds: avoidIds, names } = avoid;
  const foodDbIds = avoidFoodDbIds(names);
  const flags = recipeFlagsFrom(settings.data?.diet_prefs);
  const forRecipe = (recipe: CatalogRecipe): RecipeEligibilityInput => ({
    profile: policy.profile, explicitAvoidFoodRefIds: avoidIds,
    // B's eligibility implementation also checks the bundled food-db ID/name without
    // pretending it is a Postgres ref. A mismatch stays unknown for active restrictions.
    explicitAvoidNames: names,
    explicitAvoidFoodDbIds: foodDbIds,
    preferenceFlags: flags,
    evidenceBySeq: Object.fromEntries(recipe.ingredients.map((item) => {
      const revision = item.catalogFoodRevisionId
        ?? evidence.mappedDb.get(item.foodDbId ?? "");
      const food = item.foodDbId ? FOOD_BY_ID.get(item.foodDbId) : undefined;
      const bundledCategory = revision === undefined && food && !food.sr.startsWith("label:")
        ? policyCategoriesFor({ description: food.sr, category: food.category }) : undefined;
      return [item.seq, revision !== undefined ? evidence.byRevision.get(revision) ?? {}
        : bundledCategory ? { category: bundledCategory } : {}];
    })),
  });
  const rulesFingerprint = fingerprint({ day: asOf.toISOString().slice(0, 10),
    policyRevision: policy.rev, profile: policy.profile, settingsRevision: settings.data?.rev ?? 0,
    flags: [...flags].sort(), avoidIds: [...avoidIds].sort(), avoidNames: [...names].sort(),
    avoidFoodDbIds: foodDbIds,
    evidence: [...evidence.byRevision.entries()].sort(([a], [b]) => a - b),
    mappedDb: [...evidence.mappedDb.entries()].sort() });
  /**
   * Each pinned catalog line carries its revision's own description (audit F6, review round 6):
   * the diet badges judge it beside the authored line name, so a line authored "Lentils, cooked"
   * but pinned to wheat flour cannot badge vegan or gluten-free. A revision that did not load
   * carries no name, and recipeDietFacts then needs complete stored evidence instead.
   */
  const withCatalogNames = <R extends CatalogRecipe>(recipe: R): R => ({ ...recipe,
    ingredients: recipe.ingredients.map((item) => {
      const name = item.catalogFoodRevisionId === null ? undefined
        : evidence.byRevision.get(item.catalogFoodRevisionId)?.foodName;
      return typeof name === "string" && name.trim() ? { ...item, catalogFoodName: name } : item;
    }) });
  return { forRecipe, rulesFingerprint, withCatalogNames, preferenceFlags: [...flags] as string[],
    favoriteRecipeIds: (stars.data ?? []).map((row) => row.recipe_id),
    favoriteFoodRefIds: (foodStars.data ?? []).map((row) => row.food_ref_id) };
}

/** The shared Coach/day-planner/search boundary; no Eats-derived ranking is used. */
export async function loadRecipeCandidates(client: SupabaseClient, userId: string,
  search: RecipeSearch, asOf: Date = new Date()): Promise<AccountRecipeCandidates> {
  const recipes = await searchCatalog(client, search);
  const account = await accountContext(client, userId, recipes, asOf);
  const found = findRecipeCandidates(recipes, search, account.forRecipe, {
    favoriteRecipeIds: account.favoriteRecipeIds,
    favoriteFoodRefIds: account.favoriteFoodRefIds,
    usualFoodRefIds: [],
  });
  return { candidates: found.candidates.map(account.withCatalogNames),
    noResultReasons: found.noResultReasons, exactMatch: found.exactMatch,
    rulesFingerprint: account.rulesFingerprint, preferenceFlags: account.preferenceFlags };
}

/** Detail is viewable with its blocked/unknown explanation, never labeled eligible by default. */
export async function loadRecipeDetail(client: SupabaseClient, userId: string,
  id: string, asOf: Date = new Date()): Promise<{ recipe: RecipeCandidate; rulesFingerprint: string;
    preferenceFlags: string[] } | null> {
  const recipe = await getCatalogRecipe(client, id);
  if (!recipe) return null;
  const account = await accountContext(client, userId, [recipe], asOf);
  return { recipe: account.withCatalogNames(withRecipeEligibility(recipe, account.forRecipe(recipe))),
    rulesFingerprint: account.rulesFingerprint, preferenceFlags: account.preferenceFlags };
}

export type MarkedRecipe = RecipeCandidate & { ruleMark: RuleMark | null };

/**
 * The planning screens' reads (search, detail, preview). The recipe read and the rule read are
 * separate: a recipe read failure still fails the request, but a rule read failure (rules,
 * Avoids, evidence, a required rule review) returns the recipes with `ruleMark` unknown and
 * eligibility `unknown`, never a pass. `rulesFingerprint` is null and `preferenceFlags` absent then,
 * so nothing downstream can store a proof from an unread rule set.
 */
export type MarkedRecipeCandidates = {
  candidates: MarkedRecipe[]; noResultReasons: string[]; exactMatch: boolean;
  rulesFingerprint: string | null; preferenceFlags?: string[];
};

/** Why a recipe could not be checked: the review prompt when a review is required. */
function rulesUnreadMark(error: unknown): RuleMark {
  return { verdict: "unknown", reason: error instanceof HttpError && error.code === "rule_review_required"
    ? REVIEW_RULES : UNCHECKED };
}

/** The recipe's own checks (publication, rights, completeness) kept; the rules part unknown. */
function uncheckedRecipe(recipe: CatalogRecipe, mark: RuleMark): MarkedRecipe {
  const own = recipeEligibility(recipe, { profile: EMPTY_PROFILE });
  return { ...recipe, ruleMark: mark, eligibility: {
    status: own.status === "eligible" ? "unknown" : own.status,
    reasons: [...own.reasons, { code: "rules_unavailable", message: mark.reason }],
  } };
}

export async function loadMarkedRecipeCandidates(client: SupabaseClient, userId: string,
  search: RecipeSearch, asOf: Date = new Date()): Promise<MarkedRecipeCandidates> {
  const recipes = await searchCatalog(client, search);
  let account: Awaited<ReturnType<typeof accountContext>>;
  try {
    account = await accountContext(client, userId, recipes, asOf);
  } catch (error) {
    const mark = rulesUnreadMark(error);
    // The request's own filters and order, with no rule applied: every row then reads unknown.
    const found = findRecipeCandidates(recipes, search, { profile: EMPTY_PROFILE });
    return { candidates: found.candidates.map((recipe) => uncheckedRecipe(recipe, mark)),
      noResultReasons: [mark.reason, ...found.noResultReasons], exactMatch: found.exactMatch,
      rulesFingerprint: null };
  }
  const found = findRecipeCandidates(recipes, search, account.forRecipe, {
    favoriteRecipeIds: account.favoriteRecipeIds,
    favoriteFoodRefIds: account.favoriteFoodRefIds,
    usualFoodRefIds: [],
  });
  return { candidates: found.candidates.map((recipe) => withRuleMark(account.withCatalogNames(recipe))),
    noResultReasons: found.noResultReasons, exactMatch: found.exactMatch,
    rulesFingerprint: account.rulesFingerprint, preferenceFlags: account.preferenceFlags };
}

export async function loadMarkedRecipeDetail(client: SupabaseClient, userId: string,
  id: string, asOf: Date = new Date()): Promise<{ recipe: MarkedRecipe;
    rulesFingerprint: string | null; preferenceFlags?: string[] } | null> {
  const recipe = await getCatalogRecipe(client, id);
  if (!recipe) return null;
  let account: Awaited<ReturnType<typeof accountContext>>;
  try {
    account = await accountContext(client, userId, [recipe], asOf);
  } catch (error) {
    return { recipe: uncheckedRecipe(recipe, rulesUnreadMark(error)), rulesFingerprint: null };
  }
  return { recipe: withRuleMark(account.withCatalogNames(withRecipeEligibility(recipe, account.forRecipe(recipe)))),
    rulesFingerprint: account.rulesFingerprint, preferenceFlags: account.preferenceFlags };
}

/**
 * The preview's explicit exception to in-band marks: a preview is a stored proof, and no proof is
 * made from rules that were not read. It answers 422 `recipe_rules_unchecked` with the unknown
 * `ruleMark` in the body (the preview route serializes it).
 */
export class RecipeRulesUnchecked extends HttpError {
  constructor(readonly ruleMark: RuleMark) {
    super(422, "recipe_rules_unchecked", ruleMark.reason);
  }
}

/** Codes about the recipe itself (publication, rights, completeness), not about this account's rules. */
const NOT_A_RULE = new Set(["not_published", "rights", "incomplete_recipe", "incomplete_ingredient"]);
const RULE_BLOCKS = new Set(["avoid_list", "policy_block", "custom_cuisine"]);
const UNCHECKED = "This recipe could not be checked against your current food rules.";
const REVIEW_RULES = "Review your food rules in Settings to check this recipe.";

/**
 * recipeEligibility as one mark (F2, review round 2). Only a fully `eligible` recipe with no
 * reason is clear (null). A rule block is blocked; anything else — a rule it could not check, or a
 * pinned revision that is no longer published, lacks rights or is incomplete — is unknown with a
 * plain reason. An unchecked recipe is never a pass.
 */
export function ruleMarkFromEligibility(eligibility: RecipeEligibility): RuleMark | null {
  const reasons = Array.isArray(eligibility?.reasons) ? eligibility.reasons : [];
  if (eligibility?.status === "eligible" && reasons.length === 0) return null;
  const blocked = reasons.find((entry) => RULE_BLOCKS.has(entry.code));
  if (blocked) return { verdict: "blocked", reason: blocked.message };
  const rule = reasons.find((entry) => !NOT_A_RULE.has(entry.code));
  if (rule) return { verdict: "unknown", reason: rule.message };
  const recipe = reasons[0];
  return { verdict: "unknown", reason: recipe ? `${UNCHECKED} ${recipe.message}` : UNCHECKED };
}

const SUBSTITUTED = "A substituted ingredient has not been checked against your current food rules.";

/**
 * A planning surface's mark for one recipe (search results, detail, preview): the same verdict
 * the selection GET gives an accepted row, from the eligibility `loadRecipeCandidates` /
 * `loadRecipeDetail` just computed under the account's CURRENT rules and normalized flags. With an
 * adapted `snapshot` (a preview), a line the recipe's own ingredients do not hold keeps it unknown.
 * Never throws: anything unreadable is unknown, never a pass.
 */
export function candidateRuleMark(recipe: RecipeCandidate,
  snapshot?: readonly unknown[]): RuleMark | null {
  try {
    const verdict = ruleMarkFromEligibility(recipe.eligibility);
    if (verdict !== null) return verdict;
    if (snapshot !== undefined && hasUnjudgedLine(recipe, snapshot)) {
      return { verdict: "unknown", reason: SUBSTITUTED };
    }
    return null;
  } catch {
    return { verdict: "unknown", reason: UNCHECKED };
  }
}

/** The recipe with its `ruleMark` attached (see `candidateRuleMark`). */
export function withRuleMark<T extends RecipeCandidate>(recipe: T): T & { ruleMark: RuleMark | null } {
  return { ...recipe, ruleMark: candidateRuleMark(recipe) };
}

/**
 * The accept response's mark for the selection it just wrote: `acceptedSelectionRuleMarks` on that
 * one row (it re-reads the pinned revision under the CURRENT rules). Never throws; a failure, or a
 * row the marks do not name, is unknown.
 */
export async function acceptedSelectionRuleMark(client: SupabaseClient, userId: string,
  selection: { id: string; recipeRevisionId: string; ingredientSnapshot?: readonly unknown[] }):
  Promise<{ ruleMark: RuleMark | null; preferenceFlags?: string[] }> {
  try {
    const marks = await acceptedSelectionRuleMarks(client, userId, [selection]);
    const ruleMark = marks.has(selection.id) ? marks.get(selection.id) ?? null
      : { verdict: "unknown" as const, reason: UNCHECKED };
    return marks.preferenceFlags ? { ruleMark, preferenceFlags: marks.preferenceFlags } : { ruleMark };
  } catch {
    return { ruleMark: { verdict: "unknown", reason: UNCHECKED } };
  }
}

/**
 * F2 (2026-10-05 calculation audit): each accepted selection's own pinned revision judged by
 * recipeEligibility under the account's CURRENT rules. It never throws and never drops a row: a
 * rule set or recipe that cannot be read marks the selection unknown (fail closed), and the
 * caller still returns the selection. Eaten history is the caller's to leave alone.
 */
export async function acceptedSelectionRuleMarks(client: SupabaseClient, userId: string,
  selections: readonly { id: string; recipeRevisionId: string;
    ingredientSnapshot?: readonly unknown[] }[], asOf: Date = new Date()):
  Promise<SelectionRuleMarks> {
  const marks: SelectionRuleMarks = new Map<string, RuleMark | null>();
  if (selections.length === 0) return marks;
  const all = (reason: string) => {
    for (const selection of selections) marks.set(selection.id, { verdict: "unknown", reason });
    return marks;
  };
  let recipes: CatalogRecipe[];
  let account: Awaited<ReturnType<typeof accountContext>>;
  try {
    recipes = await getPinnedRecipeRevisions(client, selections.map((row) => row.recipeRevisionId));
    account = await accountContext(client, userId, recipes, asOf);
  } catch (error) {
    return all(error instanceof HttpError && error.code === "rule_review_required"
      ? REVIEW_RULES : UNCHECKED);
  }
  marks.preferenceFlags = [...account.preferenceFlags];
  const byRevision = new Map(recipes.map((recipe) => [recipe.revisionId, recipe]));
  for (const selection of selections) {
    // Fail closed by construction (round 5 BLOCK): the row is unknown until every step below has
    // returned, and a clear (null) is written only as the very last step of a full success.
    marks.set(selection.id, { verdict: "unknown", reason: UNCHECKED });
    const recipe = byRevision.get(selection.recipeRevisionId);
    if (!recipe) continue;
    try {
      const verdict = ruleMarkFromEligibility(recipeEligibility(recipe, account.forRecipe(recipe)));
      if (verdict !== null) { marks.set(selection.id, verdict); continue; }
      // The plan holds its adapted snapshot, which may substitute a line the pinned revision does
      // not have. Such a line was never judged here: the recipe cannot clear (round 3 WARN 3).
      if (hasUnjudgedLine(recipe, selection.ingredientSnapshot)) {
        marks.set(selection.id, { verdict: "unknown", reason: SUBSTITUTED });
        continue;
      }
      marks.set(selection.id, null);
    } catch { /* The row keeps its unknown mark; it never fails the read or a committed log. */ }
  }
  return marks;
}

/**
 * A snapshot line whose identity is not one of the pinned revision's own ingredient lines. A
 * missing or empty snapshot names nothing the check can tie to the plan, so it counts as
 * unjudged too (round 4 BLOCK 2): the recipe is then unknown, never a pass.
 */
export function hasUnjudgedLine(recipe: CatalogRecipe, snapshot: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return true;
  const ingredients = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
  // Round 5: every identity field, JSON-encoded (no delimiter collision). A field of the wrong type
  // makes the line unreadable, never a null that could match a pinned line's real null.
  const id = (value: unknown) => value === null || value === undefined ? null
    : typeof value === "string" || typeof value === "number" ? value : Symbol.for("unreadable");
  const keyOf = (refId: unknown, dbId: unknown, revisionId: unknown, name: unknown): string | null => {
    const parts = [id(refId), id(dbId), id(revisionId)];
    if (parts.some((part) => typeof part === "symbol") || typeof name !== "string" || !name.trim()) return null;
    return JSON.stringify([...parts, name.trim().toLowerCase()]);
  };
  const known = new Set(ingredients.map((item) => keyOf(item?.foodRefId, item?.foodDbId,
    item?.catalogFoodRevisionId, item?.name)).filter((key): key is string => key !== null));
  return snapshot.some((line) => {
    if (!line || typeof line !== "object") return true;
    const row = line as { foodRefId?: unknown; foodDbId?: unknown; foodRevisionId?: unknown; name?: unknown };
    const key = keyOf(row.foodRefId, row.foodDbId, row.foodRevisionId, row.name);
    return key === null || !known.has(key);
  });
}
