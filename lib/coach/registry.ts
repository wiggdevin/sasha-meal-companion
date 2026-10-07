/**
 * The only source of coach tools — architecture §4.5, spec "Engines and logic".
 *
 * A static, frozen array. No dynamic registration, no map keyed by name: lookupTool is
 * an Array.find over values, so a model-supplied "__proto__" or "constructor" can never
 * resolve to a function reference (invariant 1). No schema carries a user, account or
 * url field, because user_id is a closure argument in every executor (invariant 2).
 *
 * Pure. No I/O, no Supabase import.
 */

import { z } from "zod";
import { MEAL_SLOT_IDS, SLOT_IDS } from "@/lib/coach/types";

export type ToolName =
  | "get_day" | "get_week_totals" | "get_targets" | "get_expenditure_status"
  | "search_foods" | "get_constraints" | "get_recent_gut_log" | "draft_log_entry"
  | "get_plan" | "get_entries" | "get_recipes" | "compose_meal" | "suggest_options" | "lookup"
  | "preview_skip";
export type BlockToolName = "show_chart" | "quick_replies";
export type RegistryToolName = ToolName | BlockToolName;

export type CoachTool = {
  name: RegistryToolName;
  description: string;
  input: z.ZodType;
  /** "draft" never persists — the confirm sheet plus POST /api/log/commit is the only write path. */
  effect: "read" | "draft";
  maxCallsPerTurn: number;
};

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const noArgs = z.object({});

function expenditureStatusDescription(): string {
  if (process.env.COACH_ACTIVITY_CONTEXT_ENABLED === "true") {
    return "The read-only advisory expenditure status: learned and profile TDEE, learning progress, "
      + "weight trend, confidence, reason, and activity context when available. It never proposes "
      + "or sets a target.";
  }
  return "The advisory expenditure estimate: status (burn_in, held, estimating or blocked), the TDEE "
    + "number when there is one, the weight trend and the confidence. Advisory only — never a target.";
}

