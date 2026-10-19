import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeProfile } from "@/lib/server/targets";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import {
  RecipeRulesUnchecked, candidateRuleMark, loadMarkedRecipeDetail, loadRecipeCandidates, loadRecipeDetail,
} from "@/lib/server/recipe-candidates";
import { adaptRecipeServing, suggestedServingFraction } from "@/lib/recipes/adapt";
import { planShoppingPeriod, periodWindows, type KeptSlot, type PlanSlot } from "@/lib/shopping/planner";
import { getPeriod, listPantry } from "@/lib/shopping/repository";
import { preserveEditedLines } from "@/lib/shopping/preserve";
import type { IngredientIdentity, ShoppingPeriod } from "@/lib/shopping/types";
import type { RecipeCandidate, RecipeIngredient } from "@/lib/recipe-catalog/types";
import type { Macros } from "@/lib/types";
import type { SlotOverride } from "@/lib/types";
import { authoritativeSlotTarget } from "@/lib/recipes/slot-target";
import { loggedEntries } from "@/lib/server/day-context";
import { scheduleFieldsFromRow } from "@/lib/plan-schedule";
import {
  confirmFallbacks, describeFallbacks, parseCoverage, placeCoverage, scheduleMealCount, slotClocksFor,
  type CoverageFallback, type CoverageLabel, type PlanSchedule,
} from "@/lib/shopping/coverage";
import type { AcceptedRecipeSelection, RecipePreviewResult, ShoppingPreviewResult } from "@/lib/shopping/preview-contract";
import type { z } from "zod";
import type { recipePreviewBody, shoppingPreviewBody } from "@/lib/shopping/preview-contract";

const noStore = { "Cache-Control": "no-store" };
const day = (value: string) => new Date(`${value}T00:00:00Z`);
const addDay = (value: string, count: number) =>
  new Date(day(value).getTime() + count * 86_400_000).toISOString().slice(0, 10);
const macros = ["kcal", "protein", "carbs", "fat"] as const;
function dbError(error: { code?: string; message: string } | null): void {
  if (!error) return;
  if (["40001", "40P01", "55P03", "23505"].includes(error.code ?? "")) {
    throw new HttpError(409, "stale_preview", "This plan changed. Preview again.");
  }
  if (error.code === "P0002") throw new HttpError(404, "not_found", "Preview not found.");
  if (["22023", "22P02"].includes(error.code ?? "")) {
    throw new HttpError(422, "infeasible_plan", "This plan cannot be accepted.");
  }
  throw new HttpError(503, "recipe_plan_unavailable", "Recipe planning is unavailable.", { cause: error });
}
/**
 * The preview's freshness: this account's recipe_plan_state rev plus the global catalog rev
 * (W072, migration 20270105110100). Both only grow, so the sum moves when either does;
 * recipe_store_preview and recipe_accept_preview compare the same sum under their locks.
 */
async function stateRevision(client: SupabaseClient, userId: string): Promise<number> {
  const [row, catalog] = await Promise.all([
    client.from("recipe_plan_state").select("rev").eq("user_id", userId).maybeSingle(),
    client.from("recipe_catalog_clock").select("rev").eq("id", 1).maybeSingle(),
  ]);
  dbError(row.error);
  dbError(catalog.error);
  return Number(row.data?.rev ?? 0) + Number(catalog.data?.rev ?? 0);
}
async function target(client: SupabaseClient, userId: string, date: string) {
  const row = await activeProfile(client, userId, date);
  if (!row?.training_macros || !row.rest_macros) {
    throw new HttpError(409, "needs_profile", "Finish your profile before planning recipes.");
  }
  return row;
}
/** The slot's selection clock, and the accepted selection a new choice would replace. */
async function planSelection(client: SupabaseClient, userId: string, date: string, slotId: string) {
  const row = await client.from("recipe_plan_selections").select("id,plan_revision,superseded_at")
    .eq("user_id", userId).eq("local_date", date).eq("slot_id", slotId).maybeSingle();
  dbError(row.error);
  return { revision: Number(row.data?.plan_revision ?? 0),
    activeSelectionId: row.data && !row.data.superseded_at ? String(row.data.id) : null };
}
/**
 * The account's meal schedule on the server, as Today resolves it (lib/plan.ts): the chosen meal
 * count, else the count the target revision's training calories imply; the saved slot times; the
 * whole-day shift. The period planner places coverage by these clocks (lib/shopping/coverage.ts).
 */
