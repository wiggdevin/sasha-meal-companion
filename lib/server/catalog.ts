/**
 * Server-only catalog reads. The only module app/api/foods/* talks to.
 *
 * Every query runs on the RLS-scoped, request-local client `requireUser`
 * returns — never the service role. `catalog_search` is `security invoker`, so
 * the personalised half of the score (the 90-day prior count and the eats/avoid
 * status) is the caller's own rows and nobody else's.
 *
 * The RPC returns 6-dp scores; the wire type carries 4 (spec phase-1-catalog.md "API changes").
 */

import { requestIp } from "@/lib/server/request-ip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPackagedCatalogSource, policyCategoriesFor, type CategorizableRevision } from "@/lib/catalog/category-map";
import { completenessText, type CatalogIngredientRow } from "@/lib/foods/catalog-ingredients";
import { buildPortions, type Portion, type RealPortionInput } from "@/lib/foods/portions";
import type { QualityClass } from "@/lib/search/features";
import { classifyQuery, parseQuery, type PrepState } from "@/lib/search/query";
import { rerankedSearch, searchRerankEnabled } from "@/lib/search/rerank";
import { shouldAutoResolve } from "@/lib/search/thresholds";
import { HttpError } from "@/lib/server/auth";
import { namedAllergenHints, type StoredAllergenEvidence } from "@/lib/policy/allergens";
import { heldAllergenKeys } from "@/lib/policy/held-allergens";
import { evaluatePolicy, loadProfile, type ConstraintProfile, type PolicyVerdict } from "@/lib/policy/constraints";
import { readAllergenChecks, readAllergenEvidence } from "@/lib/server/allergen-evidence";

if (typeof window !== "undefined") {
  throw new Error("lib/server/catalog.ts is server-only and must never reach the browser bundle.");
}

export type CatalogSource = "fdc_foundation" | "fdc_sr_legacy" | "fdc_fndds" | "fdc_branded" | "off";

export type FoodSearchRequest = { q: string; brand?: string; prep?: PrepState; limit?: number };

export type FoodSearchHit = {
  catalogFoodId: number; revisionId: number; description: string; brand: string | null;
  source: CatalogSource; qualityClass: QualityClass; qualityFlags: string[];
  prepState: PrepState | null; score: number; prefStatus: "eats" | "avoid" | null;
  /** The controlled keys the policy compares (lib/catalog/category-map.ts), not `category`. */
  policyCategories: string[];
  policy: PolicyVerdict;
  /**
   * Serving data (UI lane contract): `energy_kcal`, falling back to `energy_kcal_calc` (the same
   * rule lib/server/coach.ts's mapCatalogFoodHit uses). `per100g` is the simplified macro set a
   * detail/search card shows; `lib/foods/portions.ts` is the one place that turns real portions
   * plus this number into `portions`/`defaultPortion` so no caller can round or pick a default
   * differently from another.
   */
  kcalPer100g: number | null;
  per100g: { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null } | null;
  /** Real portions ordered by `seq`, then always a synthetic 100 g tail (`lib/foods/portions.ts`). */
  portions: Portion[];
  /** The `isDefault` portion, else the first real one, else `null` when the food has none. */
  defaultPortion: Portion | null;
};

export type FoodSearchResponse = {
  hits: FoodSearchHit[];
  queryClass: "branded" | "generic";
  autoResolve: { revisionId: number; score: number; margin: number } | null;
  catalogVersion: string;
};

/**
 * `Omit<FoodSearchHit, "per100g" | "portions">`, not a plain intersection: several components
 * (FoodDetailSheet, SlotCardDetail, EditSlotSheet, add-food/catalog-food.ts) and lib/server/
 * coach.ts already read THIS type's own `per100g` (the full nutrient-code map) and `portions`
 * (the full catalog_portions rows) by those exact names and shapes — out of scope for this change
 * to touch. The base type's new, simplified `per100g`/`portions` (the UI lane contract, `lib/
 * foods/portions.ts`) would collide with them under a plain `&`, so they are carried here instead
 * under `simplePer100g`/`servingPortions`; `kcalPer100g` and `defaultPortion` have no such
 * collision and are inherited from `FoodSearchHit` unchanged.
 */
