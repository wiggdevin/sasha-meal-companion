/**
 * What the coach knows about the user's day, injected every turn — T6 §2.
 *
 * Before this, a turn carried today's date in the server timezone and the constraint profile,
 * and nothing else: no slots, no eaten state, no entries, no lists, no recipes. So "change my 4th
 * meal" named a slot the coach could not see, and "what do I have left to eat" needed a tool round
 * that only returned totals.
 *
 * The block is fenced with the same `renderDataBlock` envelope a tool result uses, so it is DATA
 * and never instruction, and it is capped: when a list overflows the block says how many more
 * there are and names the tool that reads the rest.
 *
 * Reads only. No "server-only" marker: tests load this module under vitest.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { renderDataBlock } from "@/lib/coach/envelope";
import { estimateTokens } from "@/lib/coach/tokens";
import type { Intent } from "@/lib/coach/intent";
import type { ActivityContextV1 } from "@/lib/activity/summary";
import { buildDayContext, clockIn, foodNamesFor, type DayContext } from "@/lib/server/day-context";
import { latestEstimate } from "@/lib/server/expenditure";
import { mergedDays } from "@/lib/server/health-daily";
import { classifyWholeFood } from "@/lib/policy/whole-foods";
import { recipeNutritionStatus } from "@/lib/recipes/nutrients";
import { fetchAllRows } from "@/lib/server/paged-read";

export const CONTEXT_TOKEN_CAP = 2_500;
export const LIST_LIMIT = 40;
export const RECIPE_LIMIT = 15;
const FOOD_PREF_PAGE_SIZE = 200;
/** At most this many preference pages per read; a longer list is read as incomplete (t3r4 WARN 5). */
export const FOOD_PREF_MAX_PAGES = 10;

export type FoodLists = {
  eats: string[]; avoid: string[]; eatsMore: number; avoidMore: number;
  /** Every Eats and Avoid name, uncapped. Never rendered; coach memory grounds food items on it. */
  allNames?: string[];
  /** False if a live preference ref could not be resolved to a food name. */
  allNamesComplete?: boolean;
};
export type RecipeSummary = {
  name: string; servings: number;
  perServing: { kcal: number | null; protein: number | null; carbs: number | null; fat: number | null };
  /**
   * False when some ingredient is unmeasured: `perServing` then sums only the measured items and
   * is a partial count, never the full serving (#21). `coverage` is the stored scalar.
   */
  nutritionComplete: boolean; coverage: number;
  items: string[];
};
export type CoachActivity = {
  stepsToday: number | null;
  deviceActiveKcalToday: number | null;
  currentStepsAvg: number | null;
  currentDays: number | null;
  baselineStepsAvg: number | null;
  baselineDays: number | null;
  activeKcal7dAvg: number | null;
  activeKcalDays: number | null;
  band: ActivityContextV1["band"] | null;
  smoothing: ActivityContextV1["smoothing"] | null;
};
export type CoachContext = {
  now: string; tz: string; date: string;
  day: DayContext;
  lists: FoodLists;
  recipes: RecipeSummary[];
  recipesMore: number;
  profile?: string | null;
  activity?: CoachActivity;
};

type ProfileRow = {
  weight_kg: number | string | null;
  activity_level: string | null;
  goal: string | null;
  diet_prefs: { flags?: unknown } | null;
};

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

export function profileLine(row: ProfileRow | null): string | null {
  if (!row) return null;
  const parts: string[] = [];
  const weight = row.weight_kg === null ? null : Number(row.weight_kg);
  if (weight !== null && Number.isFinite(weight)) parts.push(`${weight} kg`);
  if (row.activity_level) parts.push(`${humanize(row.activity_level)} activity`);
  if (row.goal) parts.push(`goal ${humanize(row.goal)}`);
  const rawFlags = row.diet_prefs?.flags;
  const flags = Array.isArray(rawFlags)
    ? rawFlags.filter((flag): flag is string => typeof flag === "string" && flag.length > 0)
      .map(humanize)
    : [];
  if (parts.length === 0 && flags.length === 0) return null;
  const profile = parts.join(", ");
  const preferences = flags.length > 0
    ? `${profile ? "; " : ""}prefers: ${flags.join(", ")}` : "";
  return `Profile: ${profile}${preferences}`;
}

async function profileContext(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await client.from("user_settings")
    .select("weight_kg, activity_level, goal, diet_prefs").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return profileLine(data as ProfileRow | null);
}

export type CoachContextIntent = { intent: Intent | null; message: string };
const PROFILE_QUESTION_WORDS = /\b(?:weigh|weight|target|targets|calorie|calories|kcal|macro|macros)\b/i;

