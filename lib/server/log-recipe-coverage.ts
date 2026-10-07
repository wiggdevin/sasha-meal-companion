/**
 * Which logged items are a saved recipe whose per-serving nutrition is only partly measured
 * (calculation audit 2026-10-05, #21).
 *
 * A recipe logs through its loggable twin (`user_foods` kind 'recipe', same id as the recipe),
 * whose per_100g is the sum of the ingredients that WERE measured. An entry built from it is
 * recorded — logging marks, it never refuses (docs/decisions/2026-09-14-logging-marks-never-
 * refuses.md) — but it is not a full serving, so the commit answer and the meal export name it.
 *
 * The RECORDED flag wins: since 20261210090400 every log item written from one of the owner's
 * recipes carries `nutrition_partial`, judged at write time against the revision whose numbers
 * its snapshot froze, and kept when the recipe is later completed. Only rows with no recorded flag
 * (written before that migration, or not a recipe at all) fall back to judging the recipe's
 * CURRENT revision — approximate for an old serving whose recipe has since changed.
 *
 * A current revision that is missing, or has no numeric `coverage` (_sync_upsert has written it
 * since 20260919090300), reads as partial: unknown is never whole.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { recipeNutritionStatus } from "@/lib/recipes/nutrients";
import { readByDateChunks } from "@/lib/server/date-chunks";

/**
 * One item named partial: `recorded` at write time (authoritative), `derived` from the recipe's
 * current revision (a row with no recorded flag), or `unchecked` when that fallback could not be
 * read — marked anyway, because an unchecked recipe serving must not pass as a whole one.
 */
export type PartialNutritionMark = {
  path: string; item_id: string | null; seq: number | null; food_ref_id: string;
  /** The current revision's coverage for a derived mark; null when recorded or unchecked. */
  coverage: number | null;
  source: PartialSource;
};

type RevisionRow = { rev: number; nutrients_per_serving: Record<string, unknown> | null };

/** Ids per `.in()` read: well under the 1,000-row cap and a safe URL length. */
export const ID_BATCH = 200;

function batches<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += ID_BATCH) out.push(values.slice(i, i + ID_BATCH));
  return out;
}

/**
 * A read that failed part-way. `userFoodRefs` lists the refs already known to resolve to a user
 * food (null when even that read failed), so a caller can mark only those, not every food.
 */
export class RecipeCoverageReadError extends Error {
  // `userFoodRefs`: refs to recipe twins (or user foods whose kind was not read).
  constructor(readonly cause: unknown, readonly userFoodRefs: ReadonlySet<string> | null) {
    super("recipe coverage unreadable");
  }
}

/**
 * food_ref_id → coverage, for every ref that resolves to a partly measured recipe at its CURRENT
 * revision (the fallback judgement). `userId` scopes the recipe read to its owner (recipe ids are
 * the owner's user-food ids, so the food_refs read needs no owner predicate of its own).
 */