export type FoodDetail = Omit<FoodSearchHit, "per100g" | "portions"> & {
  category: string | null;
  catalogVersion: string; attribution: string;
  per100g: Record<string, { amount: number | null; unit: string }>;
  portions: { id: number; description: string; gramWeight: number; isDefault: boolean }[];
  /** UI lane contract (lib/foods/portions.ts) — the simplified four-nutrient panel. */
  simplePer100g: { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null } | null;
  /** UI lane contract (lib/foods/portions.ts) — real portions plus the synthetic 100 g tail. */
  servingPortions: Portion[];
  ingredients: { seq: number; name: string; allergenTags: string[] }[];
  /** Phase 13 §5: stored evidence per allergen for this revision, and this user's checks. */
  allergenEvidence?: Record<string, StoredAllergenEvidence>;
  checkedAllergens?: string[];
  /** W2a: allergen keys held for review on this revision (`heldAllergenKeys`); empty when none.
   * Optional because details cached on the phone before this field read it as absent: treat as []. */
  heldAllergens?: string[];
  /**
   * finding #10: the revision's own ingredient statement, the same convention search's
   * `allergenTagsByRevision` and lib/server/barcode.ts use — `null` when no row carries one.
   * Never the lossy `ingredients.map(name).join(", ")` a caller (lib/server/coach.ts
   * mapCatalogFoodHit) used to fall back to, which is neither the real printed text nor judgeable
   * for completeness.
   *
   * sol BLOCK (finding #1, fixer pass): this is `completenessText`'s own `list.text`
   * (lib/foods/catalog-ingredients.ts) — the SAME string `ingredientsTextIsLabel` below describes
   * — not seq 1's raw fragment alone. `getFoodDetail` used to return seq 1's fragment here while
   * computing `ingredientsTextIsLabel` from the fuller joined text: a caller downstream
   * (lib/server/coach.ts mapCatalogFoodHit) that trusted the two fields to describe the same
   * string could scan only the fragment and miss an allergen a later split-off row actually named
   * (§5, catalog_ingredients seq 2's own `raw_text`), even though search and this function's own
   * internal policy check (below) already caught it.
   */
  ingredientsText: string | null;
  /**
   * finding #1 (round 10): whether `ingredientsText` above is genuinely the label's own verbatim
   * statement — `completenessText`'s own `verbatim` flag (lib/foods/catalog-ingredients.ts), not
   * assumed true. Kept in lockstep with `ingredientsText` (both come from the same `list`) so a
   * caller downstream (lib/server/coach.ts mapCatalogFoodHit) always learns whether the text it
   * was just handed is the whole printed statement, never a flag describing a different string.
   */
  ingredientsTextIsLabel: boolean;
  /**
   * finding #10 (follow-up): a listed-only keyword scan over the parsed ingredient NAMES,
   * computed once here (where the account's own `avoid_allergens` — including its own named
   * allergens, not just the fixed vocabulary — is already in hand) and reused by
   * lib/server/coach.ts mapCatalogFoodHit so it never has to re-derive it without a profile.
   * Empty whenever `ingredientsText` is present (nothing missing to backfill).
   */
  nameOnlyAllergenHints: string[];
};

/** No active `catalog_versions` row: the client falls back to the bundled database. */
export class NoActiveCatalogVersion extends HttpError {
  constructor() {
    super(503, "catalog_unavailable", "The food catalog is not available right now.");
  }
}

const SOURCE_LABEL: Record<CatalogSource, string> = {
  fdc_foundation: "Foundation Foods",
  fdc_sr_legacy: "SR Legacy",
  fdc_fndds: "FNDDS",
  fdc_branded: "Branded Foods",
  off: "Open Food Facts",
};

export function attributionFor(source: CatalogSource, versionLabel: string): string {
  if (source === "off") return "Data from Open Food Facts (ODbL)";
  return `USDA FoodData Central — ${SOURCE_LABEL[source]} (${versionLabel})`;
}

/** The caller's IP for a per-IP limiter key (lib/server/request-ip.ts). */
export function clientIp(req: Request): string {
  return requestIp(req);
}

