/**
 * The coach's shared server pieces — the flag, the spend budget, the provider/model identity and
 * the catalog→coach food mapping. The turn loop lives in lib/server/coach-turn.ts and thread
 * storage in lib/server/coach-threads.ts (T6 §6); `runTurn` is re-exported here so every existing
 * importer keeps working.
 *
 * No "server-only" marker: tests load this module under vitest, and lib/server/ is the boundary.
 */

import { isFoodKey } from "@/lib/meals/food-key";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateStructured } from "@/lib/ai/adapter";
import { COACH_MODEL_ID, MODELS } from "@/lib/ai/models";
import { HttpError } from "@/lib/server/auth";
import { latestEstimate } from "@/lib/server/expenditure";
import { isPackagedCatalogSource } from "@/lib/catalog/category-map";
import type { FoodHit } from "@/lib/coach/executors";
import type { FoodDetail, FoodSearchHit } from "@/lib/server/catalog";
import { runWeeklyReview } from "@/lib/coach/weekly-review";
import { lastAiCallId, nextSeq } from "@/lib/server/coach-threads";

export const TURNS_PER_HOUR = 10;
export const TURNS_PER_DAY = 60;

export class CoachRateLimited extends HttpError {
  constructor(public readonly retryAfterSeconds: number) {
    super(429, "rate_limited", `Too many coach turns. Try again in ${retryAfterSeconds} s.`);
  }
}

export function coachPurpose(): "coach" {
  return "coach";
}

export function coachModelId(): string {
  return COACH_MODEL_ID;
}

/** Map the catalog detail read into the one coach search shape used by tools and grounding. */
/** `catalog:<id>` for a real catalog food id, else nothing (a test fixture without one). */
function catalogFoodKey(id: unknown): { foodKey?: string } {
  const key = `catalog:${String(id)}`;
  return Number.isSafeInteger(id) && (id as number) > 0 && isFoodKey(key) ? { foodKey: key } : {};
}

export function mapCatalogFoodHit(
  hit: FoodSearchHit, detail: FoodDetail, foodRefId: string | null,
): FoodHit {
  const amount = (code: string): number | null => detail.per100g[code]?.amount ?? null;
  const reason = hit.policy.verdict === "blocked" ? hit.policy.reason : undefined;
  const blockedAllergen = reason?.startsWith("allergen:")
    ? reason.slice("allergen:".length) : null;
  const ingredientTags = detail.ingredients.flatMap((ingredient) => ingredient.allergenTags);
  // r4 BLOCK #10 (follow-up): reuse getFoodDetail's own nameOnlyAllergenHints — it already had
  // the account's profile (including its own named allergens) in hand to compute it with; this
  // function does not, so it must not try to recompute it fixed-vocabulary-only. Defaults to []
  // for a caller-built FoodDetail (a test fixture, an older cache entry) with no such field.
  const nameHints = detail.nameOnlyAllergenHints ?? [];
  // T6 §3: the household portion the model must use when the user names a food and no quantity —
  // now the one `defaultPortion` lib/foods/portions.ts already picked (the same isDefault-else-
  // first rule this used to run locally over the legacy `portions` shape).
  const portion = detail.defaultPortion;
  return {
    foodRefId, name: hit.description, brand: hit.brand,
    catalogFoodRevisionId: detail.revisionId,
    ...catalogFoodKey(detail.catalogFoodId),
    // detail.kcalPer100g already applies this same energy_kcal/energy_kcal_calc fallback
    // (lib/server/catalog.ts getFoodDetail) — reused rather than recomputed from `amount()`.
    kcalPer100g: detail.kcalPer100g,
    proteinPer100g: amount("protein"),
    carbsPer100g: amount("carbohydrate"),
    fatPer100g: amount("fat_total"),
    prefStatus: hit.prefStatus,
    allergenTags: ingredientTags.length > 0 || nameHints.length > 0
      ? [...ingredientTags, ...nameHints] : blockedAllergen === null ? null : [blockedAllergen],
    allergenEvidence: detail.allergenEvidence,
    checkedAllergens: detail.checkedAllergens,
    // finding #10: the revision's own verbatim text (now on FoodDetail), not a lossy join of just
    // the parsed ingredient names — the same escalation risk lib/server/catalog.ts getFoodDetail's
    // own policy read had until this fix.
    ingredientsText: detail.ingredientsText,
    // finding #1 (round 10): the label's own verbatim/completeness flag, straight from
    // getFoodDetail's `completenessText` read — without it, evaluatePolicy defaults to treating
    // a split label's first fragment as the whole printed statement (lib/policy/allergens.ts
    // allergenFinding's `isLabelText !== false` default) and can certify it "complete" enough to
    // clear a major allergen a later, separately-raw_text'd row actually names.
    ingredientsTextIsLabel: detail.ingredientsTextIsLabel,
    category: detail.policyCategories,
    portionGrams: portion ? portion.grams : null,
    portionLabel: portion ? portion.label : null,
    // 2026-10-02 DeepSeek audit (F2, MED): packaged by definition for a branded USDA row or an
    // Open Food Facts hit — same reading search and detail's own policy check already use
    // (lib/server/catalog.ts). `hit.source` is `FoodSearchHit`'s, the search hit this detail came
    // from, since `FoodDetail.source` describes the same revision identically.
    packaged: isPackagedCatalogSource(hit.source),
  };
}

