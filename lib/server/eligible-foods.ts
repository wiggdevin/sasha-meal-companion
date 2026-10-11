import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSuggestionEvidence, suggestionItemsVerdict }
  from "@/lib/coach/suggest-policy";
import { namedRuleMark } from "@/lib/foods/rule-reason";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";
import { HttpError } from "@/lib/server/auth";
import { getRuleReviewStatus } from "@/lib/server/constraints";
import { readPolicyProfile } from "@/lib/server/policy-profile";
import { fetchAllRows, fetchByKeyChunks } from "@/lib/server/paged-read";
import type { RuleMark } from "@/lib/types";

type Pref = { food_ref_id: string; status: string };
type Ref = { id: string; kind: string; catalog_food_id: number | null;
  user_food_id: string | null;
  user_foods: UserFoodRow | UserFoodRow[] | null };
type UserFoodRow = { id: string; user_id: string; name?: string | null };
type Revision = { id: number; catalog_food_id: number; description?: string | null };
type Candidate = { ref: Ref; item: { foodRefId: string;
  catalogFoodRevisionId: number | null; verdict: "allowed" } };

/**
 * An Eats ref the current rules did not clear.
 *
 * `reason` is the FRAGMENT a mark shows after a name ("has peanut, which your rules exclude."). It
 * stays a fragment because `lib/foods/eligible-client.ts` stores it per local food and
 * `lib/foods/rule-marks.ts` prefixes the saved line's own name (installed phones read it too).
 * `name` and `mark` are the full answer for a surface that shows the exclusion itself: `mark.reason`
 * is the whole sentence with the food's name, built by the same `namedRuleMark` the phone uses.
 */
export type ExcludedFoodRef = {
  refId: string; verdict: "blocked" | "unknown"; reason: string;
  /** The account's own food name or the catalog's active description; "This food" when unreadable. */
  name: string;
  /** `{ verdict, reason: "<name> <fragment>" }` — the same shape and words as every RuleMark. */
  mark: RuleMark;
};

const UNNAMED = "This food";

/** The reason every Eats ref carries when the evidence read failed (Phase 18 W2b reads it: a failed
 *  evidence read admits nothing). */
export const EVIDENCE_UNAVAILABLE = "could not be checked against your food rules right now.";

function excludedRef(refId: string, verdict: RuleMark["verdict"], reason: string,
  name: string | null | undefined): ExcludedFoodRef {
  const label = name?.trim() || UNNAMED;
  return { refId, verdict, reason, name: label, mark: namedRuleMark(label, { verdict, reason }) };
}

export type EligibleFoods = {
  eligibleRefIds: string[];
  eligibleFoodIds: string[];
  eligibleCatalogFoodIds: number[];
  /** Every Eats ref NOT cleared, so a saved meal holding it can say why (2026-10-05 F1). */
  excluded: ExcludedFoodRef[];
  /** The constraint-profile revision these answers were computed under. */
  rulesRevision: number;
  /** The normalized diet flags these answers were judged under; absent when evidence was unread. */
  preferenceFlags?: string[];
};

function ownRow(ref: Ref, userId: string): UserFoodRow | null {
  const row = Array.isArray(ref.user_foods) ? ref.user_foods[0] : ref.user_foods;
  return row?.user_id === userId && row.id === ref.user_food_id ? row : null;
}

function ownFood(ref: Ref, userId: string): string | null {
  return ownRow(ref, userId)?.id ?? null;
}