export async function partialRecipeCoverageByRef(
  client: SupabaseClient, refIds: readonly string[], userId?: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(refIds)];
  if (unique.length === 0) return out;
  const userFoodByRef = new Map<string, string>();
  try {
    for (const batch of batches(unique)) {
      const refs = await client.from("food_refs").select("id, user_food_id, user_foods(kind)")
        .in("id", batch);
      if (refs.error) throw refs.error;
      for (const row of (refs.data ?? []) as { id: string; user_food_id: string | null;
        user_foods?: { kind?: string } | null }[]) {
        // Only a recipe twin can be a partial recipe: a custom or label food is never marked,
        // even when the recipe read below fails (review round 6). An unread kind stays a candidate.
        const kind = row.user_foods?.kind;
        if (row.user_food_id && (kind === undefined || kind === "recipe")) {
          userFoodByRef.set(row.id, row.user_food_id);
        }
      }
    }
  } catch (error) {
    throw new RecipeCoverageReadError(error, null);
  }
  const userFoodIds = [...new Set(userFoodByRef.values())];
  if (userFoodIds.length === 0) return out;

  const recipeRows: { id: string; rev: number; recipe_revisions: RevisionRow[] | null }[] = [];
  try {
    for (const batch of batches(userFoodIds)) {
      const query = client.from("recipes")
        .select("id, rev, recipe_revisions(rev, nutrients_per_serving)").in("id", batch);
      const recipes = await (userId ? query.eq("user_id", userId) : query);
      if (recipes.error) throw recipes.error;
      recipeRows.push(...(recipes.data ?? []) as typeof recipeRows);
    }
  } catch (error) {
    throw new RecipeCoverageReadError(error, new Set(userFoodByRef.keys()));
  }
  const coverageByRecipe = new Map<string, number>();
  for (const row of recipeRows) {
    const revisions = row.recipe_revisions ?? [];
    // Only the current revision speaks; an older one standing in could read a partial as whole.
    const current = revisions.find((revision) => revision.rev === row.rev);
    const status = recipeNutritionStatus(current?.nutrients_per_serving);
    if (!status.nutritionComplete) coverageByRecipe.set(row.id, status.coverage);
  }
  for (const [refId, userFoodId] of userFoodByRef) {
    const coverage = coverageByRecipe.get(userFoodId);
    if (coverage !== undefined) out.set(refId, coverage);
  }
  return out;
}

/** A stored item as the readers see it: the recorded flag, when the row has one. */
export type JudgedItem = { food_ref_id: string; nutrition_partial?: boolean | null };

/** How an item's partial judgement was reached. */
export type PartialSource = "recorded" | "derived" | "unchecked";

/**
 * One judgement per item, in order: the recorded flag when present, else the current-revision
 * fallback. `onError` decides an unreadable fallback:
 *   - "throw" fails the read (an export must not print a guess);
 *   - "mark", when the RECIPES read failed: only refs already known to be recipe twins are marked
 *     `unchecked` (a catalog or custom food is never a recipe);
 *   - "mark", when even the food_refs read failed: no item can be told apart from a catalog food,
 *     so NO item is marked partial. The failure is reported once, entry-level, through
 *     `onUnchecked` ("nutrition could not be fully checked") — never as an item-level partial.
 */
export async function judgePartialItems(
  client: SupabaseClient, items: readonly JudgedItem[],
  opts: { onError: "mark" | "throw"; userId?: string; onUnchecked?: () => void },
): Promise<({ source: PartialSource; coverage: number | null } | null)[]> {
  const unrecorded = items.filter((item) => typeof item.nutrition_partial !== "boolean");
  let byRef = new Map<string, number>();
  // When the recipes read failed: the refs known to be recipe twins, which it could not clear.
  let uncheckedTwins: ReadonlySet<string> | null = null;
  if (unrecorded.length > 0) {
    try {
      byRef = await partialRecipeCoverageByRef(client, unrecorded.map((item) => item.food_ref_id),
        opts.userId);
    } catch (error) {
      if (opts.onError === "throw") throw error instanceof RecipeCoverageReadError ? error.cause : error;
      const known = error instanceof RecipeCoverageReadError ? error.userFoodRefs : null;
      console.error(known === null
        ? "[recipe-coverage] food refs unreadable; nutrition reported as unchecked"
        : "[recipe-coverage] recipes unreadable; recipe servings marked unchecked", { error });
      if (known === null) opts.onUnchecked?.();
      uncheckedTwins = known ?? new Set();
    }
  }
  return items.map((item) => {
    if (item.nutrition_partial === true) return { source: "recorded", coverage: null };
    if (item.nutrition_partial === false) return null;
    if (uncheckedTwins !== null) {
      return uncheckedTwins.has(item.food_ref_id) ? { source: "unchecked", coverage: null } : null;
    }
    const coverage = byRef.get(item.food_ref_id);
    return coverage === undefined ? null : { source: "derived", coverage };
  });
}

/**
 * The commit answer's marks, from the items as stored. A failed fallback read never turns a
 * stored meal into a failure (the entry is already written when this runs): recipe twins it could
 * not clear are marked `unchecked`, and a food_refs failure sets `unchecked` for the entry instead.
 */
