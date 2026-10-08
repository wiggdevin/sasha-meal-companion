import type { StoredAllergenEvidence } from "@/lib/policy/allergens";
/**
 * The only module that reaches I/O for a coach tool — spec invariant 2: every executor is
 * (userId, args), and no schema has a user, account or other-user field to fill. The I/O itself
 * arrives as injected ports, so tests use doubles and Lane Q's reads (activeTargets,
 * latestEstimate) can be stubbed until Q lands.
 *
 * draft_log_entry builds a CoachDraft in memory and writes nothing (invariant 3).
 */

import type { ComposedMeal } from "@/lib/coach/compose";
import type { CoachDraft, SlotId } from "@/lib/coach/types";
import type { ToolName } from "@/lib/coach/registry";
import type { LookupToolResult } from "@/lib/coach/lookup-types";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

export type SuggestInput = {
  kind: "meal" | "snack" | "recipe";
  count?: number;
  slot?: SlotId;
  fitRemaining?: boolean;
  wish?: string;
  /**
   * Plan-sheet chips (lib/plan/chips.ts, POST /api/plan/ideas). Every field is optional and, when
   * absent, the build is unchanged. They shape only the admitted-pool build
   * (lib/coach/suggest-pool.ts, lib/coach/suggest-shape.ts); none is a model or wire field.
   */
  /** The viewed local date, for the plate rotation (else the server's UTC day). */
  date?: string;
  /** Title each card by its plate ("Eggs with toast") instead of the wish or kind. */
  plateTitles?: boolean;
  /** "High protein": plates that meet the slot's protein first, then by protein share. */
  proteinFirst?: boolean;
  /** "Ready in 15 min": only plates whose derived prep time (lib/plan/prep-minutes.ts) fits. */
  maxMinutes?: number;
  /** "Use what I have": build from the on-hand set (`SuggestPorts.onHand`), Favored as fallback. */
  onHandOnly?: boolean;
  /** "Something light": calories, carbs and fat scaled by this share (0.5-1). Protein never shrinks. */
  sizeScale?: number;
  /** "Surprise me": plates the account's history knows least rank first. */
  novelty?: boolean;
  /** Ideas said no to ("Not this"), by `ComposedMeal.ideaId`: never offered again. */
  excludeIds?: readonly string[];
};
export type RecipeSuggestionResult = { candidates: RecipeCandidate[]; noResultReasons: string[];
  /** False when no recipe carries every word of the wish: the cards are the closest recipes. */
  exactMatch?: boolean };

export type GutRow = { local_date: string; state: string; note: string | null };
export type FoodHit = {
  foodRefId: string | null; name: string; brand: string | null;
  kcalPer100g: number | null; prefStatus: "eats" | "avoid" | null;
  catalogFoodRevisionId?: number | null;
  /**
   * The food's wire key (lib/meals/food-key.ts): `food:<user_foods.id>` for the account's own food,
   * `catalog:<catalog_foods.id>` for a catalog food. Absent when the producer does not know it.
   * Carried onto a composed item so a Plan-sheet or suggestion-card tap can name its food in a
   * Phase 18 W6 signal event; never used by the policy.
   */
  foodKey?: string;
  proteinPer100g?: number | null; carbsPer100g?: number | null; fatPer100g?: number | null;
  /** The ingredient evidence the policy pass needs; absent means "no evidence", not "clean". */
  allergenTags?: string[] | null;
  /** Phase 13 §5: stored evidence per allergen for this revision; absent means no_evidence. */
  allergenEvidence?: Readonly<Record<string, StoredAllergenEvidence>>;
  /** Allergens this user marked checked for this exact product. */
  checkedAllergens?: readonly string[];
  /** The revision's ingredient text, when known: it can only add `listed`. */
  ingredientsText?: string | null;
  /**
   * sol BLOCK (r5): whether `ingredientsText` is a genuine printed/scanned label, not a
   * self-authored custom food's own field (§9 R2). Defaults true when absent — every catalog and
   * scanned-label caller already passes real label text.
   */
  ingredientsTextIsLabel?: boolean;
  /** The revision's `policy_categories` (lib/catalog/category-map.ts), never provider text. */
  category?: string[] | null;
  /**
   * The catalog's default household portion in grams — "1 cup", "1 medium" — so a coach action
   * that names a food and no quantity has one real number to use instead of the model's priors
   * (T6 §3). Null when the row has no portions.
   */
  portionGrams?: number | null;
  /** The label that portion carries, for the card and for the reply. */
  portionLabel?: string | null;
  /**
   * 2026-10-02 DeepSeek audit (F2, MED): true for a branded USDA row or an Open Food Facts hit
   * (lib/catalog/category-map.ts isPackagedCatalogSource) — packaged by definition, whether or not
   * `brand` above happens to be set. Without it, every coach lane that reaches policy through a
   * `FoodHit` (lib/coach/policy.ts allergenFacts) judged a packaged product by its name alone.
   */
  packaged?: boolean;
};