export function withRetryAfter(res: Response, seconds: number): Response {
  const headers = new Headers(res.headers);
  headers.set("retry-after", String(seconds));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

type SearchRow = {
  catalog_food_id: number; revision_id: number; description: string; brand: string | null;
  source: CatalogSource; quality_class: QualityClass; quality_flags: string[];
  prep_state: PrepState | null; score: number; pref_status: "eats" | "avoid" | null;
  category: string | null; policy_categories: string[] | null;
};

function toHit(row: SearchRow): FoodSearchHit {
  return {
    catalogFoodId: row.catalog_food_id,
    revisionId: row.revision_id,
    description: row.description,
    brand: row.brand,
    source: row.source,
    qualityClass: row.quality_class,
    qualityFlags: row.quality_flags ?? [],
    prepState: row.prep_state,
    score: Number(Number(row.score).toFixed(4)),
    prefStatus: row.pref_status,
    policyCategories: policyCategoriesOf(row.policy_categories,
      { description: row.description, category: row.category }),
    policy: { verdict: "unverified" },
    // Filled in below, once portionsAndNutrientsByRevision's batched read is back — a search hit
    // starts with the "no serving data yet" shape rather than an undefined field.
    kcalPer100g: null, per100g: null, portions: [], defaultPortion: null,
  };
}

/**
 * The one place that decides what a revision's policy categories are. Three states, three answers:
 *
 *   NULL      never annotated → derive from the row, because reading the absence as "checked,
 *             nothing banned" would show their five switches on while the policy blocked nothing —
 *             the exact promise T1 exists to stop breaking. The column is nullable for this.
 *   '{}'      annotated and clean → trust it. Re-deriving would undo every correction the
 *             annotate run made, and would cost a regex pass per hit on every search.
 *   non-empty stored keys → trust them.
 *
 * Every read path that holds the revision row goes through here: the detail read, the barcode
 * match, and — since the search RPC returns `category` too — every search hit.
 */
export function policyCategoriesOf(
  stored: string[] | null | undefined,
  row: CategorizableRevision,
): string[] {
  return stored ?? policyCategoriesFor(row);
}

/** The caller's own row through RLS; the default profile when the user has none (contracts §4). */
export async function loadUserProfile(client: SupabaseClient): Promise<ConstraintProfile> {
  const { data, error } = await client.from("constraint_profiles")
    .select("avoid_allergens, avoid_food_ref_ids, banned_categories, conditions, custom_rules").maybeSingle();
  if (error) throw new HttpError(500, "policy_failed", "Your food rules could not be read.");
  return loadProfile(data as Partial<ConstraintProfile> | null);
}

type IngredientRow = {
  food_revision_id: number; allergen_tags: string[] | null; seq?: number | null;
  raw_text?: string | null; name?: string | null;
};

/**
 * One extra query per search, over the revision ids we are about to return. A revision with no
 * catalog_ingredients row has NO allergen evidence — that is `null`, not `[]`, and §4.4 renders it
 * amber rather than green.
 *
 * finding #4: also returns each revision's own ingredient text, so an account-defined allergen
 * outside ALLERGEN_RULES — one `food_allergen_evidence` has no stored key for — can still be
 * matched deterministically against the text (§5), the way the barcode and coach-attachment paths
 * already do. Without it, a search hit whose label plainly names an allergen the account avoids
 * but never tagged it (e.g. "apple", §9 R1's example) could only ever read unverified, never
 * blocked.
 *
 * ORCHESTRATOR fix (round 7, item 5): also collects each row's parsed `name`, so a revision with
 * no verbatim raw_text can still be matched by `namedAllergenHints` in `searchFoods` — the same
 * parsed-name presence signal `getFoodDetail` already reads (r4 BLOCK #10 follow-up). Without it, a
 * revision whose only signal is a parsed ingredient name (e.g. "peanut", no `allergen_tags` entry
 * of its own) blocked on the detail sheet but read merely unverified in search.
 *
 * sol BLOCK (finding #2, review round 1): the text and its `verbatim` flag now come from
 * `completenessText` (lib/foods/catalog-ingredients.ts) — the same convention lib/server/
 * barcode.ts's `toMatch` already uses — instead of trusting seq 1's `raw_text` alone. A later row
 * that carries its OWN `raw_text` (the label was split across rows, not just parsed into names)
 * proves seq 1's fragment is not the whole printed statement; `completenessText` catches that
 * shape and marks the text non-verbatim, so it can still be scanned for a keyword (`listed`) but
 * can never look "complete" enough to clear an allergen the split-off row actually named.
 *
 * Review round 2 (sol/BLOCK): a search returns up to 25 revisions (§ searchFoods `limit`), and this
 * read has no page of its own — one plain `.in()` select over all of them. PostgREST caps a single
 * response at `max_rows` (supabase/config.toml, 1,000) and TRUNCATES the rest WITHOUT an error, so
 * 25 products with a long, split label (60+ rows each is not rare) can together carry more than
 * 1,000 ingredient rows. A truncated read drops rows from the TAIL of the order the client did not
 * ask for, which can be a later allergen row of a split label — `completenessText` would then judge
 * the truncated fragment as the WHOLE printed statement and clear an allergen that row actually
 * named. Paged the same way `lib/server/health-daily.ts`'s `rawSamples` pages `health_samples`
 * (T11b finding 2): by keyset on the table's own primary key, `(food_revision_id, seq)`
 * (`catalog_shell.sql`), never `.range()` — an offset page is a POSITION in the list and shifts
 * under a concurrent write, so the keyset is what makes a page stable instead of merely bounded.
 */
const INGREDIENT_PAGE = 1000;

/** Exported for its own pagination test (review round 2, sol/BLOCK) — every other caller reaches
 *  it through searchFoods. */
export async function allergenTagsByRevision(
  client: SupabaseClient, revisionIds: number[]
): Promise<{ tags: Map<number, string[]>; ingredientsText: Map<number, string>;
  ingredientsVerbatim: Map<number, boolean>; names: Map<number, string[]> }> {
  const tags = new Map<number, string[]>();
  const rowsByRevision = new Map<number, CatalogIngredientRow[]>();
  const names = new Map<number, string[]>();
  const ingredientsText = new Map<number, string>();
  const ingredientsVerbatim = new Map<number, boolean>();
  if (revisionIds.length === 0) return { tags, ingredientsText, ingredientsVerbatim, names };
  let after: { revisionId: number; seq: number } | null = null;
  for (;;) {
    let query = client.from("catalog_ingredients")
      .select("food_revision_id, allergen_tags, seq, raw_text, name")
      .in("food_revision_id", revisionIds)
      .order("food_revision_id", { ascending: true })
      .order("seq", { ascending: true });
    if (after) {
      // PostgREST's `or`: the strict revision-greater case, or the tie broken by seq — same shape
      // as rawSamples's `(start_time, id)` continuation.
      query = query.or(`food_revision_id.gt.${after.revisionId},`
        + `and(food_revision_id.eq.${after.revisionId},seq.gt.${after.seq})`);
    }
    const { data, error } = await query.limit(INGREDIENT_PAGE);
    if (error) throw new HttpError(500, "policy_failed", "Ingredients could not be read.");
    const page = (data ?? []) as IngredientRow[];
    for (const row of page) {
      tags.set(row.food_revision_id, [...(tags.get(row.food_revision_id) ?? []), ...(row.allergen_tags ?? [])]);
      // Seq 0 is the provider's declared-allergen line, not the ingredient list (matches
      // catalogWarmFood's own filter) — it never enters the completeness read.
      if (row.seq != null && row.seq >= 1) {
        rowsByRevision.set(row.food_revision_id, [...(rowsByRevision.get(row.food_revision_id) ?? []),
          { seq: row.seq, name: row.name ?? "", raw_text: row.raw_text, allergen_tags: row.allergen_tags }]);
      }
      if (row.name) names.set(row.food_revision_id, [...(names.get(row.food_revision_id) ?? []), row.name]);
    }
    if (page.length < INGREDIENT_PAGE) break;
    const last = page[page.length - 1];
    after = { revisionId: last.food_revision_id, seq: last.seq ?? 0 };
  }
  for (const [revisionId, rows] of rowsByRevision) {
    const list = completenessText(rows);
    if (list.text) {
      ingredientsText.set(revisionId, list.text);
      ingredientsVerbatim.set(revisionId, list.verbatim);
    }
  }
  return { tags, ingredientsText, ingredientsVerbatim, names };
}

/**
 * Every food_ref that stands for a catalog food, the catalog ref first. There are usually one:
 * `food_refs_catalog_uniq` (20260911000200) makes `catalog_food_id` unique, and the row it names
 * is always `kind = 'catalog'` by the table's own check. But a food the user has MAPPED has a second
 * — `lib/foods/prefs-client.ts` mints a ref for their `user_foods` row too and writes their mark to
 * both — and `avoid_food_ref_ids` is a free uuid list (`lib/coach/types.ts`), so the coach may
 * name either one. Reading only the catalog ref let search and the detail sheet answer "allowed"
 * for a food the commit path refuses.
 *
 * A ref exists only once the user or the coach has touched the food, so most hits have none at all.
 * Both read paths call this, so they can never disagree about which row they mean.
 *
 * It DEGRADES rather than throwing. Search never read either table before T9 §4, and a refinement
 * of the policy is not a reason to take their search screen down: a failed read is logged and what
 * it would have contributed is missing, so allergens, banned categories and their own Eats/Avoid
 * mark all still apply. The two reads are INDEPENDENT — one failing must not discard the other's
 * refs, or a broken catalog-ref read would silently un-block a mapped food the coach listed.
 */
/**
 * PostgREST returns an ARRAY for a to-many embedded resource and an OBJECT for one it can prove
 * is to-one. `food_refs.user_food_id`'s unique index is PARTIAL (`where user_food_id is not
 * null`), which is why the answer is an array today — pinned live in
 * tests/search/policy-refs-embed.test.ts. This reads either, so an upgrade that changes its mind
 * cannot turn every mapped food's search into a 500.
 */
export function refsOfEmbed(embed: unknown): string[] {
  const rows = Array.isArray(embed) ? embed : embed ? [embed] : [];
  return rows.map((row) => (row as { id?: string }).id).filter((id): id is string => !!id);
}

/** The four codes a search/detail card's simplified `per100g` ever shows (energy has two). */
const SIMPLE_NUTRIENT_CODES = ["energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total"];

type PortionNutrientEntry = {
  realPortions: RealPortionInput[];
  kcalPer100g: number | null;
  per100g: { protein: number | null; carbs: number | null; fat: number | null };
};

/**
 * One extra batched read over the revision ids a search is about to return: their real portions
 * and the four nutrient codes a card shows (energy, protein, carbs, fat — `SIMPLE_NUTRIENT_CODES`).
 * Two `.in("food_revision_id", …)` reads run together; the nutrient read brings back every code a
 * revision carries (catalog_food_nutrients has no more than a dozen rows per revision and this
 * runs over at most 25 ids) and filters down to the four this card needs in memory — not at the
 * query level — so this stays one added `.in()` round trip per table, not a second filtered one.
 */
async function portionsAndNutrientsByRevision(
  client: SupabaseClient, revisionIds: number[]
): Promise<Map<number, PortionNutrientEntry>> {
  const out = new Map<number, PortionNutrientEntry>();
  if (revisionIds.length === 0) return out;
  const [portionsRes, nutrientsRes] = await Promise.all([
    client.from("catalog_portions")
      .select("food_revision_id, id, description, gram_weight, is_default, seq")
      .in("food_revision_id", revisionIds),
    client.from("catalog_food_nutrients")
      .select("food_revision_id, nutrient_code, amount_per_100g")
      .in("food_revision_id", revisionIds),
  ]);
  if (portionsRes.error || nutrientsRes.error) {
    throw new HttpError(500, "search_failed", "Search is unavailable right now.");
  }
  type PortionRow = { food_revision_id: number; id: number; description: string | null;
    gram_weight: number; is_default: boolean; seq: number };
  type NutrientRow = { food_revision_id: number; nutrient_code: string; amount_per_100g: number | null };

  const portionsByRevision = new Map<number, PortionRow[]>();
  for (const row of (portionsRes.data ?? []) as PortionRow[]) {
    portionsByRevision.set(row.food_revision_id, [...(portionsByRevision.get(row.food_revision_id) ?? []), row]);
  }
  const nutrientsByRevision = new Map<number, Record<string, number | null>>();
  for (const row of (nutrientsRes.data ?? []) as NutrientRow[]) {
    if (!SIMPLE_NUTRIENT_CODES.includes(row.nutrient_code)) continue;
    const m = nutrientsByRevision.get(row.food_revision_id) ?? {};
    m[row.nutrient_code] = row.amount_per_100g;
    nutrientsByRevision.set(row.food_revision_id, m);
  }
  for (const revisionId of revisionIds) {
    const realPortions = [...(portionsByRevision.get(revisionId) ?? [])]
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({ id: String(p.id), label: p.description ?? "", grams: Number(p.gram_weight),
        isDefault: p.is_default }));
    const n = nutrientsByRevision.get(revisionId) ?? {};
    out.set(revisionId, {
      realPortions,
      kcalPer100g: n.energy_kcal ?? n.energy_kcal_calc ?? null,
      per100g: { protein: n.protein ?? null, carbs: n.carbohydrate ?? null, fat: n.fat_total ?? null },
    });
  }
  return out;
}

