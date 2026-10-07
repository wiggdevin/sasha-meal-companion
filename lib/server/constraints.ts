/**
 * The constraint profile read and write path — spec "API changes", architecture §3.6, §3.7.
 *
 * constraint_profiles is NOT outbox-synced this wave (contracts §4, reconciled: lib/sync/** is
 * Lane Q's): PUT /api/constraints with a baseRev compare-and-swap is the only write path, and
 * offline the editor is disabled. Every query runs on the RLS-scoped, request-local client.
 *
 * rev 0 means "no row yet": the effective profile restricts nothing (D1 §6.1) and a PUT with
 * baseRev 0 inserts the first row at rev 1. Onboarding always sends that PUT, so a finished
 * account owns a row even when it chose no rule at all.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type { ConstraintsPut } from "@/lib/coach/types";
import { loadProfile, type ConstraintProfile } from "@/lib/policy/constraints";
import { applyRuleChoices, reviewStatus, type RuleChoices } from "@/lib/rule-review";
import { parseCustomRules, type CustomRule } from "@/lib/policy/custom-rules";

export type StoredProfile = ConstraintProfile & { conditions: string[]; notes: string | null;
  custom_rules?: CustomRule[] };

const SELECT = "rev, conditions, notes, avoid_allergens, avoid_food_ref_ids, banned_categories, custom_rules, rule_review_required, rule_reviewed_at";
/** Phase 18 W2b (migration 20261213090000_food_world_columns): read by getProfile only, and tolerated when missing. */
const READ_SELECT = `${SELECT}, condition_review_required`;
const UNDEFINED_COLUMN = "42703";

type ProfileRow = {
  rev: number; conditions: string[] | null; notes: string | null;
  avoid_allergens: string[] | null; avoid_food_ref_ids: string[] | null;
  banned_categories: string[] | null;
  custom_rules: CustomRule[] | null;
  rule_review_required: boolean | null; rule_reviewed_at: string | null;
  condition_review_required?: boolean | null;
};

function toProfile(row: ProfileRow | null): StoredProfile {
  const customRules = parseCustomRules(row === null ? [] : row.custom_rules);
  const base = loadProfile(row === null ? null : {
    avoid_allergens: row.avoid_allergens ?? undefined,
    avoid_food_ref_ids: row.avoid_food_ref_ids ?? undefined,
    banned_categories: row.banned_categories ?? undefined,
    custom_rules: customRules,
  });
  return { ...base, conditions: row?.conditions ?? [], notes: row?.notes ?? null,
    custom_rules: customRules };
}

/**
 * `rev: 0` is the no-row token: an account with no `constraint_profiles` row reads as an all-empty
 * profile at revision 0, which is the same thing `{profile:null}` would have said and is already
 * the baseRev a first PUT must send (D1 §6.1).
 */
export async function getProfile(
  client: SupabaseClient, userId: string, signal?: AbortSignal
): Promise<{ profile: StoredProfile; rev: number; reviewRequired: boolean; reviewedAt: string | null;
  conditionReview: boolean }> {
  const read = (columns: string) => {
    const query = client.from("constraint_profiles").select(columns).eq("user_id", userId);
    const bounded = signal && typeof query.abortSignal === "function" ? query.abortSignal(signal) : query;
    return bounded.maybeSingle();
  };
  let { data, error } = await read(READ_SELECT);
  if (error && (error as { code?: string }).code === UNDEFINED_COLUMN && !signal?.aborted) {
    // Deployed before migration 20261213090000: read without the marker, which cannot be pending
    // in a database that has no column for it.
    console.error("constraint_profiles.condition_review_required is missing; reading it as false");
    ({ data, error } = await read(SELECT));
  }
  if (error) {
    // postgrest-js resolves an aborted fetch as `{ data: null, error }`, never a rejected
    // promise (2026-10-03 audit, Grok MAJOR): once the caller's own signal has fired, this is a
    // budget cancel, not a real read failure, and the caller's own abort handling must see it as
    // one instead of a generic internal error.
    if (signal?.aborted) {
      const abort = new Error("constraint profile read aborted");
      abort.name = "AbortError";
      throw abort;
    }
    throw new HttpError(500, "internal", "Could not read the constraint profile.");
  }
  const row = (data ?? null) as ProfileRow | null;
  return { profile: toProfile(row), rev: row?.rev ?? 0,
    reviewRequired: row?.rule_review_required ?? false, reviewedAt: row?.rule_reviewed_at ?? null,
    conditionReview: row?.condition_review_required === true };
}

/**
 * Phase 18 W2b: a condition added to an open account (migration 20261213090000 sets
 * `condition_review_required` in that same write) pauses every generating surface through this
 * same gate until the user confirms it (`POST /api/foods/world`). The Keep/Remove review cannot
 * clear it. `conditionReview` appears only while it is pending, so every other answer is unchanged.
 */