export function needsProfileContext(value: CoachContextIntent): boolean {
  if (value.intent === "update_profile" || value.intent === "set_targets" || value.intent === "log_weight") {
    return true;
  }
  return value.intent === "question" && PROFILE_QUESTION_WORDS.test(value.message);
}

async function activityContext(
  admin: SupabaseClient, userId: string, date: string,
): Promise<CoachActivity> {
  const [estimate, days] = await Promise.all([
    latestEstimate(admin, userId),
    mergedDays(admin, userId, date, date),
  ]);
  const trend = estimate.activityContext;
  const today = days.find((day) => day.local_date === date);
  return {
    stepsToday: today?.steps ?? null,
    deviceActiveKcalToday: today?.active_kcal ?? null,
    currentStepsAvg: trend?.currentStepsAvg ?? null,
    currentDays: trend?.currentDays ?? null,
    baselineStepsAvg: trend?.baselineStepsAvg ?? null,
    baselineDays: trend?.baselineDays ?? null,
    activeKcal7dAvg: trend?.activeKcal7dAvg ?? null,
    activeKcalDays: trend?.activeKcalDays ?? null,
    band: trend?.band ?? null,
    smoothing: trend?.smoothing ?? null,
  };
}

/** The user's Eats and Avoid lists by name, from `user_food_prefs` — the same rows the policy reads. */
export async function foodLists(
  client: SupabaseClient, userId: string,
): Promise<FoodLists> {
  type Pref = { food_ref_id: string; status: "eats" | "avoid" };
  const rows: Pref[] = [];
  const names = new Map<string, string>();
  let complete = true;
  let after: string | null = null;
  for (let pageNo = 0; ; pageNo += 1) {
    if (pageNo >= FOOD_PREF_MAX_PAGES) {
      complete = false;
      break;
    }
    let query = client.from("user_food_prefs").select("food_ref_id, status")
      .eq("user_id", userId).order("food_ref_id", { ascending: true }).limit(FOOD_PREF_PAGE_SIZE);
    if (after) query = query.gt("food_ref_id", after);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as Pref[];
    const live = page.filter((row) => row.status === "eats" || row.status === "avoid");
    rows.push(...live);
    const resolved = await foodNamesFor(client, live.map((row) => row.food_ref_id));
    for (const row of live) {
      const name = resolved.get(row.food_ref_id);
      if (!name || name === "(unknown food)") complete = false;
      else names.set(row.food_ref_id, name);
    }
    if (page.length < FOOD_PREF_PAGE_SIZE) break;
    const last = page.at(-1)?.food_ref_id;
    if (!last || (after !== null && last <= after)) {
      complete = false;
      break;
    }
    after = last;
  }
  const pick = (status: "eats" | "avoid") => [...new Set(rows.filter((r) => r.status === status)
    .map((r) => names.get(r.food_ref_id)).filter((n): n is string => !!n))].sort();
  const eats = pick("eats");
  const avoid = pick("avoid");
  return {
    eats: eats.slice(0, LIST_LIMIT), avoid: avoid.slice(0, LIST_LIMIT),
    eatsMore: Math.max(0, eats.length - LIST_LIMIT),
    avoidMore: Math.max(0, avoid.length - LIST_LIMIT),
    allNames: [...eats, ...avoid],
    allNamesComplete: complete,
  };
}

/**
 * Suggestions read the whole Eats list, not the 40-name prompt list (2026-10-02): `all` for sides,
 * and `anchors` in the order a card should try them — the account's protein marks, then unmarked
 * foods whose name reads as a protein (lib/policy/whole-foods.ts), then every other Eats name.
 * Before this an 82-food list was cut at "Chicken breast, rotisserie" and walked alphabetically, so
 * the build spent its budget on avocados and shake mixes.
 *
 * 2026-10-02 DeepSeek audit (MED, finding #3): a food marked carb or fat used to be EXCLUDED from
 * `anchors` outright rather than sorted last — an account whose every Eats row carried one of those
 * roles got `anchors: []`, and suggestOptions then returned an empty, message-less result. Those
 * names now sort to the end of `anchors` instead of falling out of it, so `anchors` is only ever
 * empty when `all` is too.
 */