async function refIdsByCatalogFood(
  client: SupabaseClient, catalogFoodIds: number[]
): Promise<Map<number, string[]>> {
  const byFood = new Map<number, string[]>();
  if (catalogFoodIds.length === 0) return byFood;
  const add = (foodId: number, refId: string) =>
    byFood.set(foodId, [...(byFood.get(foodId) ?? []), refId]);

  const [catalog, mine] = await Promise.all([
    client.from("food_refs")
      .select("id, catalog_food_id").eq("kind", "catalog").in("catalog_food_id", catalogFoodIds),
    // Their own foods mapped onto these catalog rows, with their refs. RLS scopes it to them, and
    // a tombstoned row is not a mapping any more — lib/foods/prefs-client.ts skips it the same way.
    client.from("user_foods")
      .select("catalog_food_id, food_refs ( id )")
      .is("deleted_at", null)
      .in("catalog_food_id", catalogFoodIds),
  ]);

  if (catalog.error) {
    console.error("food_refs lookup for the policy failed", { error: catalog.error });
  } else {
    for (const row of (catalog.data ?? []) as { id: string; catalog_food_id: number }[]) {
      add(row.catalog_food_id, row.id);
    }
  }

  if (mine.error) {
    console.error("mapped user_foods lookup for the policy failed", { error: mine.error });
  } else {
    for (const row of (mine.data ?? []) as { catalog_food_id: number; food_refs: unknown }[]) {
      for (const refId of refsOfEmbed(row.food_refs)) add(row.catalog_food_id, refId);
    }
  }
  return byFood;
}