async function readSchedule(client: SupabaseClient, userId: string,
  trainingKcal: number | null | undefined): Promise<PlanSchedule> {
  const row = await client.from("user_settings").select("meals_per_day,slot_times,shift_minutes")
    .eq("user_id", userId).maybeSingle();
  dbError(row.error);
  const value = Number(row.data?.meals_per_day);
  const mealsPerDay = Number.isInteger(value) && value >= 2 && value <= 6 ? value : null;
  const { slotTimes, shiftMinutes } = scheduleFieldsFromRow(row.data);
  return { mealCount: scheduleMealCount(mealsPerDay, trainingKcal), slotTimes, shiftMinutes };
}
async function countMeals(client: SupabaseClient, userId: string,
  trainingKcal: number | null | undefined): Promise<number> {
  return (await readSchedule(client, userId, trainingKcal)).mealCount;
}
function choice(recipe: RecipeCandidate, localDate: string, slotId: string,
  expectedPlanRevision: number, fraction = 1,
  slotBaseline?: { dayRevision: number; swap: unknown; override: unknown; eaten: unknown },
  expectedSelectionId: string | null = null) {
  let adaptation: ReturnType<typeof adaptRecipeServing>;
  try { adaptation = adaptRecipeServing(recipe, fraction, { retainedFractionBySeq: {} }); }
  catch (error) {
    if (error instanceof RangeError) throw new HttpError(400, "portion_out_of_range", error.message);
    throw error;
  }
  return { localDate, slotId, recipeId: recipe.recipeId,
    recipeRevisionId: recipe.revisionId, recipeName: recipe.name,
    servingFraction: fraction, ingredientSnapshot: adaptation.lines,
    nutritionSnapshot: adaptation.nutrition, exactFitAvailable: adaptation.exactFitAvailable,
    approximateFitAvailable: adaptation.approximateFitAvailable,
    evidenceIssues: adaptation.issues, expectedPlanRevision, expectedSelectionId,
    slotBaseline: slotBaseline ?? { dayRevision: 0, swap: null, override: null, eaten: null } };
}
function baseline(row: { rev?: number; swaps?: Record<string, unknown> | null;
  item_overrides?: Record<string, unknown> | null;
  eaten_slots?: Record<string, unknown> | null } | null, slotId: string) {
  return { dayRevision: row?.rev ?? 0, swap: row?.swaps?.[slotId] ?? null,
    override: row?.item_overrides?.[slotId] ?? null,
    eaten: row?.eaten_slots?.[slotId] ?? null };
}
async function storePreview(userId: string, kind: "recipe" | "shopping",
  proof: Record<string, unknown>, stateRev: number, expiresAt: string): Promise<string> {
  // The verified request user's ID is the only private input passed to this
  // narrowly privileged issuer. All account reads above use the auth client.
  const result = await adminClient().rpc("recipe_store_preview", {
    p_user_id: userId, p_kind: kind, p_proof: proof, p_state_rev: stateRev,
    p_expires_at: expiresAt });
  dbError(result.error);
  if (typeof result.data !== "string") throw new HttpError(503, "preview_unavailable");
  return result.data;
}
async function proofExpiry(client: SupabaseClient, userId: string): Promise<string> {
  const now = Date.now();
  let end = now + 30 * 60_000;
  const rows = await client.from("user_dietary_profiles").select("rules")
    .eq("user_id", userId);
  dbError(rows.error);
  // Stored rule expiry and dated-window edges can change eligibility without
  // a write. End the proof at the first future edge, including soft rules that
  // might influence candidate selection.
  for (const profile of rows.data ?? []) {
    for (const raw of Array.isArray(profile.rules) ? profile.rules : []) {
      const rule = raw as { expiresAt?: unknown;
        activeWindows?: { start?: unknown; end?: unknown }[] };
      const dates = [rule.expiresAt, ...(Array.isArray(rule.activeWindows)
        ? rule.activeWindows.flatMap((window) => [window.start, window.end]) : [])];
      for (const value of dates) {
        if (typeof value !== "string") continue;
        const time = Date.parse(value);
        if (!Number.isFinite(time)) {
          throw new HttpError(409, "rule_review_required", "A dated food rule needs review.");
        }
        if (time > now && time < end) end = time;
      }
    }
  }
  return new Date(end).toISOString();
}
async function unsupportedPolicyForAccept(client: SupabaseClient, userId: string): Promise<string | null> {
  const [constraint, settings, profiles] = await Promise.all([
    client.from("constraint_profiles").select("avoid_allergens,banned_categories,conditions")
      .eq("user_id", userId).maybeSingle(),
    client.from("user_settings").select("diet_prefs").eq("user_id", userId).maybeSingle(),
    client.from("user_dietary_profiles").select("rules").eq("user_id", userId),
  ]);
  for (const result of [constraint, settings, profiles]) dbError(result.error);
  const rules = constraint.data;
  const hasConstraint = [rules?.avoid_allergens, rules?.banned_categories, rules?.conditions]
    .some((value) => Array.isArray(value) && value.length > 0);
  const flags = (settings.data?.diet_prefs as { flags?: unknown } | null)?.flags;
  const hasHardProfile = (profiles.data ?? []).some((profile) =>
    (Array.isArray(profile.rules) ? profile.rules : []).some((raw) => {
      const rule = raw as { strength?: string; confirmation?: string; hardBasis?: string | null };
      return rule.strength === "never" && rule.confirmation === "confirmed"
        && Boolean(rule.hardBasis);
    }));
  return hasConstraint || (Array.isArray(flags) && flags.length > 0) || hasHardProfile
    ? "This account's food rules need revision-specific evidence before a recipe can be saved."
    : null;
}