export type ExecutorPorts = {
  dayTotals: (userId: string, date: string) => Promise<unknown>;
  weekTotals: (userId: string, weekStart: string) => Promise<unknown>;
  activeTargets: (userId: string) => Promise<unknown>;
  latestEstimate: (userId: string) => Promise<unknown>;
  searchFoods: (
    userId: string, query: string, limit: number, signal?: AbortSignal,
  ) => Promise<FoodHit[]>;
  getConstraints: (userId: string) => Promise<unknown>;
  recentGut: (userId: string, days: number) => Promise<GutRow[]>;
  /** T6 §2: the resolved plan for one local date, the same shape the context block carries. */
  dayPlan: (userId: string, date: string) => Promise<unknown>;
  /** T6 §2: the entries logged on one local date, with their ids and their clock times. */
  dayEntries: (userId: string, date: string) => Promise<unknown>;
  /** T6 §2: every saved recipe, for when the context block could not carry them all. */
  recipes: (userId: string) => Promise<unknown>;
  /** T6 §4: a real meal for a wish, sized to the slot target or to what is still to eat. */
  compose: (userId: string, args: ComposeArgs) => Promise<ComposedMeal>;
  /** Several policy-clean composed cards, ranked without writing anything. */
  suggest: (userId: string, args: SuggestInput) => Promise<ComposedMeal[] | RecipeSuggestionResult>;
  /**
   * Phase 13 §3.3 (slice 6): a web-grounded fact about ONE already-resolved subject. `subject` is
   * the model's candidate text, validated and resolved to a real catalog product or brand/food
   * field before any search runs (§9 R8) — never sent to search verbatim.
   */
  lookup: (userId: string, subject: string) => Promise<LookupToolResult>;
  newDraftId: () => string;
  /** What skipping one meal on one date would do (lib/plan/skip-preview.ts). Writes nothing. */
  skipPreview?: (userId: string, date: string, slot: string) => Promise<unknown>;
};

export type Executor = (userId: string, args: unknown) => Promise<unknown>;
export type DraftResult = { draft: CoachDraft | null; dropped: string[] };

export const DEFAULT_GUT_DAYS = 14;
export const DEFAULT_SEARCH_LIMIT = 5;

type DayArgs = { date: string };
type WeekArgs = { weekStart: string };
type SearchArgs = { query: string; limit?: number };
type GutArgs = { days?: number };
type DraftArgs = { slot: string; items: { name: string; grams: number }[] };
export type ComposeArgs = { wish: string; slot?: string; servings?: number };
type LookupArgs = { subject: string };
type SkipArgs = { date: string; slot: string };

export function makeExecutors(ports: ExecutorPorts): Record<ToolName, Executor> {
  return {
    get_day: (userId, args) => ports.dayTotals(userId, (args as DayArgs).date),
    get_week_totals: (userId, args) => ports.weekTotals(userId, (args as WeekArgs).weekStart),
    get_targets: (userId) => ports.activeTargets(userId),
    get_expenditure_status: (userId) => ports.latestEstimate(userId),
    search_foods: (userId, args) => {
      const a = args as SearchArgs;
      return ports.searchFoods(userId, a.query, a.limit ?? DEFAULT_SEARCH_LIMIT);
    },
    get_constraints: (userId) => ports.getConstraints(userId),
    get_recent_gut_log: (userId, args) =>
      ports.recentGut(userId, (args as GutArgs).days ?? DEFAULT_GUT_DAYS),
    compose_meal: (userId, args) => ports.compose(userId, args as ComposeArgs),
    suggest_options: (userId, args) => ports.suggest(userId, args as SuggestInput),
    get_recipes: (userId) => ports.recipes(userId),
    get_plan: (userId, args) => ports.dayPlan(userId, (args as DayArgs).date),
    get_entries: (userId, args) => ports.dayEntries(userId, (args as DayArgs).date),
    lookup: (userId, args) => ports.lookup(userId, (args as LookupArgs).subject),
    preview_skip: async (userId, args) => {
      const a = args as SkipArgs;
      if (!ports.skipPreview) return { ok: false, reason: "Skip previews are not available here." };
      return ports.skipPreview(userId, a.date, a.slot);
    },
    draft_log_entry: async (userId, args): Promise<DraftResult> => {
      const a = args as DraftArgs;
      const items: CoachDraft["items"] = [];
      const dropped: string[] = [];
      for (const row of a.items) {
        const [hit] = await ports.searchFoods(userId, row.name, 1);
        // An ungrounded food is dropped, never given an invented ref: CoachDraft.items
        // carries a real food_refs id, and the confirm sheet commits against it.
        if (!hit || hit.foodRefId === null) { dropped.push(row.name); continue; }
        items.push({
          foodRefId: hit.foodRefId, name: row.name, grams: row.grams,
          catalogFoodRevisionId: null,
        });
      }
      if (items.length === 0) return { draft: null, dropped };
      return { draft: { draftId: ports.newDraftId(), slot: a.slot, items }, dropped };
    },
  };
}