/**
 * The budget is counted from ai_calls, not from the request limiter (lib/server/ratelimit.ts, a
 * short fixed window): "60 a day" is a daily count of successful turns. Only successful coach calls count.
 */
export async function assertTurnBudget(
  admin: SupabaseClient, userId: string, now: number
): Promise<void> {
  const dayStart = new Date(now - 86_400_000).toISOString();
  const { data, error } = await admin.from("ai_calls")
    .select("created_at").eq("user_id", userId).eq("status", "ok")
    .eq("purpose", "coach").gte("created_at", dayStart)
    .order("created_at", { ascending: true });
  if (error) return;                        // a failed read never blocks them; the spend cap remains
  const times = ((data ?? []) as { created_at: string }[])
    .map((r) => Date.parse(r.created_at));
  const hour = times.filter((t) => t >= now - 3_600_000);
  if (hour.length >= TURNS_PER_HOUR) {
    throw new CoachRateLimited(Math.max(1, Math.ceil((hour[0] + 3_600_000 - now) / 1000)));
  }
  if (times.length >= TURNS_PER_DAY) {
    throw new CoachRateLimited(Math.max(1, Math.ceil((times[0] + 86_400_000 - now) / 1000)));
  }
}

/** Inserts tried when a reply in the review thread takes the seq a review read. */
const REVIEW_SEQ_ATTEMPTS = 3;

/**
 * The Sunday review, on the pinned Coach model (architecture §4.5, T4). One review per account and
 * local week: a week that already has one returns it with `duplicate: true` before any model call,
 * and coach_messages_one_weekly_review (user_id, review_week) refuses a racing second insert. A
 * delivered review marks its thread unread (`coach_threads.unread_at`) until the thread is opened.
 */
export async function writeWeeklyReview(
  admin: SupabaseClient, userId: string, weekStart: string,
  deps: { generate?: typeof generateStructured; latestEstimate?: (userId: string) => Promise<unknown> } = {}
): Promise<{ threadId: string; messageId: string; duplicate: boolean }> {
  const delivered = await deliveredReview(admin, userId, weekStart);
  if (delivered) return { ...delivered, duplicate: true };

  const existing = await admin.from("coach_threads").select("id")
    .eq("user_id", userId).eq("kind", "weekly_review").is("deleted_at", null).maybeSingle();
  let threadId = (existing.data as { id: string } | null)?.id ?? null;
  if (!threadId) {
    // coach_threads_one_weekly makes a second insert fail rather than create a duplicate.
    const created = await admin.from("coach_threads")
      .insert({ user_id: userId, kind: "weekly_review", title: "Weekly review" })
      .select("id").single();
    if (created.error || !created.data) {
      throw new HttpError(500, "internal", "Could not open the weekly-review thread.");
    }
    threadId = (created.data as { id: string }).id;
  }

  const review = await runWeeklyReview(admin, userId, weekStart,
    { ...deps, latestEstimate: deps.latestEstimate ?? ((uid) => latestEstimate(admin, uid)) });

  const aiCallId = review.modelUsed ? await lastAiCallId(admin, userId, "weeklyReview") : null;
  let messageId = "";
  let error: unknown = null;
  // The review thread takes replies (CONVERSATION_KINDS), so a reply can take the seq this insert
  // read. Its unique (thread_id, seq) refusal reads the next seq and tries again; the hourly job
  // fires once in the account's Sunday window, and a lost seq race would otherwise lose the week.
  for (let attempt = 0; attempt < REVIEW_SEQ_ATTEMPTS; attempt += 1) {
    const seq = await nextSeq(admin, threadId);
    messageId = randomUUID();
    ({ error } = await admin.from("coach_messages").insert({
      id: messageId, thread_id: threadId, user_id: userId, role: "assistant",
      content: review.text, review_week: weekStart,
      seq, tool_calls: [], policy_checks: [], deflected: false,
      // A fallback review called no model: no model id and no ledger row to point at.
      model_id: review.modelUsed ? MODELS.weeklyReview : "",
      ai_call_id: aiCallId,
    }));
    if (!error || (error as { code?: string }).code !== "23505") break;
    // A concurrent run delivered this week first; its message stands and this one is dropped.
    const winner = await deliveredReview(admin, userId, weekStart);
    if (winner) return { ...winner, duplicate: true };
  }
  if (error) throw new HttpError(500, "internal", "Could not save the weekly review.");
  const at = new Date().toISOString();
  await admin.from("coach_threads")
    .update({ last_message_at: at, unread_at: at })
    .eq("id", threadId).eq("user_id", userId);
  return { threadId, messageId, duplicate: false };
}

async function deliveredReview(
  admin: SupabaseClient, userId: string, weekStart: string,
): Promise<{ threadId: string; messageId: string } | null> {
  const { data, error } = await admin.from("coach_messages").select("id, thread_id")
    .eq("user_id", userId).eq("review_week", weekStart).limit(1).maybeSingle();
  if (error) throw new HttpError(500, "internal", "Could not read the weekly review.");
  const row = data as { id: string; thread_id: string } | null;
  return row ? { threadId: row.thread_id, messageId: row.id } : null;
}
