import type { SupabaseClient } from "@supabase/supabase-js";
import { hydrateChart, type ChartArgs, type KcalChartRow, type WeightChartRow }
  from "@/lib/coach/blocks/hydrate-chart";
import { hydrateFoodIdeas } from "@/lib/coach/blocks/hydrate-food-ideas";
import { hydrateFoodSearch, type FoodSearchArgs }
  from "@/lib/coach/blocks/hydrate-food-search";
import { hydrateQuickReplies } from "@/lib/coach/blocks/quick-replies";
import type { FoodHit } from "@/lib/coach/executors";
import type { RecipeSuggestionResult } from "@/lib/coach/executors";
import { uiBlockSchema, type UiBlock } from "@/lib/coach/ui-blocks";
import type { NormalizedSample } from "@/lib/health/contract";
import { localDateOf, rollUpDay } from "@/lib/health/daily";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import type { CoachContext } from "@/lib/server/coach-context";
import { buildDayContext } from "@/lib/server/day-context";

export type DirectBlockToolName = "show_chart" | "quick_replies";
export type BlockHydrationContext = {
  admin: SupabaseClient;
  userId: string;
  date: string;
  tz: string;
  context: CoachContext | null;
  profile: ConstraintProfile;
  newId: () => string;
  weightUnit?: "lb" | "kg";
};
export type HydratedTool = { data: unknown; block: UiBlock | null };