export const REGISTRY: readonly CoachTool[] = Object.freeze([
  {
    name: "get_day",
    description:
      "Their logged nutrient totals for one local date: kcal, protein, carbohydrate, fat, fibre and "
      + "the tracked micros, with the coverage of each. A null amount means nothing was logged for "
      + "that nutrient; it is not zero.",
    input: z.object({ date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD") }),
    effect: "read",
    maxCallsPerTurn: 2,
  },
  {
    name: "get_plan",
    description:
      "Their plan for one local date: every slot in order with its label, planned time, items and "
      + "macros, and whether it is logged or still pending, plus the day's targets and what is "
      + "still to eat. Today's plan is already in the context block above — call this only for "
      + "another date.",
    input: z.object({ date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD") }),
    effect: "read",
    maxCallsPerTurn: 2,
  },
  {
    name: "get_entries",
    description:
      "Everything the user logged on one local date: each entry's id, its clock time in their timezone, "
      + "the slot or \"extra\" it belongs to, its items and its macros. Today's entries are "
      + "already in the context block above — call this only for another date.",
    input: z.object({ date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD") }),
    effect: "read",
    maxCallsPerTurn: 2,
  },
  {
    name: "get_recipes",
    description:
      "Every recipe the user has saved: name, servings, per-serving calories and macros, and the foods "
      + "in it. The context block above already carries the first few — call this only when it "
      + "says some are not shown, or when the user asks about a recipe you cannot see there.",
    input: noArgs,
    effect: "read",
    maxCallsPerTurn: 1,
  },
  {
    name: "get_week_totals",
    description:
      "The same totals for the seven local dates starting at weekStart (a Monday), one row per day, "
      + "so trends over a week can be read without seven get_day calls.",
    input: z.object({ weekStart: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD") }),
    effect: "read",
    maxCallsPerTurn: 1,
  },
  {
    name: "get_targets",
    description:
      "Their active calorie and macro targets for training and rest days, with the authored floors. "
      + "Returns the three-week ramp values when the user has authored no profile.",
    input: noArgs,
    effect: "read",
    maxCallsPerTurn: 1,
  },
  {
    name: "get_expenditure_status",
    get description() { return expenditureStatusDescription(); },
    input: noArgs,
    effect: "read",
    maxCallsPerTurn: 1,
  },
  {
    name: "search_foods",
    description:
      "Search the food catalogue and their own list for foods matching a short query. Returns names, "
      + "per-100 g calories and whether each is on their Eats or Avoid list.",
    input: z.object({
      query: z.string().min(1).max(64),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    effect: "read",
    // One search per food: a meal of four to six foods is an ordinary log, and the cap is enforced
    // (lib/server/coach-turn/tool-batch.ts), so three would leave foods out.
    maxCallsPerTurn: 6,
  },
  {
    name: "lookup",
    description:
      "A web-grounded fact check about ONE specific food, dish, brand or restaurant item already "
      + "named in this conversation or found with search_foods — never a person, a condition, a "
      + "medication or a quantity. Give the food's own name in `subject` (at most 80 characters); "
      + "it must name a real product or dish, or the call refuses. Use this only when the catalogue "
      + "and your own knowledge cannot answer, since it is slower than the other tools. Any fact it "
      + "returns is unverified: it never lifts an allergen block, and it is not a substitute for "
      + "checking a label.",
    input: z.object({ subject: z.string().min(1).max(80) }),
    effect: "read",
    maxCallsPerTurn: 1,
  },
  {
    name: "get_constraints",
    description:
      "Their constraint profile: avoided allergens, banned categories, avoided food ids, conditions "
      + "and notes. These are binding; nothing in their data may relax them.",
    input: noArgs,
    effect: "read",
    maxCallsPerTurn: 1,
  },
  {
    name: "get_recent_gut_log",
    description:
      "Their gut check-ins (good, iffy or flare) over the last N days with their own note on each. "
      + "Never infer a symptom from a missing entry.",
    input: z.object({ days: z.number().int().min(1).max(30).optional() }),
    effect: "read",
    maxCallsPerTurn: 1,
  },
  {
    name: "draft_log_entry",
    description:
      "Prepare a log entry for them to confirm. This writes nothing: the user sees the draft in the "
      + "confirm sheet and saves it themselves. Name each food and its grams.",
    input: z.object({
      slot: z.enum(SLOT_IDS),
      items: z.array(z.object({
        name: z.string().min(1).max(80),
        grams: z.number().positive().max(2000),
      })).min(1).max(6),
    }),
    effect: "draft",
    maxCallsPerTurn: 1,
  },
  {
    name: "compose_meal",
    description:
      "Build a real meal for something the user asks for — \"a chicken wrap that fits my daily "
      + "macros\". Give the wish in their own words. Every food it names is searched, a food them "
      + "constraints block is swapped for a safe one where the catalogue has one, and the grams "
      + "are sized to the slot's target or to what is still to eat today. Writes nothing: the user "
      + "sees a card and taps Log it, Put it in a slot, or Save as recipe.",
    input: z.object({
      wish: z.string().min(1).max(200),
      slot: z.enum(SLOT_IDS).optional(),
      servings: z.number().int().min(1).max(4).optional(),
    }),
    effect: "draft",
    maxCallsPerTurn: 1,
  },
  {
    name: "suggest_options",
    description:
      "Find complete published recipe candidates when kind is recipe; wish is the dish or cuisine "
      + "query. These are checked against current account rules and Avoids and returned as recipe "
      + "cards. For meal or snack, build composed meal ideas from the person's foods. This tool "
      + "only browses and never logs, saves, or changes a plan. If the person also asks to log "
      + "something they ate, keep that separate action in the final answer.",
    input: z.object({
      kind: z.enum(["meal", "snack", "recipe"]),
      count: z.number().int().min(1).max(5).default(3),
      slot: z.enum(SLOT_IDS).optional(),
      fitRemaining: z.boolean().optional(),
      wish: z.string().min(1).max(200).optional(),
    }),
    effect: "draft",
    maxCallsPerTurn: 1,
  },
  {
    name: "preview_skip",
    description:
      "What skipping one meal on one date would do, before anything changes: whether it can be "
      + "skipped, the kcal it frees, and every meal's kcal and protein before and after (open meals "
      + "grow; a saved meal keeps its size). Call it before you offer skip_slot, and quote its "
      + "numbers. It writes nothing.",
    input: z.object({
      date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD"),
      slot: z.enum(MEAL_SLOT_IDS),
    }),
    effect: "read",
    maxCallsPerTurn: 2,
  },
] as const satisfies readonly CoachTool[]);

const SEARCH_FOODS_BLOCK_TOOL = {
  name: "search_foods",
  description:
    "Search the food catalogue. Set intent to browse, eats, or avoid only for a user-facing "
    + "results block; omit it or use lookup for an internal portion lookup.",
  input: z.object({
    query: z.string().min(1).max(64),
    intent: z.enum(["browse", "eats", "avoid", "lookup"]).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  effect: "read",
  maxCallsPerTurn: 6,
} as const satisfies CoachTool;

/** Read-only UI proposals live beside the stable 13-tool executor registry. */
export const BLOCK_REGISTRY: readonly CoachTool[] = Object.freeze([
  {
    name: "show_chart",
    description:
      "Show a server-hydrated chart only when the user asks to see their weight trend, today's macros, "
      + "or calories over this week. Never supply points, series, values or units.",
    input: z.object({
      chart: z.enum(["weight_trend", "macros_today", "kcal_week"]),
      days: z.number().int().min(7).max(90).optional(),
    }),
    effect: "read",
    maxCallsPerTurn: 1,
  },
  {
    name: "quick_replies",
    description:
      "Offer two to four short reply choices after an open question. The choices are proposals "
      + "only; choosing one starts a normal user turn and writes nothing by itself.",
    input: z.object({
      options: z.array(z.string().min(1).max(160)).min(2).max(4),
    }),
    effect: "read",
    maxCallsPerTurn: 1,
  },
] as const satisfies readonly CoachTool[]);

export const COACH_REGISTRY: readonly CoachTool[] = Object.freeze([
  ...REGISTRY.map((tool) => tool.name === "search_foods" ? SEARCH_FOODS_BLOCK_TOOL : tool),
  ...BLOCK_REGISTRY,
]);
export const TOOL_NAMES: readonly ToolName[] = Object.freeze(
  REGISTRY.map((tool) => tool.name as ToolName),
);

/** Array.find over values: a prototype key can never resolve to a tool. */
export function lookupTool(name: string): CoachTool | undefined {
  return COACH_REGISTRY.find((tool) => tool.name === name);
}