export async function partialRecipeItems(
  client: SupabaseClient,
  items: readonly (JudgedItem & { id?: string; seq?: number })[], userId?: string,
): Promise<{ marks: PartialNutritionMark[]; unchecked: boolean }> {
  let unchecked = false;
  const judged = await judgePartialItems(client, items,
    { onError: "mark", userId, onUnchecked: () => { unchecked = true; } });
  const marks = items.flatMap((item, index) => {
    const verdict = judged[index];
    return verdict === null ? [] : [{ path: `items.${index}`, item_id: item.id ?? null,
      seq: item.seq ?? null, food_ref_id: item.food_ref_id, coverage: verdict.coverage,
      source: verdict.source }];
  });
  return { marks, unchecked };
}

/** One logged day as the partial check sees it. */
export type EntryDay = {
  items: number; partial: number;
  /** The check could not run for this day's unrecorded items (food refs unreadable). */
  unchecked: boolean;
};

/**
 * Every local date in [fromDate, toDate] that has a logged entry, with its item count and how many
 * of those items are servings of a partly measured recipe. Entries are read in date windows
 * (lib/server/date-chunks.ts) so the API's 1,000-row cap can never silently drop a day — including
 * a day whose only item has an empty snapshot and so has no `daily_totals` row at all.
 * `onError` as judgePartialItems; `unchecked` is true when the check could not run ("mark" only).
 */
export async function entryDaysInWindow(
  client: SupabaseClient, userId: string, fromDate: string, toDate: string,
  onError: "mark" | "throw" = "throw",
): Promise<{ days: Map<string, EntryDay>; unchecked: boolean }> {
  type EntryRow = { local_date: string; id: string; log_items: JudgedItem[] | null };
  const entries = await readByDateChunks<EntryRow>(fromDate, toDate, async (from, to) => {
    const { data, error } = await client.from("log_entries")
      .select("id, local_date, log_items(food_ref_id, nutrition_partial)")
      .eq("user_id", userId).is("deleted_at", null)
      .gte("local_date", from).lte("local_date", to)
      .order("local_date", { ascending: true }).order("id", { ascending: true });
    if (error) throw error;
    return (data ?? []) as EntryRow[];
  }, 31);
  const items = entries.flatMap((entry) => (entry.log_items ?? [])
    .map((item) => ({ ...item, local_date: entry.local_date })));
  let unchecked = false;
  const judged = await judgePartialItems(client, items,
    { onError, userId, onUnchecked: () => { unchecked = true; } });
  const days = new Map<string, EntryDay>();
  for (const entry of entries) {
    if (!days.has(entry.local_date)) days.set(entry.local_date, { items: 0, partial: 0, unchecked: false });
  }
  items.forEach((item, index) => {
    const day = days.get(item.local_date)!;
    day.items += 1;
    if (judged[index]) day.partial += 1;
    // Only a day that HAS an item the failed read left unjudged is unchecked (review round 10).
    if (unchecked && typeof item.nutrition_partial !== "boolean") day.unchecked = true;
  });
  return { days, unchecked };
}

/** Per local date, how many logged items are servings of a partly measured recipe. */
export async function partialRecipeItemsByDate(
  client: SupabaseClient, userId: string, fromDate: string, toDate: string,
): Promise<Map<string, number>> {
  const { days } = await entryDaysInWindow(client, userId, fromDate, toDate, "throw");
  return new Map([...days].filter(([, day]) => day.partial > 0).map(([date, day]) => [date, day.partial]));
}

/**
 * The caveats a day's totals need when a coach tool hands them over (review round 9): a partly
 * measured recipe serving makes the energy a lower bound; a check that could not run is said so.
 */
export function dayTotalsCaveats(day: EntryDay | undefined): Record<string, unknown> {
  return {
    ...(day && day.partial > 0 ? { energy_is_lower_bound: true, partial_recipe_items: day.partial } : {}),
    ...(day?.unchecked ? { nutrition_unchecked: true } : {}),
  };
}