const RULES_UNCHECKED = "This recipe could not be checked against your current food rules.";

/**
 * A food-rule read inside the recipe preview: any failure is the preview's one explicit exception,
 * 422 `recipe_rules_unchecked` with an unknown mark, never another status, and no proof is stored.
 */
async function previewRuleRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RecipeRulesUnchecked) throw error;
    throw new RecipeRulesUnchecked({ verdict: "unknown", reason: RULES_UNCHECKED });
  }
}

export async function previewRecipe(client: SupabaseClient, userId: string, recipeId: string,
  input: z.infer<typeof recipePreviewBody>): Promise<RecipePreviewResult> {
  const startRev = await stateRevision(client, userId);
  const profileRead = target(client, userId, input.date);
  const [detail, profile, count, revision, dayRow, logged] = await Promise.all([
    loadMarkedRecipeDetail(client, userId, recipeId, day(input.date)),
    profileRead,
    profileRead.then((row) => countMeals(client, userId, row.training_macros?.kcal)),
    planSelection(client, userId, input.date, input.slotId),
    client.from("plan_days").select("rev,eaten_slots,day_type_override,item_overrides,swaps")
      .eq("user_id", userId)
      .eq("local_date", input.date).maybeSingle(),
    // Food already logged that day takes its calories out of the slot the recipe is aimed at.
    loggedEntries(client, userId, input.date),
  ]);
  dbError(dayRow.error);
  if (Number(input.slotId.slice(5)) > count) {
    throw new HttpError(400, "slot_unavailable", "Choose a meal slot in your current schedule.");
  }
  if (!detail) throw new HttpError(404, "not_found", "Recipe not found.");
  // Rules that could not be read make no proof: an explicit 422 carrying the unknown mark.
  if (detail.rulesFingerprint === null) {
    throw new RecipeRulesUnchecked(detail.recipe.ruleMark
      ?? { verdict: "unknown", reason: RULES_UNCHECKED });
  }
  const rulesFingerprint = detail.rulesFingerprint;
  if (detail.recipe.eligibility.status !== "eligible") {
    throw new HttpError(422, "recipe_ineligible", detail.recipe.eligibility.reasons[0]?.message);
  }
  const unsupportedPolicy = await previewRuleRead(() => unsupportedPolicyForAccept(client, userId));
  if (unsupportedPolicy) throw new HttpError(422, "recipe_policy_requires_review", unsupportedPolicy);
  if (dayRow.data?.eaten_slots?.[input.slotId]?.eaten_at) {
    throw new HttpError(409, "already_eaten", "This meal has already been eaten.");
  }
  const aimed = authoritativeSlotTarget(profile, input.date, count, input.slotId, dayRow.data,
    logged.map(({ entry }) => entry));
  if (!aimed) throw new HttpError(409, "slot_unavailable", "This meal slot cannot be planned.");
  // Choosing a recipe for this one slot is the explicit replacement of its accepted selection.
  const selected = choice(detail.recipe, input.date, input.slotId, revision.revision,
    input.servingFraction ?? suggestedServingFraction(detail.recipe, aimed.kcal),
    baseline(dayRow.data, input.slotId), revision.activeSelectionId);
  const gap = Object.fromEntries(macros.map((key) => [key,
    selected.nutritionSnapshot[key]?.value == null ? null
      : Math.round((selected.nutritionSnapshot[key].value! - aimed[key]) * 10) / 10])) as Record<keyof Macros, number | null>;
  const authority = { targetRevisionId: profile.id, targetRevision: profile.rev,
    rulesFingerprint, planRevision: revision.revision, stateRevision: startRev };
  const proof = { authorityDate: input.date, authority, choices: [selected],
    blockingIssues: [] as string[] };
  // The proof's expiry reads the stored rules' dated edges: a failed read stores no proof.
  const expiresAt = await previewRuleRead(() => proofExpiry(client, userId));
  const previewId = await storePreview(userId, "recipe", proof, startRev, expiresAt);
  return { previewId, recipe: detail.recipe, servingFraction: selected.servingFraction,
    ingredientSnapshot: selected.ingredientSnapshot, nutritionSnapshot: selected.nutritionSnapshot,
    gap, mealTarget: aimed, exactFitAvailable: selected.exactFitAvailable,
    approximateFitAvailable: selected.approximateFitAvailable,
    evidenceIssues: selected.evidenceIssues, authority,
    ruleMark: candidateRuleMark(detail.recipe, selected.ingredientSnapshot),
    ruleFlags: detail.preferenceFlags ?? [] };
}
/**
 * An accepted recipe outside the loaded candidates, only at the revision the user accepted. A
 * withdrawn recipe blocks its own slot, never the whole preview (audit A047).
 */
