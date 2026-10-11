import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComposedItem } from "@/lib/coach/compose";
import type { SuggestionCandidate } from "@/lib/coach/suggest-candidates";
import type { Facet } from "@/lib/foods/facet-vocabulary";
import type { StoredMealRole, SuggestionFoodEvidence } from "@/lib/coach/suggest-evidence-types";
import { facetRulesFor, type PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { suggestionFoodIdentity, suggestionItemsOutcome } from "@/lib/coach/suggest-verdict";
import { fetchByKeyChunks } from "@/lib/server/paged-read";

// The fail-closed verdict lives in lib/coach/suggest-verdict.ts (file-size cap); callers keep
// importing it from here.
export {
  policyReasonWords, suggestionFoodIdentity, suggestionItemsOutcome, suggestionItemsVerdict,
  type CandidateOutcome,
} from "@/lib/coach/suggest-verdict";

export type { StoredMealRole, SuggestionFoodEvidence } from "@/lib/coach/suggest-evidence-types";
export type SuggestionEvidence = {
  status: "ready" | "unavailable";
  preferenceFlags: PolicyPreferenceFlag[];
  byIdentity: Record<string, SuggestionFoodEvidence>;
};
/** `facets`: the account's confirmed profile-rule facets (profileRuleFacets), read with the rest.
 *  `client`: the service-role client to read through (default `adminClient()`); an offline report
 *  passes a read-only one (scripts/diet-rule-jev-impact.ts). */
export type SuggestionEvidenceOptions = {
  needsNoCook: boolean; facets?: readonly Facet[]; client?: SupabaseClient;
};
export type SuggestionEvidencePort = (
  userId: string,
  items: readonly ComposedItem[],
  options: SuggestionEvidenceOptions,
) => Promise<SuggestionEvidence>;

export type SuggestionFilterResult = {
  candidates: SuggestionCandidate[];
  blocked: number;
  unverified: number;
  requiresPreparation: number;
};

const NO_COOK_WISH = /\b(?:no[- ]cook(?:ing)?|without (?:any )?cook(?:ing)?|ready[- ]to[- ]eat)\b/i;

export function asksForNoCook(wish: string | undefined): boolean {
  return NO_COOK_WISH.test(wish ?? "");
}

/** Excludes deterministic, cached-facet, and applicable unknown results before ranking. */
export function filterSuggestionCandidates(
  candidates: readonly SuggestionCandidate[],
  evidence: SuggestionEvidence,
  profile: ConstraintProfile,
  needsNoCook: boolean,
): SuggestionFilterResult {
  const kept: SuggestionCandidate[] = [];
  let blocked = 0;
  let unverified = 0;
  let requiresPreparation = 0;

  for (const candidate of candidates) {
    const outcome = suggestionItemsOutcome(candidate.meal.items, evidence, profile, needsNoCook);
    if (outcome === "allowed") kept.push(candidate);
    else if (outcome === "requires_preparation") requiresPreparation += 1;
    else if (outcome === "unverified") unverified += 1;
    else blocked += 1;
  }
  return { candidates: kept, blocked, unverified, requiresPreparation };
}

export async function loadSuggestionEvidence(
  userId: string,
  // Phase 13 slice 7's reply check (lib/server/reply-check-ports.ts) passes bare food refs and
  // reads the facets an account's profile hard rules name through this same cache-only path.
  items: readonly Pick<ComposedItem, "foodRefId" | "catalogFoodRevisionId">[],
  options: SuggestionEvidenceOptions,
): Promise<SuggestionEvidence> {
  const revisionIds = [...new Set(items.map((item) => item.catalogFoodRevisionId)
    .filter((id): id is number => id !== null))];
  const refIds = [...new Set(items.map((item) => item.foodRefId))];
  try {
    const [adminModule, catalogModule, keyModule, facetsModule, profileModule, categoryModule,
      evidenceModule, starterModule, starterEvidenceModule, logEvidenceModule] = await Promise.all([
        import("@/lib/server/admin"),
        import("@/lib/foods/catalog-ingredients"),
        import("@/lib/foods/facet-keys"),
        import("@/lib/foods/facets"),
        import("@/lib/profile/onboarding-state"),
        import("@/lib/catalog/category-map"),
        import("@/lib/server/allergen-evidence"),
        import("@/lib/foods/starter-attestation"),
        import("@/lib/foods/starter-evidence"),
        import("@/lib/server/log-evidence"),
      ]);
    const admin = options.client ?? adminModule.adminClient();
    // W038: the id lists are chunked by unique key (an Eats list can name 1,500 foods); a failed
    // chunk throws into the catch below, so the evidence is unavailable, never a shorter set.
    const [settings, prefRows, revisionRows, refRows] = await Promise.all([
      admin.from("user_settings").select("diet_prefs").eq("user_id", userId).maybeSingle(),
      fetchByKeyChunks<string, PrefRow>(refIds, (batch) => admin.from("user_food_prefs")
        .select("food_ref_id,status,role,no_cook").eq("user_id", userId).in("food_ref_id", batch)),
      revisionsById(admin, revisionIds),
      fetchByKeyChunks<string, RefRow>(refIds, (batch) => admin.from("food_refs")
        .select("id,kind,user_food_id,catalog_food_id,user_foods(id,user_id,name,brand,ingredients_text,allergen_tags,rev,kind,catalog_food_id,deleted_at,per_100g)")
        .in("id", batch)),
    ]);
    if (settings.error) return unavailable();
    // ai-audit 2026-10-01 (safety): an unpinned catalog item (the capture sheet's food swap, a
    // coach log with no revision) is judged on its food's ACTIVE revision — the same resolver
    // lib/server/log-evidence.ts uses — so /api/log/commit's two evidence layers cover the same
    // items, and a stored Jev-derived `listed` finding reaches an unpinned item too.
    const unpinned = new Set(items.filter((item) => item.catalogFoodRevisionId === null)
      .map((item) => item.foodRefId));
    const unpinnedCatalog = refRows.filter((ref) => ref.kind === "catalog"
      && ref.catalog_food_id != null && unpinned.has(ref.id));
    const activeByFood = await logEvidenceModule.activeRevisionsByFood(admin,
      [...new Set(unpinnedCatalog.map((ref) => ref.catalog_food_id as number))]);
    const activeByRef = new Map(unpinnedCatalog.flatMap((ref) => {
      const active = activeByFood.get(ref.catalog_food_id as number)?.[0];
      return active === undefined ? [] : [[ref.id, active] as const];
    }));
    const extraIds = [...new Set(activeByRef.values())].filter((id) => !revisionIds.includes(id));
    const extra = await revisionsById(admin, extraIds);
    const revisionFor = (food: (typeof items)[number]) =>
      food.catalogFoodRevisionId ?? activeByRef.get(food.foodRefId) ?? null;

    const rawFlags = (settings.data as { diet_prefs?: { flags?: unknown } } | null)
      ?.diet_prefs?.flags;
    const preferenceFlags = profileModule.normalizePreferenceFlags(Array.isArray(rawFlags)
      ? rawFlags.filter((flag): flag is string => typeof flag === "string") : []);
    const neededFacets = [...new Set([
      "human_food" as const,
      ...(options.needsNoCook ? ["requires_preparation" as const] : []),
      ...facetRulesFor(preferenceFlags).map((rule) => rule.facet),
      ...(options.facets ?? []),
    ])];
    const prefByRef = new Map(prefRows.map((row) => [row.food_ref_id, row]));
    const catalogPrepared = [...revisionRows, ...extra].map((row) => {
      const warm = catalogModule.catalogWarmFood(row);
      const key = {
        foodKey: keyModule.foodKey(warm.identity),
        inputHash: keyModule.inputHash({
          name: warm.name, brand: warm.brand, description: warm.category,
          preparation: warm.serving, ingredientsText: warm.ingredientsText,
        }),
      };
      return { kind: "catalog" as const, row, key, cacheKey: facetsModule.facetCacheKey(key) };
    });
    const userPrepared = refRows.flatMap((ref) => {
      if (ref.kind !== "user") return [];
      const row = embeddedUserFood(ref.user_foods);
      if (!row || row.user_id !== userId || row.id !== ref.user_food_id || row.deleted_at) return [];
      const key = {
        foodKey: keyModule.foodKey({ kind: "user_food" as const, id: row.id, rev: row.rev }),
        inputHash: keyModule.inputHash({
          name: row.name, brand: row.brand, ingredientsText: row.ingredients_text,
        }),
      };
      return [{ kind: "user" as const, ref, row, key,
        cacheKey: facetsModule.facetCacheKey(key) }];
    });
    const prepared = [...catalogPrepared, ...userPrepared];
    const foodKeys = prepared.map((item) => item.key.foodKey);
    // review round 2 (sol/BLOCK): this stage is a genuinely sequential round trip after
    // `revisions`/`refs` above — it needs `prepared`'s food keys first — so it is real added
    // latency versus pre-slice-2 coach, the same shape lib/server/catalog.ts's own evidence wave
    // documents for search (dfc713c) and lib/server/capture.ts documents for capture. No
    // before/after coach-turn p95 sample exists yet for it either; closing that needs
    // `pnpm timings --path coach` run against production before and after this slice, which needs
    // production DB access this fixer pass does not have. Argued, not measured, in the meantime:
    // both added reads are a single `.in()` over `foodKeys` (`food_allergen_evidence`'s own
    // primary key; `user_allergen_checks` scoped by user then matched on it), and all three run in
    // parallel with each other and with the cache read they already join.
    const [cached, storedEvidence, checks] = await Promise.all([
      facetsModule.readFacets(prepared.map((item) => item.key), neededFacets, admin),
      evidenceModule.readAllergenEvidence(admin, foodKeys),
      evidenceModule.readAllergenChecks(admin, userId, foodKeys),
    ]);
    // An allow list is never decided from a partial read: a failed facet or check read is
    // "could not be checked right now", not empty evidence.
    if (cached.errors > 0 || checks.failed === true) return unavailable();
    const byIdentity: Record<string, SuggestionFoodEvidence> = {};
    for (const item of catalogPrepared) {
      const tags = catalogAllergenTags(item.row.catalog_ingredients);
      for (const matching of items.filter((food) => revisionFor(food) === item.row.id)) {
        if (userPrepared.some((user) => user.ref.id === matching.foodRefId)) continue;
        const pref = prefByRef.get(matching.foodRefId);
        // ORCHESTRATOR fix (round 7, item 4): completenessText/raw_text, like every other path —
        // never catalogIngredientsText's lossy join of names, which cannot be judged for
        // completeness and used to demote a genuinely complete, terminated label to unverified.
        const completeness = catalogModule.completenessText(
          (item.row.catalog_ingredients ?? []).filter((ingredient) => ingredient.seq >= 1));
        byIdentity[suggestionFoodIdentity(matching)] = {
          allergenTags: tags,
          allergenEvidence: storedEvidence.get(item.key.foodKey) ?? {},
          checkedAllergens: checks.get(item.key.foodKey) ?? [],
          ingredientsText: completeness.text,
          ingredientsTextIsLabel: completeness.verbatim,
          foodName: item.row.description,
          foodBrand: item.row.brand,
          // 2026-10-02 DeepSeek audit (F2, MED): a branded/OFF row never gets whole-food clearance.
          packaged: categoryModule.isPackagedCatalogSource(embeddedSource(item.row.catalog_foods)),
          policyCategories: item.row.policy_categories
            ?? categoryModule.policyCategoriesFor(item.row),
          facets: cached.get(item.cacheKey) ?? {},
          noCook: typeof pref?.no_cook === "boolean" ? pref.no_cook : null,
          onEatsList: pref?.status === "eats",
          onAvoidList: pref?.status === "avoid",
          role: storedRole(pref?.role),
        };
      }
    }
    for (const item of userPrepared) {
      const matching = items.find((food) => food.foodRefId === item.ref.id);
      if (!matching) continue;
      const pref = prefByRef.get(matching.foodRefId);
      const facts: SuggestionFoodEvidence = {
        allergenTags: item.row.allergen_tags ?? null,
        allergenEvidence: storedEvidence.get(item.key.foodKey) ?? {},
        checkedAllergens: checks.get(item.key.foodKey) ?? [],
        ingredientsText: item.row.ingredients_text,
        ingredientsTextIsLabel: item.row.kind === "label_scan",
        foodName: item.row.name,
        foodBrand: item.row.brand,
        // 2026-10-02 DeepSeek audit (F2, MED): same "label_scan" test as ingredientsTextIsLabel.
        packaged: item.row.kind === "label_scan",
        policyCategories: null,
        facets: cached.get(item.cacheKey) ?? {},
        noCook: typeof pref?.no_cook === "boolean" ? pref.no_cook : null,
        onEatsList: pref?.status === "eats",
        onAvoidList: pref?.status === "avoid",
        role: storedRole(pref?.role),
      };
      const starter = await starterModule.verifiedStarterForUserFood(userId, item.row);
      byIdentity[suggestionFoodIdentity(matching)] = starter
        ? starterEvidenceModule.starterSuggestionEvidence(starter, facts) : facts;
    }
    return { status: "ready", preferenceFlags, byIdentity };
  } catch {
    return unavailable();
  }
}

function storedRole(value: unknown): StoredMealRole | null {
  return value === "protein" || value === "carb" || value === "fat" ? value : null;
}

function catalogAllergenTags(ingredients: RevisionRow["catalog_ingredients"]): string[] | null {
  if (!ingredients) return null;
  return [...new Set(ingredients.flatMap((ingredient) => ingredient.allergen_tags ?? []))];
}

function embeddedUserFood(value: UserFoodRow | UserFoodRow[] | null): UserFoodRow | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

/** PostgREST embeds a to-one relation as an object, but a hand-built test fixture may still hand
 *  it an array — tolerate either, like `embeddedUserFood` above. Absent is a generic, unpackaged
 *  row (a hand-built fixture that predates this column, never a real one: `catalog_foods` is
 *  NOT NULL on every real revision). */
function embeddedSource(value: RevisionRow["catalog_foods"]): string | null {
  const row = Array.isArray(value) ? value[0] ?? null : value ?? null;
  return row?.source ?? null;
}

const REVISION_SELECT = "id,description,brand,category,policy_categories,prep_state,"
  + "catalog_ingredients(seq,name,raw_text,allergen_tags),catalog_portions(seq,description,is_default),"
  // 2026-10-02 DeepSeek audit (F2, MED): the only way to tell a branded/OFF row from a generic
  // USDA commodity entry (lib/catalog/category-map.ts isPackagedCatalogSource).
  + "catalog_foods(source)";

/** Catalog revisions by id, chunked; any failed chunk throws. */
function revisionsById(admin: SupabaseClient, ids: readonly number[]): Promise<RevisionRow[]> {
  return fetchByKeyChunks<number, RevisionRow>(ids, (batch) =>
    admin.from("catalog_food_revisions").select(REVISION_SELECT).in("id", batch) as unknown as
      PromiseLike<{ data: RevisionRow[] | null; error: { message: string } | null }>);
}

function unavailable(): SuggestionEvidence {
  return { status: "unavailable", preferenceFlags: [], byIdentity: {} };
}

type PrefRow = {
  food_ref_id: string;
  status: "eats" | "avoid";
  role: unknown;
  no_cook: unknown;
};
type RevisionRow = {
  id: number;
  description: string;
  brand: string | null;
  category: string | null;
  policy_categories: string[] | null;
  prep_state: string | null;
  catalog_ingredients: { seq: number; name: string; raw_text?: string | null;
    allergen_tags?: string[] | null }[];
  catalog_portions: { seq: number; description: string | null; is_default: boolean }[];
  /** 2026-10-02 DeepSeek audit (F2, MED): absent on a hand-built test fixture; real rows embed it. */
  catalog_foods?: { source: string } | { source: string }[] | null;
};
type UserFoodRow = {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  ingredients_text: string | null;
  allergen_tags: string[] | null;
  catalog_food_id: number | null;
  deleted_at: string | null;
  per_100g: Record<string, unknown> | null;
  rev: number;
  /** sol BLOCK (r5): only a "label_scan" row's text is a genuine printed label (§9 R2). */
  kind: string;
};
type RefRow = {
  id: string;
  kind: "catalog" | "user";
  user_food_id: string | null;
  catalog_food_id: number | null;
  user_foods: UserFoodRow | UserFoodRow[] | null;
};