/**
 * `PolicyEvidence` carries ONE ref, so when a food has two the one the profile names is the one
 * that decides; otherwise the catalog ref, which is what every other path uses.
 */
function policyRefId(refIds: string[], profile: ConstraintProfile): string | null {
  return refIds.find((id) => profile.avoid_food_ref_ids.includes(id)) ?? refIds[0] ?? null;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

function unwrap<T>(settled: Settled<T>): T {
  if (!settled.ok) throw settled.error;
  return settled.value;
}

export async function activeVersionLabel(client: SupabaseClient): Promise<string> {
  const { data, error } = await client
    .from("catalog_versions")
    .select("version_label")
    .eq("is_active", true)
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new NoActiveCatalogVersion();
  return (data as { version_label: string }).version_label;
}

export async function searchFoods(
  client: SupabaseClient,
  req: FoodSearchRequest
): Promise<FoodSearchResponse> {
  const parsed = parseQuery(req.q);
  const brand = req.brand ?? parsed.brand;
  const prep = req.prep && req.prep !== "unknown" ? req.prep : parsed.prep;
  const limit = Math.min(25, Math.max(1, req.limit ?? 25));
  // The version label and the search need nothing from each other, so they share one round trip.
  // A missing catalog still answers first, exactly as it did when the label was read first.
  // OD08: the typo fold and the dish-marker penalty (lib/search/rerank.ts), off until
  // CATALOG_SEARCH_RERANK=1; off, this is the one RPC call it always was.
  const runSearch = async (q: string): Promise<SearchRow[]> => {
    const { data, error } = await client.rpc("catalog_search", {
      p_q: q,
      p_brand: brand ?? null,
      p_prep: prep ?? null,
      p_limit: limit,
    });
    if (error) throw new HttpError(500, "search_failed", "Search is unavailable right now.");
    return (data ?? []) as SearchRow[];
  };
  const [version, searched] = await Promise.all([
    settle(activeVersionLabel(client)),
    settle(rerankedSearch(parsed.raw, runSearch, searchRerankEnabled())),
  ]);
  const catalogVersion = unwrap(version);
  const hits = unwrap(searched).rows.map(toHit);
  const revisionKeys = hits.map((h) => `catalog_revision:${h.revisionId}`);
  // Review round 2 (sol/FIX): this stage is a genuinely sequential round trip after the
  // catalog_search RPC above — it needs `hits` first — so it is real added latency versus
  // pre-slice-2 search, not a free synchronous check. The finding is right that no before/after
  // p95 sample for THIS route exists yet (§7.1's own tables cover coach and provider-side capture
  // purposes, never `search`); closing it needs `pnpm timings --path search` run against
  // production before and after this slice, which needs production DB access this fixer pass does
  // not have. Argued, not measured, in the meantime: every read below is a single `.in()` against
  // a primary-key or RLS-scoped-then-PK-matched column (food_allergen_evidence, food_key,
  // allergen; user_allergen_checks, user_id, food_key, allergen — 20261118090000_allergen_
  // evidence.sql), over at most `limit` (≤ 25) keys, and all five run in parallel with each other,
  // so the addition is one indexed round trip, not `limit` of them.
  const [profile, ingredients, refIds, evidence, checks, portionsAndNutrients] = await Promise.all([
    loadUserProfile(client),
    allergenTagsByRevision(client, hits.map((h) => h.revisionId)),
    refIdsByCatalogFood(client, hits.map((h) => h.catalogFoodId)),
    readAllergenEvidence(client, revisionKeys),
    // RLS scopes user_allergen_checks to the caller; no user id is needed to read their own.
    readAllergenChecks(client, null, revisionKeys),
    portionsAndNutrientsByRevision(client, hits.map((h) => h.revisionId)),
  ]);
  for (const hit of hits) {
    const key = `catalog_revision:${hit.revisionId}`;
    const serving = portionsAndNutrients.get(hit.revisionId);
    const kcalPer100g = serving?.kcalPer100g ?? null;
    const { portions, defaultPortion } = buildPortions(serving?.realPortions ?? [], kcalPer100g);
    hit.kcalPer100g = kcalPer100g;
    hit.per100g = serving ? { kcal: kcalPer100g, protein: serving.per100g.protein,
      carbs: serving.per100g.carbs, fat: serving.per100g.fat } : null;
    hit.portions = portions;
    hit.defaultPortion = defaultPortion;
    const revisionText = ingredients.ingredientsText.get(hit.revisionId) ?? null;
    const hasRows = ingredients.tags.has(hit.revisionId);
    const revisionTags = ingredients.tags.get(hit.revisionId) ?? [];
    // ORCHESTRATOR fix (round 7, item 5): the same parsed-name fallback getFoodDetail already
    // applies (namedAllergenHints only ever adds `listed`, never certifies completeness).
    //
    // sol BLOCK (finding #3, review round 1): must run regardless of whether `revisionText`
    // exists — gating it off entirely whenever ANY revision text was present (even seq 1's own
    // unrelated fragment) dropped a later row's parsed ingredient NAME with no `allergen_tags` of
    // its own, the exact presence signal this fallback exists to catch. Completeness is already
    // its own separate gate (`ingredientsTextIsLabel` below); nameHints only ever adds `listed`.
    const nameHints = namedAllergenHints(
      (ingredients.names.get(hit.revisionId) ?? []).join(", "), profile.avoid_allergens);
    hit.policy = evaluatePolicy(profile, {
      foodRefId: policyRefId(refIds.get(hit.catalogFoodId) ?? [], profile),
      allergenTags: hasRows || nameHints.length > 0 ? [...revisionTags, ...nameHints] : null,
      allergenEvidence: evidence.get(key) ?? {},
      checkedAllergens: checks.get(key) ?? [],
      ingredientsText: revisionText,
      // finding #2: whether `revisionText` is genuinely the label's own verbatim statement
      // (`completenessText`'s own flag) — false for the joined split-row/no-raw_text fallback, so
      // it can still be keyword-scanned for `listed` but never certified "complete" enough to
      // clear an allergen a later split-off row actually named.
      ingredientsTextIsLabel: ingredients.ingredientsVerbatim.get(hit.revisionId) ?? true,
      foodName: hit.description,
      foodBrand: hit.brand,
      // 2026-10-02 DeepSeek audit (F2, MED): packaged by definition for a branded USDA row or an
      // Open Food Facts hit — `brand` alone cannot be the only disqualifier (an unbranded store
      // label is still packaged).
      packaged: isPackagedCatalogSource(hit.source),
      category: hit.policyCategories,
      onEatsList: hit.prefStatus === "eats",
      onAvoidList: hit.prefStatus === "avoid",
    });
  }
  const queryClass = classifyQuery({ ...parsed, brand: brand ?? null });
  const autoResolve = shouldAutoResolve(hits, queryClass)
    ? {
        revisionId: hits[0].revisionId,
        score: hits[0].score,
        margin: Number((hits[0].score - hits[1].score).toFixed(4)),
      }
    : null;
  return { hits, queryClass, autoResolve, catalogVersion };
}

// finding #10: `raw_text` joins the select now, so the detail read can judge completeness off the
// product's own verbatim printed statement — the same seq-1 convention the search path
// (allergenTagsByRevision above) and lib/server/barcode.ts already use — instead of a lossy join
// of just the parsed ingredient NAMES, which reads as neither the real text nor a genuine crop.
const DETAIL_SELECT = `
  id, catalog_food_id, description, brand, category, policy_categories, prep_state,
  quality_class, quality_flags,
  catalog_foods!inner ( source ),
  catalog_food_nutrients ( nutrient_code, amount_per_100g, catalog_nutrients ( unit ) ),
  catalog_portions ( id, description, gram_weight, is_default, seq ),
  catalog_ingredients ( seq, name, allergen_tags, raw_text )`;

type DetailRow = {
  id: number; catalog_food_id: number; description: string; brand: string | null;
  category: string | null; policy_categories: string[] | null;
  prep_state: PrepState | null; quality_class: QualityClass;
  quality_flags: string[]; catalog_foods: { source: CatalogSource };
  catalog_food_nutrients: {
    nutrient_code: string; amount_per_100g: number | null; catalog_nutrients: { unit: string } | null;
  }[];
  catalog_portions: { id: number; description: string; gram_weight: number; is_default: boolean; seq: number }[];
  catalog_ingredients: { seq: number; name: string; allergen_tags: string[]; raw_text: string | null }[];
};

/**
 * Their own mark for this catalog food. The refs it might hang on come from refIdsByCatalogFood.
 *
 * This one still THROWS where the ref lookup degrades, and that is deliberate: the detail read
 * has answered `detail_failed` on this table since before T9, and a detail sheet that quietly
 * renders "allowed" because it could not read their Avoid mark is worse than one that says it
 * could not be read. Only the `avoid_food_ref_ids` lookup T9 added is allowed to go missing.
 */
async function prefStatusFor(
  client: SupabaseClient,
  catalogFoodId: number
): Promise<"eats" | "avoid" | null> {
  const { data, error } = await client
    .from("food_refs")
    .select("user_food_prefs ( status )")
    .eq("kind", "catalog")
    .eq("catalog_food_id", catalogFoodId)
    .maybeSingle();
  if (error) throw new HttpError(500, "detail_failed", "That food could not be read right now.");
  const prefs = (data as { user_food_prefs?: { status: "eats" | "avoid" }[] } | null)?.user_food_prefs;
  return prefs && prefs.length > 0 ? prefs[0].status : null;
}

/**
 * `catalogVersion` is the label a caller already holds — a search that just read it — so a detail
 * read per search hit does not read it again (2026-09-23: that was one extra round trip on every
 * `search_foods` the coach made). Without it, the label is read beside the revision, not before.
 */
export async function getFoodDetail(
  client: SupabaseClient, id: number, opts: { catalogVersion?: string } = {},
): Promise<FoodDetail> {
  const [version, { data, error }] = await Promise.all([
    opts.catalogVersion === undefined
      ? settle(activeVersionLabel(client))
      : Promise.resolve({ ok: true as const, value: opts.catalogVersion }),
    client
      .from("catalog_food_revisions")
      .select(DETAIL_SELECT)
      .eq("catalog_food_id", id)
      .eq("is_active", true)
      .maybeSingle(),
  ]);
  const catalogVersion = unwrap(version);
  if (error) throw new HttpError(500, "detail_failed", "That food could not be read right now.");
  if (!data) throw new HttpError(404, "not_found", "No active revision for that food.");
  const row = data as unknown as DetailRow;
  const per100g: FoodDetail["per100g"] = {};
  for (const n of row.catalog_food_nutrients ?? []) {
    per100g[n.nutrient_code] = { amount: n.amount_per_100g, unit: n.catalog_nutrients?.unit ?? "" };
  }
  // UI lane contract (lib/foods/portions.ts): the same energy fallback mapCatalogFoodHit
  // (lib/server/coach.ts) and portionsAndNutrientsByRevision (search, above) both use.
  const kcalPer100g = per100g.energy_kcal?.amount ?? per100g.energy_kcal_calc?.amount ?? null;
  const simplePer100g: FoodDetail["simplePer100g"] = {
    kcal: kcalPer100g,
    protein: per100g.protein?.amount ?? null,
    carbs: per100g.carbohydrate?.amount ?? null,
    fat: per100g.fat_total?.amount ?? null,
  };
  const portions = [...(row.catalog_portions ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .map((p) => ({ id: p.id, description: p.description, gramWeight: p.gram_weight, isDefault: p.is_default }));
  const { portions: servingPortions, defaultPortion } = buildPortions(
    portions.map((p) => ({ id: String(p.id), label: p.description ?? "", grams: p.gramWeight,
      isDefault: p.isDefault })),
    kcalPer100g,
  );
  // Their mark, their rules and the refs depend on nothing but the revision row above, so they go
  // together rather than one after another — three round-trips deep on a phone is a visible wait.
  const revisionKey = `catalog_revision:${row.id}`;
  const [prefStatus, profile, refIds, evidence, checks] = await Promise.all([
    prefStatusFor(client, row.catalog_food_id),
    loadUserProfile(client),
    refIdsByCatalogFood(client, [row.catalog_food_id]),
    readAllergenEvidence(client, [revisionKey]),
    readAllergenChecks(client, null, [revisionKey]),
  ]);
  const allergenEvidence = evidence.get(revisionKey) ?? {};
  const checkedAllergens = checks.get(revisionKey) ?? [];
  const ingredients = [...(row.catalog_ingredients ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .map((i) => ({ seq: i.seq, name: i.name, allergenTags: i.allergen_tags ?? [] }));
  // sol BLOCK (finding #2, review round 1): the text the POLICY reads for completeness comes from
  // `completenessText`, with its own `verbatim` flag — seq 1's raw_text alone is only trusted as
  // the complete label when no later row carries its own split raw_text too (the same shape
  // lib/server/barcode.ts's toMatch already guards against). A later row's own raw_text (the
  // label was split across rows, not just parsed into names) makes the joined text non-verbatim:
  // still scannable for a keyword `listed`, never "complete" enough to clear an allergen that
  // split-off row actually named.
  const list = completenessText((row.catalog_ingredients ?? []).filter((i) => i.seq >= 1));
  // finding #10 (fixer pass): the SAME `list.text` above, not seq 1's raw_text fragment alone —
  // the same convention allergenTagsByRevision (search) and lib/server/barcode.ts's toMatch
  // already use for this table. `ingredientsText` and `ingredientsTextIsLabel` must always
  // describe the same string; returning seq 1's fragment here while flagging it with the fuller
  // text's own `verbatim` let a caller downstream (lib/server/coach.ts mapCatalogFoodHit) scan
  // only the fragment and miss an allergen a later split-off row actually named.
  const ingredientsText = list.text;
  // r4 BLOCK #10 (follow-up): no verbatim text to read completeness from is not a reason to lose
  // the PRESENCE signal a parsed ingredient NAME can still carry (e.g. a row named "peanut" with
  // no allergen_tags entry of its own) — namedAllergenHints only ever adds `listed`, never judges
  // completeness from the same lossy join this fix closed. Scans the account's own named
  // allergens too (`profile.avoid_allergens`), not only the fixed EVIDENCE_KEYS vocabulary — an
  // account-defined "mustard"/"apple" row is matched deterministically the same way tags are.
  //
  // sol BLOCK (review round 2): must run regardless of whether `ingredientsText` exists — gating
  // it off entirely whenever seq 1 carried ANY raw_text (even an unrelated fragment) dropped a
  // later row's parsed ingredient NAME with no `allergen_tags` of its own, the exact presence
  // signal this fallback exists to catch. Mirrors the identical fix `searchFoods` already applies
  // (finding #3, review round 1) — completeness stays `ingredientsTextIsLabel`'s own separate
  // gate; nameHints only ever adds `listed`.
  const nameHints = namedAllergenHints(
    ingredients.map((i) => i.name).join(", "), profile.avoid_allergens);
  const policyCategories = policyCategoriesOf(row.policy_categories,
    { description: row.description, category: row.category });
  const policy = evaluatePolicy(profile, {
    foodRefId: policyRefId(refIds.get(row.catalog_food_id) ?? [], profile),
    allergenTags: ingredients.length > 0 || nameHints.length > 0
      ? [...ingredients.flatMap((i) => i.allergenTags), ...nameHints] : null,
    allergenEvidence, checkedAllergens,
    ingredientsText: list.text,
    ingredientsTextIsLabel: list.verbatim,
    foodName: row.description,
    foodBrand: row.brand,
    // 2026-10-02 DeepSeek audit (F2, MED): same reading as searchFoods above.
    packaged: isPackagedCatalogSource(row.catalog_foods.source),
    category: policyCategories,
    onEatsList: prefStatus === "eats",
    onAvoidList: prefStatus === "avoid",
  });
  return {
    catalogFoodId: row.catalog_food_id,
    revisionId: row.id,
    description: row.description,
    brand: row.brand,
    source: row.catalog_foods.source,
    qualityClass: row.quality_class,
    qualityFlags: row.quality_flags ?? [],
    prepState: row.prep_state,
    score: 0,
    prefStatus,
    policy,
    allergenEvidence, checkedAllergens, heldAllergens: heldAllergenKeys(allergenEvidence),
    ingredientsText, ingredientsTextIsLabel: list.verbatim, nameOnlyAllergenHints: nameHints,
    category: row.category,
    policyCategories,
    catalogVersion,
    attribution: attributionFor(row.catalog_foods.source, catalogVersion),
    per100g,
    portions,
    kcalPer100g,
    simplePer100g,
    servingPortions,
    defaultPortion,
    ingredients,
  };
}