export async function getRuleReviewStatus(client: SupabaseClient, userId: string, signal?: AbortSignal) {
  const { profile, rev, reviewRequired, reviewedAt, conditionReview } = await getProfile(client, userId, signal);
  const status = reviewStatus(reviewRequired, reviewedAt, profile);
  return conditionReview ? { ...status, required: true, conditionReview: true as const, rev }
    : { ...status, rev };
}

/**
 * What actually gets stored: trimmed, lowercased, blanks dropped, duplicates removed.
 *
 * This matters even without the floor guard it was written for: `evaluatePolicy` compares
 * normalized values, so a stored "gluten " would satisfy nothing it was meant to block (Loop 010,
 * 2026-09-14). Normalizing at the boundary means the value stored is the value matched.
 */
export function normalizeAllergens(next: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of next) {
    const value = raw.toLowerCase().trim();
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export async function putProfile(
  client: SupabaseClient, userId: string, req: ConstraintsPut,
  options: { completeReview?: boolean } = {},
): Promise<
  | { status: "ok"; profile: StoredProfile; rev: number }
  | { status: "conflict"; current_rev: number; entity: "constraint_profiles"; value: StoredProfile }
> {
  const { profile: current, rev, reviewRequired, reviewedAt } = await getProfile(client, userId);

  // Every allergen may be removed now (D1 §6.1): the rules belong to the account, so the server
  // has no list of its own to defend. Normalization still happens here, so the value stored is
  // the value every later comparison matches.
  const nextAllergens = normalizeAllergens(req.avoidAllergens ?? current.avoid_allergens);

  if (reviewRequired && reviewedAt === null && !options.completeReview) {
    const pending = reviewStatus(true, null, current);
    if (pending.candidateAllergens.some((key) => !nextAllergens.includes(key))
      || pending.candidateCategories.some((key) =>
        !(req.bannedCategories ?? current.banned_categories).includes(key))) {
      throw new HttpError(409, "rule_review_required",
        "Review your existing food rules before removing them.");
    }
  }

  if (req.baseRev !== rev) {
    return { status: "conflict", current_rev: rev, entity: "constraint_profiles", value: current };
  }

  const next = {
    user_id: userId,
    rev: rev + 1,
    conditions: req.conditions ?? current.conditions,
    notes: req.notes === undefined ? current.notes : req.notes,
    avoid_allergens: nextAllergens,
    avoid_food_ref_ids: req.avoidFoodRefIds ?? current.avoid_food_ref_ids,
    banned_categories: req.bannedCategories ?? current.banned_categories,
    custom_rules: req.customRules ?? current.custom_rules ?? [],
    updated_at: new Date().toISOString(),
    ...(options.completeReview ? { rule_review_required: false,
      rule_reviewed_at: new Date().toISOString() } : {}),
  };

  if (rev === 0) {
    const inserted = await client.from("constraint_profiles").upsert(next).select(SELECT)
      .maybeSingle();
    if (inserted.error) throw new HttpError(500, "internal", "Could not save the profile.");
    return { status: "ok", profile: toProfile(inserted.data as ProfileRow | null), rev: 1 };
  }

  // rev = baseRev in the WHERE clause is the compare-and-swap: a second writer between the
  // read and the update matches no row and falls through to the conflict answer.
  const updated = await client.from("constraint_profiles").update(next)
    .eq("user_id", userId).eq("rev", rev).select(SELECT).maybeSingle();
  if (updated.error) throw new HttpError(500, "internal", "Could not save the profile.");
  if (updated.data === null) {
    const fresh = await getProfile(client, userId);
    return {
      status: "conflict", current_rev: fresh.rev,
      entity: "constraint_profiles", value: fresh.profile,
    };
  }
  return { status: "ok", profile: toProfile(updated.data as ProfileRow), rev: rev + 1 };
}

/** One revision-checked write stores both explicit decisions and the completion marker. */
export async function completeRuleReview(
  client: SupabaseClient, userId: string, baseRev: number, choices: RuleChoices,
) {
  const { profile, rev, reviewRequired, reviewedAt } = await getProfile(client, userId);
  if (baseRev !== rev) {
    return { status: "conflict" as const, current_rev: rev,
      entity: "constraint_profiles" as const, value: profile };
  }
  const status = reviewStatus(reviewRequired, reviewedAt, profile);
  if (!status.required) {
    throw new HttpError(409, "review_not_required", "These rules have already been reviewed.");
  }
  let next: ReturnType<typeof applyRuleChoices>;
  try {
    next = applyRuleChoices(profile, status, choices);
  } catch {
    throw new HttpError(400, "incomplete_review", "Choose Keep or Remove for every rule.");
  }
  return putProfile(client, userId, { baseRev, avoidAllergens: next.avoid_allergens,
    bannedCategories: next.banned_categories }, { completeReview: true });
}