export async function eatsForSuggestions(
  client: SupabaseClient, userId: string,
): Promise<{ all: string[]; anchors: string[] }> {
  const rows = await fetchAllRows<{ food_ref_id: string; role: string | null }>((from, to) =>
    client.from("user_food_prefs").select("food_ref_id, role").eq("user_id", userId)
      .eq("status", "eats").order("food_ref_id").range(from, to));
  const names = await foodNamesFor(client, [...new Set(rows.map((r) => r.food_ref_id))]);
  const named = (role: (value: string | null) => boolean) => [...new Set(rows.filter((r) => role(r.role))
    .map((r) => names.get(r.food_ref_id)).filter((n): n is string => !!n))].sort();
  const unmarked = named((role) => role === null);
  const readsAsProtein = (name: string) => PROTEIN_CLASSES.has(classifyWholeFood({ foodName: name })?.label ?? "");
  const proteinMarked = named((role) => role === "protein");
  const proteinReading = unmarked.filter(readsAsProtein);
  const already = new Set([...proteinMarked, ...proteinReading]);
  const all = named(() => true);
  return { all, anchors: [...proteinMarked, ...proteinReading, ...all.filter((n) => !already.has(n))] };
}

const PROTEIN_CLASSES = new Set(["fish", "shellfish", "poultry", "red meat", "egg", "soy", "legume"]);

/** The user's recipes at their current revision: name, per-serving macros, item names. */
export async function recipeSummaries(
  client: SupabaseClient, userId: string,
): Promise<{ recipes: RecipeSummary[]; more: number }> {
  const { data, error } = await client.from("recipes")
    .select("id, name, servings, rev, recipe_revisions(rev, nutrients_per_serving, "
      + "recipe_items(seq, grams, food_ref_id))")
    .eq("user_id", userId).is("deleted_at", null).order("name", { ascending: true });
  if (error) throw error;
  type RevRow = { rev: number; nutrients_per_serving: Record<string, number | null> | null;
    recipe_items: { seq: number; grams: number | string; food_ref_id: string }[] };
  const rows = (data ?? []) as unknown as {
    id: string; name: string; servings: number | string; rev: number; recipe_revisions: RevRow[] }[];
  const kept = rows.slice(0, RECIPE_LIMIT);
  const refIds = kept.flatMap((row) => (row.recipe_revisions ?? [])
    .flatMap((rev) => rev.recipe_items?.map((item) => item.food_ref_id) ?? []));
  const names = await foodNamesFor(client, [...new Set(refIds)]);
  const recipes = kept.map((row) => {
    const exact = (row.recipe_revisions ?? []).find((rev) => rev.rev === row.rev);
    const current = exact ?? (row.recipe_revisions ?? []).sort((a, b) => b.rev - a.rev)[0];
    const per = current?.nutrients_per_serving ?? {};
    const at = (code: string) => (per[code] == null ? null : Number(per[code]));
    return {
      name: row.name, servings: Number(row.servings),
      perServing: { kcal: at("energy_kcal"), protein: at("protein"),
        carbs: at("carbohydrate"), fat: at("fat_total") },
      // Completeness speaks only for the CURRENT revision: an older one standing in (the numbers
      // above, shown for reference) could read a partial recipe as whole (#21).
      ...recipeNutritionStatus(exact?.nutrients_per_serving),
      items: [...(current?.recipe_items ?? [])].sort((a, b) => a.seq - b.seq)
        .map((item) => names.get(item.food_ref_id) ?? "(unknown food)"),
    } satisfies RecipeSummary;
  });
  return { recipes, more: Math.max(0, rows.length - RECIPE_LIMIT) };
}

export async function buildCoachContext(
  admin: SupabaseClient, client: SupabaseClient, userId: string,
  clock: { now: string; tz: string; date: string },
  // A promise is allowed so a caller can start the reads before the intent is known: only the
  // optional profile section waits for it (2026-09-23 coach latency).
  classified: CoachContextIntent | Promise<CoachContextIntent> = { intent: null, message: "" },
): Promise<CoachContext> {
  const [day, lists, recipes, profile, activity] = await Promise.all([
    buildDayContext(admin, userId, clock.date, clock.tz),
    foodLists(client, userId),
    recipeSummaries(client, userId),
    Promise.resolve(classified).then((value) =>
      needsProfileContext(value) ? profileContext(client, userId) : null),
    process.env.COACH_ACTIVITY_CONTEXT_ENABLED === "true"
      ? activityContext(admin, userId, clock.date) : Promise.resolve(undefined),
  ]);
  return {
    ...clock, day, lists, recipes: recipes.recipes, recipesMore: recipes.more, profile,
    ...(activity ? { activity } : {}),
  };
}

/**
 * The block as it reaches the prompt. Over the cap, the two longest lists are the first to go —
 * the plan and the entries are what the turn is usually about, and `get_plan` / `get_entries`
 * read anything that was dropped.
 */