async function keptRecipe(client: SupabaseClient, userId: string,
  row: { recipe_id: string; recipe_revision_id: string; local_date: string },
): Promise<RecipeCandidate | "withdrawn" | null> {
  try {
    const detail = await loadRecipeDetail(client, userId, row.recipe_id, day(row.local_date));
    return detail?.recipe.revisionId === row.recipe_revision_id ? detail.recipe : null;
  } catch (error) {
    if (error instanceof HttpError && error.status === 410) return "withdrawn";
    throw error;
  }
}
function identityFor(item: RecipeIngredient): IngredientIdentity | null {
  if (!item.foodRefId && !item.foodDbId) return null;
  return { foodRefId: item.foodRefId, foodDbId: item.foodDbId ?? null,
    catalogFoodRevisionId: item.catalogFoodRevisionId,
    purchaseState: item.state, variantKey: item.state };
}
function periodFromDraft(userId: string, id: string,
  draft: z.infer<typeof shoppingPreviewBody>["draft"]): ShoppingPeriod {
  return { ...draft, id, userId, planRevision: 0, revision: 0 };
}
function fingerprint(value: unknown): string {
  // Stable enough for display; SQL's state clock is the concurrency authority.
  return JSON.stringify(value);
}
/** "Lunch (Meal 1)" — the meal by its clock's name; "Meal 3" alone for an overnight slot. */
function mealLabel(slotId: string, occasion: string | undefined): string {
  const meal = `Meal ${slotId.slice(5)}`;
  return occasion && occasion !== "other" ? `${occasion[0].toUpperCase()}${occasion.slice(1)} (${meal})` : meal;
}
/** "No breakfast recipe fits Meal 1 on 2026-10-01: …" — the meal by name, never a bare slot id. */
function unfilledLine(slot: { localDate: string; slotId: string; reasons: string[] },
  occasion: string | undefined): string {
  const meal = occasion && occasion !== "other" ? `${occasion} ` : "";
  return `No ${meal}recipe fits Meal ${slot.slotId.slice(5)} on ${slot.localDate}: ${slot.reasons.join(" ")}`;
}
export async function previewShopping(client: SupabaseClient, userId: string,
  input: z.infer<typeof shoppingPreviewBody>): Promise<ShoppingPreviewResult> {
  const windows = periodWindows(periodFromDraft(userId, input.periodId ?? randomUUID(), input.draft));
  if (windows.length > 5) throw new HttpError(400, "bad_period", "Plan at most 31 days.");
  const startRev = await stateRevision(client, userId);
  const existing = input.periodId ? await getPeriod(client, userId, input.periodId) : null;
  if (existing && existing.period.revision !== input.expectedRevision) {
    throw new HttpError(409, "stale_revision", "This period changed. Preview again.");
  }
  const period = existing ? { ...existing.period, ...input.draft } :
    periodFromDraft(userId, randomUUID(), input.draft);
  const parsed = input.draft.mealCoverage.map(parseCoverage);
  if (parsed.some((label) => label === null) || parsed.length === 0) {
    throw new HttpError(400, "bad_coverage", "Choose breakfast, lunch, dinner, snack or meal 1–6.");
  }
  const coverage = parsed as CoverageLabel[];
  const profile = await target(client, userId, period.startDate);
  const transitions = await client.from("target_profiles").select("id,effective_from")
    .eq("user_id", userId).gt("effective_from", period.startDate)
    .lte("effective_from", period.endDate).order("effective_from").limit(1);
  dbError(transitions.error);
  if (transitions.data?.length) {
    const change = String(transitions.data[0].effective_from);
    const shorterEnd = addDay(change, -1);
    throw new HttpError(409, "target_changes_in_period",
      `A target revision starts on ${change}. Plan ${period.startDate} through ${shorterEnd}, then start a new period on ${change}.`);
  }
  const schedule = await readSchedule(client, userId, profile.training_macros?.kcal);
  const mealCount = schedule.mealCount;
  if (coverage.some((label) => label.kind === "slot" && Number(label.slotId.slice(5)) > mealCount)) {
    throw new HttpError(400, "slot_unavailable", "Choose meals in your current schedule.");
  }
  const [catalog, pantry, planned, acceptedRows] = await Promise.all([
    loadRecipeCandidates(client, userId, { query: "", limit: 64 }, day(period.startDate)),
    listPantry(client, userId),
    client.from("plan_days").select("local_date,rev,eaten_slots,day_type_override,item_overrides,swaps")
      .eq("user_id", userId).gte("local_date", period.startDate).lte("local_date", period.endDate),
    client.from("recipe_plan_selections")
      .select("id,local_date,slot_id,recipe_id,recipe_revision_id,recipe_name,serving_fraction,plan_revision")
      .eq("user_id", userId).gte("local_date", period.startDate).lte("local_date", period.endDate)
      .is("superseded_at", null),
  ]);
  dbError(planned.error);
  dbError(acceptedRows.error);
  const days = new Map((planned.data ?? []).map((row) => [row.local_date, row]));
  const accepted = new Map((acceptedRows.data ?? []).map((row) =>
    [`${row.local_date}:${row.slot_id}`, row]));
  // Logged food counts against each day's slots too; only days that have logs are read in full.
  const logDates = await client.from("log_entries").select("local_date").eq("user_id", userId)
    .gte("local_date", period.startDate).lte("local_date", period.endDate).is("deleted_at", null);
  dbError(logDates.error);
  const loggedByDate = new Map(await Promise.all([...new Set((logDates.data ?? [])
    .map((row) => row.local_date as string))].map(async (date) =>
    [date, (await loggedEntries(client, userId, date)).map(({ entry }) => entry)] as const)));
  const eaten = new Set((planned.data ?? []).flatMap((row) =>
    Object.entries(row.eaten_slots ?? {}).filter(([, value]) =>
      Boolean((value as { eaten_at?: string })?.eaten_at)).map(([slot]) => `${row.local_date}:${slot}`)));
  const slots: PlanSlot[] = [];
  const blockedEdits: string[] = [];
  const keptRows: NonNullable<typeof acceptedRows.data> = [];
  const fallbacks: CoverageFallback[] = [];
  for (let date = period.startDate; date <= period.endDate; date = addDay(date, 1)) {
    const row = days.get(date);
    // Each meal word lands in the slot whose clock on THIS date is that meal (Phase 17 O4).
    const placed = placeCoverage(coverage, date,
      slotClocksFor(schedule, row?.item_overrides as Record<string, unknown> | null | undefined));
    fallbacks.push(...placed.fallbacks);
    for (const { slotId, occasion } of placed.slots) {
      const override = row?.item_overrides?.[slotId] as SlotOverride | undefined;
      if (row?.swaps?.[slotId] || (override && !override.followPlan)) {
        blockedEdits.push(`${mealLabel(slotId, occasion)} on ${date} has a saved edit or swap.`);
        continue;
      }
      // An accepted recipe is the user's choice: keep it, never re-choose it (finding S1).
      const chosen = accepted.get(`${date}:${slotId}`);
      if (chosen && !eaten.has(`${date}:${slotId}`)) {
        keptRows.push(chosen);
        continue;
      }
      const aimed = authoritativeSlotTarget(profile, date, mealCount, slotId, row ?? null,
        loggedByDate.get(date) ?? []);
      slots.push({ localDate: date, slotId, targetKcal: aimed?.kcal ?? null,
        targetProtein: aimed?.protein ?? null, occasion });
    }
  }
  if (slots.length + keptRows.length + blockedEdits.length > 186) {
    throw new HttpError(400, "too_many_slots");
  }
  const kept: KeptSlot[] = [];
  const keptBlocked: string[] = [];
  const keptKept: string[] = [];
  for (const row of keptRows) {
    const label = `${row.recipe_name} on ${row.local_date} Meal ${String(row.slot_id).slice(5)}`;
    const recipe = catalog.candidates.find((item) => item.revisionId === row.recipe_revision_id)
      ?? await keptRecipe(client, userId, row);
    if (recipe === "withdrawn") {
      keptBlocked.push(`Your chosen ${label} is no longer in the recipe catalog. Choose that meal again before planning this period.`);
    } else if (!recipe) {
      keptBlocked.push(`Your chosen ${label} changed in the recipe catalog. Choose that meal again before planning this period.`);
    } else if (recipe.eligibility.status !== "eligible") {
      keptBlocked.push(`Your chosen ${label} no longer fits your food rules. Choose another recipe for that meal first.`);
    } else {
      kept.push({ localDate: row.local_date, slotId: row.slot_id, recipe,
        servingFraction: Number(row.serving_fraction), selectionId: String(row.id) });
      keptKept.push(`Keeps your chosen ${label}.`);
    }
  }
  const keptById = new Map(keptRows.map((row) => [String(row.id), row]));
  const blockedEaten = slots.filter((slot) => eaten.has(`${slot.localDate}:${slot.slotId}`));
  const pins = (existing?.lines ?? []).filter((line) => line.pinned && line.identity)
    .map((line) => line.identity!);
  const preview = planShoppingPeriod({ period, slots: slots.filter((slot) =>
    !eaten.has(`${slot.localDate}:${slot.slotId}`)), kept, candidates: catalog.candidates,
    ...(input.excludeRecipeIds?.length ? { excludeRecipeIds: input.excludeRecipeIds } : {}),
    basket: input.basket, pins, aggregate: { pantry, existingLines: existing?.lines,
      identityFor }, existingPurchaseWindows: existing?.purchaseWindows });
  const { lines: proposedLines, retained } = preserveEditedLines(existing?.lines ?? [],
    preview.shopping.lines);
  const blockingIssues = [
    ...blockedEdits,
    ...keptBlocked,
    ...blockedEaten.map((slot) => `${mealLabel(slot.slotId, slot.occasion)} on ${slot.localDate} was already eaten.`),
    ...preview.unfilledSlots.map((slot) => unfilledLine(slot,
      slots.find((row) => row.localDate === slot.localDate && row.slotId === slot.slotId)?.occasion)),
    ...(period.lockMode !== "none" && preview.proposedAdditions.length
      ? ["The locked basket would need additional ingredients."] : []),
  ];
  const unsupportedPolicy = await unsupportedPolicyForAccept(client, userId);
  if (unsupportedPolicy) blockingIssues.push(unsupportedPolicy);
  const informationalIssues = [...keptKept, ...describeFallbacks(confirmFallbacks(fallbacks,
    new Set(preview.choices.map((row) => `${row.localDate}:${row.slotId}`)))), ...preview.shopping.issues,
    ...preview.shopping.price.unknownReasons, ...preview.compromise,
    ...retained.map((line) => `${line.name} will remain on your list as a manual item because it has a bought mark, pin or note.`)];
  const choices = await Promise.all(preview.choices.map(async (row) => {
    const keptRow = row.keptSelectionId ? keptById.get(row.keptSelectionId) : undefined;
    // A kept slot carries the exact accepted row the SQL accept must still find unchanged.
    const selection = keptRow
      ? { revision: Number(keptRow.plan_revision), activeSelectionId: String(keptRow.id) }
      : await planSelection(client, userId, row.localDate, row.slotId);
    return {
    ...choice(row.recipe as RecipeCandidate, row.localDate, row.slotId,
      selection.revision, row.servingFraction,
      baseline(days.get(row.localDate) ?? null, row.slotId), selection.activeSelectionId),
    ...(keptRow ? { keptSelectionId: String(keptRow.id) } : {}),
    batchId: row.batchId, servingsConsumed: row.servingsConsumed,
    preparedOn: row.preparedOn, reuseLimitDays: row.reuseLimitDays,
    storageGuidance: row.storageGuidance,
    };
  }));
  for (const row of choices) {
    if (!row.approximateFitAvailable) {
      blockingIssues.push(`${row.recipeName} has incomplete nutrition for ${row.localDate}.`);
    }
  }
  const authority = { targetRevisionId: profile.id, targetRevision: profile.rev,
    rulesFingerprint: catalog.rulesFingerprint, stateRevision: startRev,
    periodRevision: existing?.period.revision ?? null,
    pantryFingerprint: fingerprint(pantry.map((row) => [row.id, row.revision])),
    listFingerprint: fingerprint((existing?.lines ?? []).map((row) => [row.id, row.revision])) };
  const proof = { authorityDate: period.startDate, authority,
    periodId: existing?.period.id ?? null, periodRevision: existing?.period.revision ?? null,
    period, basket: input.basket, choices, lines: proposedLines,
    replenishment: preview.replenishment, blockingIssues };
  const previewId = await storePreview(userId, "shopping", proof, startRev,
    await proofExpiry(client, userId));
  // The wire carries each choice's protein gap (audit S3); the stored proof does not need it.
  return { previewId, period, choices: choices.map((row, index) => ({ ...row,
    id: row.keptSelectionId ?? "",
    planRevision: row.expectedPlanRevision,
    proteinGapGrams: preview.choices[index]?.proteinGapGrams ?? null })), lines: proposedLines,
    informationalIssues, blockingIssues, authority, windows: preview.windows,
    replenishment: preview.replenishment, unmetPins: preview.unmetPins,
    unfilledSlots: preview.unfilledSlots, proposedAdditions: preview.proposedAdditions,
    compromise: preview.compromise, price: preview.shopping.price };
}
/**
 * Accepts a stored preview (POST /api/recipes/[id]/plan, POST /api/shopping/accept). A retry with
 * the same requestId answers the first accept's result while the preview row exists. The daily
 * retention purge (W044, `recipe_plan_previews_purge`) deletes a preview 7 days after it expired,
 * accepted or not, so a retried accept after that answers 404 `not_found` (from each route's own
 * preview lookup, else the read below if the purge lands in between); the accepted selection
 * and shopping period are not touched. A caller that gets it re-reads the plan to learn whether
 * the first accept landed.
 */