const DAY_MS = 86_400_000;

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function validBlock(candidate: UiBlock | null): UiBlock | null {
  if (!candidate) return null;
  const parsed = uiBlockSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

async function weightRows(ctx: BlockHydrationContext, days: number): Promise<WeightChartRow[]> {
  const from = shiftDate(ctx.date, -(days - 1));
  const lower = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString();
  const upper = new Date(Date.parse(`${ctx.date}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const { data, error } = await ctx.admin.from("health_samples")
    .select("value, unit, start_time, end_time, tz, device_label, vendor_sample_id, "
      + "health_sources(kind)")
    .eq("user_id", ctx.userId).eq("type", "body_mass")
    .gte("start_time", lower).lt("start_time", upper)
    .order("start_time", { ascending: true });
  if (error) throw error;
  type WeightSample = Omit<NormalizedSample, "type"> & {
    health_sources: { kind: string } | null;
  };
  const buckets = new Map<string, NormalizedSample[]>();
  for (const raw of (data ?? []) as unknown as WeightSample[]) {
    const sample: NormalizedSample = {
      type: "body_mass", value: Number(raw.value), unit: raw.unit,
      start_time: raw.start_time, end_time: raw.end_time, tz: raw.tz,
      device_label: raw.device_label ?? undefined,
      vendor_sample_id: raw.vendor_sample_id ?? undefined,
      source_kind: raw.health_sources?.kind,
    };
    const date = localDateOf(sample.start_time, sample.tz);
    if (date < from || date > ctx.date) continue;
    const bucket = buckets.get(date);
    if (bucket) bucket.push(sample); else buckets.set(date, [sample]);
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).flatMap(([localDate, samples]) => {
    const kg = rollUpDay(samples, samples[0].tz).body_mass_kg;
    return kg === null ? [] : [{ localDate, bodyMassKg: kg }];
  });
}

async function kcalRows(ctx: BlockHydrationContext): Promise<KcalChartRow[]> {
  // daily_energy has one row per user and logged date, so the database — not this process — owns
  // both distinctness and the seven-day bound. (The old energy_kcal_calc filter on daily_totals
  // skipped a day whose items carried only reported energy.)
  const { data, error } = await ctx.admin.from("daily_energy").select("local_date")
    .eq("user_id", ctx.userId)
    .lte("local_date", ctx.date).order("local_date", { ascending: false }).limit(7);
  if (error) throw error;
  const dates = (data ?? []).flatMap((row) => {
    const date = (row as { local_date?: unknown }).local_date;
    return typeof date === "string" ? [date] : [];
  }).sort();
  const days = await Promise.all(dates.map((date) => date === ctx.date && ctx.context
    ? ctx.context.day
    : buildDayContext(ctx.admin, ctx.userId, date, ctx.tz)));
  // A day with no target revision has no target row to chart; omit it rather than invent a number.
  return days.flatMap((day) => day.targets === null ? [] : [{
    localDate: day.date, consumedKcal: day.consumed.kcal, targetKcal: day.targets.kcal,
  }]);
}

/** The account's own display unit (`user_settings.weight_unit`), so a chart opened right after a
 *  weigh-in speaks the unit it was logged in. lb only when the account has never chosen. */
async function accountWeightUnit(ctx: BlockHydrationContext): Promise<"lb" | "kg"> {
  if (ctx.weightUnit) return ctx.weightUnit;
  const { data, error } = await ctx.admin.from("user_settings").select("weight_unit")
    .eq("user_id", ctx.userId).maybeSingle();
  if (error) throw error;
  return data?.weight_unit === "kg" ? "kg" : "lb";
}

async function chartBlock(args: ChartArgs, ctx: BlockHydrationContext): Promise<UiBlock | null> {
  if (args.chart === "weight_trend") {
    return hydrateChart(args, {
      id: ctx.newId(), weightUnit: await accountWeightUnit(ctx),
      weightRows: await weightRows(ctx, args.days ?? 30),
    });
  }
  if (args.chart === "macros_today") {
    // A day with no revision has `targets: null`; narrow it away rather than
    // chart a zero ring (design §5.3).
    const day = ctx.context?.day;
    const targets = day?.targets ?? null;
    // The server's `dayHasPartialNutrition` (lib/server/day-context.ts `consumedPartial`), or a
    // partial check that could not run: either way "consumed" is not a whole count. The model's
    // acknowledgement below carries only the chart name and point count, never this flag.
    return hydrateChart(args, {
      id: ctx.newId(), day: day && targets ? {
        consumed: day.consumed, targets,
        partial: day.consumedPartial || day.nutritionUnchecked === true,
      } : undefined,
    });
  }
  return hydrateChart(args, { id: ctx.newId(), kcalRows: await kcalRows(ctx) });
}

function emptyChartMessage(chart: ChartArgs["chart"]): string {
  if (chart === "weight_trend") return "No weigh-ins yet.";
  if (chart === "kcal_week") return "No logged days yet.";
  return "Today's macro data is unavailable.";
}

export function isDirectBlockTool(name: string): name is DirectBlockToolName {
  return name === "show_chart" || name === "quick_replies";
}

export async function runDirectBlockTool(
  name: DirectBlockToolName,
  args: unknown,
  ctx: BlockHydrationContext,
): Promise<HydratedTool> {
  const block = validBlock(name === "show_chart"
    ? await chartBlock(args as ChartArgs, ctx)
    : hydrateQuickReplies(ctx.newId(), (args as { options: string[] }).options));
  return {
    block,
    data: block ? name === "show_chart"
      ? {
          ok: true, block: "chart", chart: block.kind === "chart" ? block.chart : "unknown",
          points: block.kind === "chart"
            ? block.series.reduce((total, series) => total + series.points.length, 0) : 0,
        }
      : { ok: true, block: "quick_replies", options: block.kind === "quick_replies"
          ? block.options.length : 0 }
      : { available: false, message: name === "show_chart"
          ? emptyChartMessage((args as ChartArgs).chart)
          : "No safe reply options were available." },
  };
}

function foodSearchAck(block: Extract<UiBlock, { kind: "food_search" }>) {
  const statusCounts = { eats: 0, avoid: 0, neutral: 0 };
  for (const row of block.results) statusCounts[row.status] += 1;
  return {
    ok: true, block: "food_search", matches: block.results.length,
    names: block.results.map((row) => row.name), statusCounts,
  };
}

function foodIdeasAck(block: Extract<UiBlock, { kind: "food_ideas" }>) {
  return {
    ok: true,
    block: "food_ideas",
    ideas: block.ideas.map((idea) => ({
      wish: idea.wish,
      slot: idea.slot,
      itemNames: idea.items.map((item) => item.name),
      composerAdded: idea.items.flatMap((item) => item.addedFor
        ? [{ name: item.name, for: item.addedFor }]
        : []),
      fitsTarget: idea.fitsTarget,
    })),
  };
}

export function hydrateRecipeResults(id: string, result: RecipeSuggestionResult): UiBlock {
  return { kind: "recipe_results", v: 1, id, recipes: result.candidates,
    limitations: result.noResultReasons.slice(0, 5),
    ...(typeof result.exactMatch === "boolean" ? { exactMatch: result.exactMatch } : {}) };
}

export function hydrateResolvedTool(
  name: string,
  args: unknown,
  data: unknown,
  ctx: BlockHydrationContext,
): HydratedTool {
  if (name === "search_foods") {
    const search = args as FoodSearchArgs;
    const hits = Array.isArray(data) ? data as FoodHit[] : [];
    const block = validBlock(hydrateFoodSearch(ctx.newId(), search, hits, ctx.profile));
    if (!search.intent || search.intent === "lookup") {
      return { block: null, data: hits.slice(0, search.limit ?? 5) };
    }
    return { block, data: block?.kind === "food_search" ? foodSearchAck(block) : {
      ok: true, block: "food_search", matches: 0, names: [],
      statusCounts: { eats: 0, avoid: 0, neutral: 0 },
    } };
  }
  if (name === "suggest_options" || name === "compose_meal") {
    if (name === "suggest_options" && (args as { kind?: string }).kind === "recipe") {
      const result = data as RecipeSuggestionResult;
      const block = validBlock(hydrateRecipeResults(ctx.newId(), result));
      return { block, data: { ok: true, block: "recipe_results",
        recipes: result.candidates.map((recipe) => ({ id: recipe.recipeId, name: recipe.name })),
        limitations: result.noResultReasons,
        // The model already reads the limitations; it reads whether the cards are an exact match too.
        ...(typeof result.exactMatch === "boolean" ? { exactMatch: result.exactMatch } : {}) } };
    }
    const block = validBlock(hydrateFoodIdeas(ctx.newId(), name === "compose_meal" ? [data] : data));
    return { block, data: block?.kind === "food_ideas" ? foodIdeasAck(block) : {
      ok: true, block: "food_ideas", ideas: [],
    } };
  }
  return { block: null, data };
}