/** Current account Eats only, passed through the coach's existing evidence and policy gate. */
export async function eligibleFoods(client: SupabaseClient, userId: string): Promise<EligibleFoods> {
  const review = await getRuleReviewStatus(client, userId);
  if (review.required) {
    throw new HttpError(409, "rule_review_required",
      "Review your existing food rules in Settings before getting meal suggestions.");
  }
  const [prefs, policy] = await Promise.all([
    // t18 r5: paged past the API row cap; a failed page throws, never a shorter Eats list.
    fetchAllRows<Pref>((from, to) => client.from("user_food_prefs").select("food_ref_id,status")
      .eq("user_id", userId).eq("status", "eats").order("food_ref_id").range(from, to)),
    readPolicyProfile(client, userId, new Date()),
  ]);
  const refIds = [...new Set(prefs.filter((row) => row.status === "eats")
    .map((row) => row.food_ref_id))];
  const rulesRevision = policy.rev;
  // A name is read only from this account's own food or the catalog; another account's row never.
  const names = new Map<string, string>();
  const unchecked = (ids: readonly string[], reason: string): ExcludedFoodRef[] =>
    ids.map((refId) => excludedRef(refId, "unknown", reason, names.get(refId)));
  if (refIds.length === 0) return empty(rulesRevision);
  // W038: every `.in()` list is chunked (one active revision per food); a failed chunk rejects,
  // never a shorter set.
  const refs = await fetchByKeyChunks<string, Ref>(refIds, (batch) => client.from("food_refs")
    .select("id,kind,catalog_food_id,user_food_id,user_foods(id,user_id,name)").in("id", batch));
  const catalogIds = [...new Set(refs.filter((ref) => ref.kind === "catalog")
    .map((ref) => ref.catalog_food_id).filter((id): id is number => id !== null))];
  const revisionRows = await fetchByKeyChunks<number, Revision>(catalogIds, (batch) =>
    client.from("catalog_food_revisions").select("id,catalog_food_id,description")
      .in("catalog_food_id", batch).eq("is_active", true));
  const revisions = new Map(revisionRows.map((row) => [row.catalog_food_id, row.id]));
  const descriptions = new Map(revisionRows.map((row) => [row.catalog_food_id, row.description]));
  for (const ref of refs) {
    const name = ref.kind === "user" ? ownRow(ref, userId)?.name
      : ref.catalog_food_id !== null ? descriptions.get(ref.catalog_food_id) : null;
    if (typeof name === "string" && name.trim()) names.set(ref.id, name.trim());
  }
  const candidates: Candidate[] = refs.flatMap((ref): Candidate[] => {
    if (ref.kind === "user" && ownFood(ref, userId)) {
      return [{ ref, item: { foodRefId: ref.id, catalogFoodRevisionId: null,
        verdict: "allowed" as const } }];
    }
    const revisionId = ref.kind === "catalog" && ref.catalog_food_id !== null
      ? revisions.get(ref.catalog_food_id) : undefined;
    return revisionId === undefined ? [] : [{ ref, item: {
      foodRefId: ref.id, catalogFoodRevisionId: revisionId, verdict: "allowed" as const,
    } }];
  });
  const candidateIds = new Set(candidates.map(({ ref }) => ref.id));
  const uncheckable = unchecked(refIds.filter((id) => !candidateIds.has(id)),
    "could not be checked against your food rules.");
  if (candidates.length === 0) return { ...empty(rulesRevision), excluded: uncheckable };
  const evidence = await loadSuggestionEvidence(userId, candidates.map(({ item }) => item), {
    needsNoCook: false, facets: profileRuleFacets(policy.profile.profileRules),
  });
  if (evidence.status !== "ready") {
    return { ...empty(rulesRevision), excluded: unchecked(refIds, EVIDENCE_UNAVAILABLE) };
  }
  const judged = candidates.map((candidate) => {
    const verdict = suggestionItemsVerdict([candidate.item], evidence, policy.profile, false);
    const onEats = evidence.byIdentity[`ref:${candidate.item.foodRefId}`]?.onEatsList === true;
    return { ...candidate, verdict, ok: verdict.outcome === "allowed" && onEats };
  });
  const allowed = judged.filter(({ ok }) => ok);
  const excluded: ExcludedFoodRef[] = [...uncheckable, ...judged.filter(({ ok }) => !ok)
    .map(({ ref, verdict }): ExcludedFoodRef => verdict.outcome === "blocked"
      ? excludedRef(ref.id, "blocked", verdict.reason ?? "is excluded by your food rules.",
        names.get(ref.id))
      : excludedRef(ref.id, "unknown",
        verdict.reason ?? "has not been verified against your food rules.", names.get(ref.id)))];
  return {
    excluded, rulesRevision, preferenceFlags: [...evidence.preferenceFlags],
    eligibleRefIds: allowed.map(({ ref }) => ref.id),
    eligibleFoodIds: [...new Set(allowed.map(({ ref }) => ownFood(ref, userId))
      .filter((id): id is string => id !== null))],
    eligibleCatalogFoodIds: [...new Set(allowed.map(({ ref }) => ref.catalog_food_id)
      .filter((id): id is number => id !== null))],
  };
}

function empty(rulesRevision: number): EligibleFoods {
  return { eligibleRefIds: [], eligibleFoodIds: [], eligibleCatalogFoodIds: [], excluded: [],
    rulesRevision };
}