export async function acceptPreview(client: SupabaseClient, userId: string,
  previewId: string, requestId: string, acceptApproximate: boolean):
  Promise<{ period: ShoppingPeriod | null; lines: import("@/lib/shopping/types").ShoppingLine[];
    purchaseWindows: import("@/lib/shopping/types").ShoppingPurchaseWindow[];
    selections: AcceptedRecipeSelection[] }> {
  const stored = await client.from("recipe_plan_previews").select("kind,proof")
    .eq("id", previewId).eq("user_id", userId).maybeSingle();
  dbError(stored.error);
  if (!stored.data) throw new HttpError(404, "not_found", "Preview not found.");
  const result = await client.rpc("recipe_accept_preview", { p_preview_id: previewId,
    p_request_id: requestId, p_accept_approximate: acceptApproximate });
  dbError(result.error);
  const data = result.data as { periodId: string | null; selections: Record<string, unknown>[] };
  const period = data.periodId ? await getPeriod(client, userId, data.periodId) : null;
  const selections = data.selections.map((row) => ({
    id: String(row.id), localDate: String(row.local_date), slotId: String(row.slot_id),
    recipeId: String(row.recipe_id), recipeRevisionId: String(row.recipe_revision_id),
    recipeName: String(row.recipe_name), servingFraction: Number(row.serving_fraction),
    ingredientSnapshot: row.ingredient_snapshot as AcceptedRecipeSelection["ingredientSnapshot"],
    nutritionSnapshot: row.nutrition_snapshot as AcceptedRecipeSelection["nutritionSnapshot"],
    exactFitAvailable: Boolean(row.exact_fit_available),
    approximateFitAvailable: Boolean(row.approximate_fit_available),
    evidenceIssues: row.evidence_issues as AcceptedRecipeSelection["evidenceIssues"],
    planRevision: Number(row.plan_revision),
    baselineSwap: row.baseline_swap ?? null,
    baselineOverride: row.baseline_override ?? null,
    acceptedAt: String(row.accepted_at),
    batchId: row.batch_id as string | null, preparedOn: row.prepared_on as string | undefined,
    reuseLimitDays: row.reuse_limit_days as 3 | undefined,
    storageGuidance: row.storage_guidance as string | undefined,
  }));
  return { period: period?.period ?? null, lines: period?.lines ?? [],
    purchaseWindows: period?.purchaseWindows ?? [], selections };
}
export { noStore };
