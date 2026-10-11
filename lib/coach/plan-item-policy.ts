/**
 * The full policy pass for a food a plan write places (W014; audit 2026-10-10 A023, A128, A134).
 *
 * Grounding judges a food with lib/coach/policy.ts checkItemWithMarks, which reads the account's
 * allergens, banned categories, custom rules and Avoid list but not its diet flags (vegetarian,
 * halal, no_pork …), its confirmed profile hard rules or the human-food check. A suggestion, an
 * eligible food and a saved recipe read all of them (suggest-verdict.ts). This brings a plan write
 * to the same pass, over the same cache-only evidence (loadSuggestionEvidence):
 *
 * - blocked by any rule, or not human food → `blocked`, so lib/coach/plan-policy.ts
 *   refusePlanBlocked refuses the action whole with the reason;
 * - a rule the evidence cannot settle → `unverified` with its marks ("Not verified" on the card);
 * - evidence that could not be read → `unverified` (fail closed: never a silent `allowed`).
 *
 * A food with no human-food judgment yet stays as grounded: that facet is warmed for few catalog
 * foods (suggest-verdict.ts), and a plan write is the user's own named food, not a suggestion.
 * Jev decides nothing here: allergen, diet and profile marks are deterministic (Phase 18 W2a/W2c).
 */
import type { CoachAction, GroundedNamedFood } from "@/lib/coach/actions";
import { PLAN_WRITE_KINDS } from "@/lib/coach/plan-policy";
import {
  loadSuggestionEvidence, suggestionFoodIdentity, type SuggestionEvidence, type SuggestionEvidenceOptions,
} from "@/lib/coach/suggest-policy";
import { suggestionPolicyEvidence } from "@/lib/coach/suggest-verdict";
import { evaluatePolicy, type ConstraintProfile, type PolicyMark } from "@/lib/policy/constraints";
import { facetOutcome } from "@/lib/policy/facet-rules";
import { profileRuleFacets } from "@/lib/policy/profiles/account-rules";

export type PlanFood = Pick<GroundedNamedFood,
  "name" | "foodRefId" | "catalogFoodRevisionId" | "verdict" | "marks">;
export type PlanFoodJudgement =
  | { verdict: "allowed" }
  | { verdict: "blocked"; reason?: string }
  | { verdict: "unverified"; marks: PolicyMark[] };

/** loadSuggestionEvidence's shape: a plan food is judged by its ref and pinned revision only. */
export type PlanEvidencePort = (
  userId: string, foods: readonly Pick<PlanFood, "foodRefId" | "catalogFoodRevisionId">[],
  options: SuggestionEvidenceOptions,
) => Promise<SuggestionEvidence>;
export type PlanPolicyOptions = { evidence?: SuggestionEvidence; evidencePort?: PlanEvidencePort };

/** One food against every rule of the account. A grounded `blocked` always stays blocked. */
export function judgePlanFood(
  food: PlanFood, evidence: SuggestionEvidence, profile: ConstraintProfile,
): PlanFoodJudgement {
  if (food.verdict === "blocked") return { verdict: "blocked" };
  if (evidence.status !== "ready") return { verdict: "unverified", marks: food.marks ?? [] };
  const facts = evidence.byIdentity[suggestionFoodIdentity(food)];
  const policy = evaluatePolicy(profile,
    suggestionPolicyEvidence(food.foodRefId, facts, evidence.preferenceFlags, profile));
  if (policy.verdict === "blocked") return { verdict: "blocked", reason: policy.reason };
  if (facetOutcome("human_food", facts?.facets.human_food?.p, "exclude") === "absent") {
    return { verdict: "blocked", reason: "not_human_food" };
  }
  if (policy.verdict === "unverified") return { verdict: "unverified", marks: policy.marks ?? [] };
  if (food.verdict === "unverified") return { verdict: "unverified", marks: food.marks ?? [] };
  return { verdict: "allowed" };
}

/** The food with its judgement applied: the verdict, and the marks only while unverified. */
export function withJudgement<F extends PlanFood>(food: F, judged: PlanFoodJudgement): F {
  const { marks: _marks, ...rest } = food;
  return (judged.verdict === "unverified"
    ? { ...rest, verdict: "unverified", marks: judged.marks }
    : { ...rest, verdict: judged.verdict }) as F;
}

/** The foods one plan-write action places. */
export function planFoodsOf(action: CoachAction): PlanFood[] {
  if (action.kind === "set_slot_meal") return action.items;
  if (action.kind === "add_slot_item") return [action.item];
  if (action.kind === "set_slot_item") return [action];
  return [];
}

function judgedAction(
  action: CoachAction, judge: (food: PlanFood) => PlanFoodJudgement,
): CoachAction {
  const apply = <F extends PlanFood>(food: F) => withJudgement(food, judge(food));
  const named = (foods: PlanFood[]) => foods.filter((food) => food.verdict === "blocked")
    .map((food) => food.name);
  if (action.kind === "set_slot_meal") {
    const items = action.items.map(apply);
    return { ...action, items, flagged: named(items) };
  }
  if (action.kind === "add_slot_item") {
    const item = apply(action.item);
    return { ...action, item, flagged: named([item]) };
  }
  if (action.kind === "set_slot_item") {
    const food = apply(action);
    return { ...food, flagged: named([food]) };
  }
  return action;
}

/**
 * Every plan write of a batch judged in one evidence read. Its `flagged` lists every blocked food,
 * so refusePlanBlocked (run after this) refuses it; every other action passes through untouched.
 */
export async function judgePlanActions(
  userId: string, actions: readonly CoachAction[], profile: ConstraintProfile,
  options: PlanPolicyOptions = {},
): Promise<CoachAction[]> {
  const foods = actions.filter((action) => PLAN_WRITE_KINDS.has(action.kind)).flatMap(planFoodsOf);
  if (foods.length === 0) return [...actions];
  const evidence = options.evidence ?? await (options.evidencePort ?? loadSuggestionEvidence)(
    userId, foods, { needsNoCook: false, facets: profileRuleFacets(profile.profileRules) },
  );
  if (evidence.status !== "ready") {
    console.warn("[coach-plan-policy] evidence unavailable; plan foods marked unverified");
  }
  return actions.map((action) => PLAN_WRITE_KINDS.has(action.kind)
    ? judgedAction(action, (food) => judgePlanFood(food, evidence, profile)) : action);
}
