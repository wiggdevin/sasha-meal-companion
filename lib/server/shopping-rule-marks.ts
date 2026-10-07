import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SuggestionFoodEvidence } from "@/lib/coach/suggest-policy";
import { loadSuggestionEvidence } from "@/lib/coach/suggest-policy";
import { baseFoodName } from "@/lib/foods/base-name";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";
import { avoidFoodDbIds } from "@/lib/recipe-catalog/avoid-food-db";
import { readAvoidList } from "@/lib/server/avoid-list";
import { readPolicyProfile } from "@/lib/server/policy-profile";
import {
  evidenceKey, UNAVAILABLE_CONTEXT, withShoppingRuleMarks, type MarkableItem, type ShoppingAvoid,
  type ShoppingEvidence, type ShoppingRuleContext,
} from "@/lib/shopping/rule-marks";
import type { RuleMark } from "@/lib/types";

type RefItem = { foodRefId: string; catalogFoodRevisionId: number | null };

/**
 * One rules-and-evidence load for every line in one response (2026-10-05 calc audit F4): the
 * account's policy profile, its complete Avoid list by ref, name and bundled id, and the
 * eligible-foods path's evidence for every (food ref, pinned revision) the lines carry. Each input
 * is read and fails on its own, and lib/shopping/rule-marks.ts never reads a failed input as "no
 * rules". Never throws.
 *
 * The evidence read is made even for a list with no food refs: it is also where the account's
 * preference flags come from, which a typed line's text is matched against.
 */
export async function loadShoppingRuleContext(client: SupabaseClient, userId: string,
  items: readonly MarkableItem[], asOf: Date = new Date()): Promise<ShoppingRuleContext> {
  try {
    const [policy, avoid] = await Promise.allSettled([
      readPolicyProfile(client, userId, asOf),
      readAvoid(client, userId),
    ]);
    if (policy.status === "rejected") logFailure("rules", policy.reason);
    if (avoid.status === "rejected") logFailure("avoid", avoid.reason);
    const profile = policy.status === "fulfilled" ? policy.value.profile : null;
    return {
      profile,
      avoid: avoid.status === "fulfilled" ? avoid.value : null,
      evidence: await readEvidence(userId, refItemsOf(items), profile),
    };
  } catch (error) {
    logFailure("context", error);
    return UNAVAILABLE_CONTEXT;
  }
}

/** The response boundary: every line or pantry item leaves with a `ruleMark`. Never throws. */
export async function markShoppingItems<T extends MarkableItem>(client: SupabaseClient,
  userId: string, items: readonly T[] | null | undefined):
  Promise<(T & { ruleMark: RuleMark | null })[]> {
  if (!Array.isArray(items) || items.length === 0) return [];
  let context: ShoppingRuleContext;
  try {
    context = await loadShoppingRuleContext(client, userId, items);
  } catch (error) {
    logFailure("context", error);
    context = UNAVAILABLE_CONTEXT;
  }
  return withShoppingRuleMarks(items, context); // never throws: it catches per line
}

/** One entry per (ref, pinned revision); a malformed line is skipped (it marks itself). */
function refItemsOf(items: readonly MarkableItem[]): RefItem[] {
  const out = new Map<string, RefItem>();
  for (const item of items) {
    try {
      const foodRefId = item.identity?.foodRefId;
      if (!foodRefId) continue;
      const catalogFoodRevisionId = item.identity?.catalogFoodRevisionId ?? null;
      out.set(evidenceKey(foodRefId, catalogFoodRevisionId), { foodRefId, catalogFoodRevisionId });
    } catch { /* judged unknown by withShoppingRuleMarks */ }
  }
  return [...out.values()];
}

/**
 * The evidence port keys its answer by food ref alone, so two pins of one ref go in separate
 * rounds (round n holds each ref's n-th distinct revision); every answer is re-keyed by
 * (ref, revision). Any failed round makes the evidence unavailable as a whole.
 */
async function readEvidence(userId: string, refItems: readonly RefItem[],
  profile: ConstraintProfile | null): Promise<ShoppingEvidence> {
  const rounds: RefItem[][] = [];
  const seen = new Map<string, number>();
  for (const item of refItems) {
    const round = seen.get(item.foodRefId) ?? 0;
    seen.set(item.foodRefId, round + 1);
    (rounds[round] ??= []).push(item);
  }
  if (rounds.length === 0) rounds.push([]);
  try {
    const options = { needsNoCook: false, facets: profileRuleFacets(profile?.profileRules) };
    const answers = await Promise.all(rounds.map((round) =>
      loadSuggestionEvidence(userId, round, options)));
    const facts = new Map<string, SuggestionFoodEvidence>();
    for (const [index, answer] of answers.entries()) {
      if (answer.status !== "ready") return { status: "unavailable" };
      for (const item of rounds[index]) {
        const found = answer.byIdentity[`ref:${item.foodRefId}`];
        if (found) facts.set(evidenceKey(item.foodRefId, item.catalogFoodRevisionId), found);
      }
    }
    return { status: "ready", preferenceFlags: answers[0].preferenceFlags, facts };
  } catch (error) {
    logFailure("evidence", error);
    return { status: "unavailable" };
  }
}

/**
 * The account's complete Avoid list, through the same paged read the recipe policy uses
 * (lib/server/avoid-list.ts). Any failed page throws.
 */
async function readAvoid(client: SupabaseClient, userId: string): Promise<ShoppingAvoid> {
  const { refIds, names } = await readAvoidList(client, userId);
  return { refIds: new Set(refIds), names: new Set(names.map(baseFoodName).filter(Boolean)),
    foodDbIds: new Set(avoidFoodDbIds(names)) };
}

function logFailure(stage: "rules" | "avoid" | "evidence" | "context", error: unknown): void {
  // No user data: the stage and the error's own message only.
  console.warn(`[shopping-rule-marks] ${stage} read failed; marking from what is known`, {
    error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
  });
}