export function renderCoachContext(context: CoachContext): string {
  const more = (n: number, tool: string) => n > 0 ? `and ${n} more — use ${tool}` : undefined;
  const body = (ctx: CoachContext) => ({
    user_clock: { now: clockIn(ctx.now, ctx.tz), local_date: ctx.date, tz: ctx.tz },
    today: {
      day_type: ctx.day.dayType,
      targets: ctx.day.targets
        ? `${ctx.day.targets.kcal} kcal ${ctx.day.targets.protein}P `
          + `${ctx.day.targets.carbs}C ${ctx.day.targets.fat}F`
        : null,
      // #21: a partly measured recipe serving makes the eaten total a lower bound.
      eaten_so_far: `${ctx.day.consumedPartial ? "at least " : ""}${ctx.day.consumed.kcal} kcal `
        + `${ctx.day.consumed.protein}P ${ctx.day.consumed.carbs}C ${ctx.day.consumed.fat}F`
        + (ctx.day.nutritionUnchecked ? " (recipe nutrition could not be fully checked)" : ""),
      // Written out, not left as a subtraction: "2047 kcal left, 143 g protein, ..." (T6 §2).
      remaining: ctx.day.remaining,
      // #21: a partly measured recipe serving makes `remaining` an upper bound, said in the data.
      ...(ctx.day.consumedPartial ? { remaining_is_upper_bound: true } : {}),
      still_to_eat: ctx.day.targets
        ? ctx.day.stillToEat
        : "Targets are not set. Ask the user to finish the profile.",
      slots: ctx.day.slots.map(({ totals: _totals, ...slot }) => slot),
      entries: ctx.day.entries,
      ...(ctx.day.entriesMore ? { entries_not_shown: more(ctx.day.entriesMore, "get_entries") } : {}),
      ...(ctx.activity ? { activity: {
        steps_today: ctx.activity.stepsToday,
        device_active_kcal_estimate_today: ctx.activity.deviceActiveKcalToday,
        current_steps_average: ctx.activity.currentStepsAvg,
        current_steps_days: ctx.activity.currentDays,
        baseline_steps_average: ctx.activity.baselineStepsAvg,
        baseline_steps_days: ctx.activity.baselineDays,
        active_kcal_7d_average: ctx.activity.activeKcal7dAvg,
        active_kcal_days: ctx.activity.activeKcalDays,
        band: ctx.activity.band,
        smoothing: ctx.activity.smoothing,
      } } : {}),
    },
    lists: {
      eats: ctx.lists.eats, avoid: ctx.lists.avoid,
      ...(ctx.lists.eatsMore ? { eats_not_shown: more(ctx.lists.eatsMore, "search_foods") } : {}),
      ...(ctx.lists.avoidMore ? { avoid_not_shown: more(ctx.lists.avoidMore, "search_foods") } : {}),
    },
    ...(ctx.profile ? { profile: ctx.profile } : {}),
    recipes: ctx.recipes,
    ...(ctx.recipesMore ? { recipes_not_shown: more(ctx.recipesMore, "get_recipes") } : {}),
  });

  let trimmed = context;
  let rendered = renderDataBlock("context", "your day", body(trimmed));
  const shrink: ((c: CoachContext) => CoachContext)[] = [
    (c) => ({ ...c, recipes: c.recipes.slice(0, 5), recipesMore: c.recipesMore + Math.max(0, c.recipes.length - 5) }),
    (c) => ({ ...c, lists: { ...c.lists, eats: c.lists.eats.slice(0, 15),
      eatsMore: c.lists.eatsMore + Math.max(0, c.lists.eats.length - 15) } }),
    (c) => ({ ...c, lists: { ...c.lists, avoid: c.lists.avoid.slice(0, 15),
      avoidMore: c.lists.avoidMore + Math.max(0, c.lists.avoid.length - 15) } }),
    (c) => ({ ...c, recipes: [], recipesMore: c.recipesMore + c.recipes.length }),
    // The entries are the last thing to go, and `get_entries` reads whatever was dropped.
    (c) => ({ ...c, day: { ...c.day, entries: c.day.entries.slice(-6),
      entriesMore: (c.day.entriesMore ?? 0) + Math.max(0, c.day.entries.length - 6) } }),
  ];
  for (const step of shrink) {
    if (estimateTokens(rendered) <= CONTEXT_TOKEN_CAP) break;
    trimmed = step(trimmed);
    rendered = renderDataBlock("context", "your day", body(trimmed));
  }
  return rendered;
}
