/**
 * The full policy pass for a food a plan write places (W014; audit 2026-10-10 A023, A128, A134).
 *
 * Grounding judges a food with lib/coach/policy.ts checkItemWithMarks, which reads the account's
 * allergens, banned categories, custom rules and Avoid list but not its diet flags (vegetarian,
 * halal, no_pork …), its confirmed profile hard rules or the human-food check. A suggestion, an
 * eligible food and a saved recipe read all of them (suggest-verdict.ts). This brings a plan write
 * to the same pass, over the same cache-only evidence (loadSuggestionEvidence), and fails closed
 * the same way (suggestionItemsVerdict):
 *
 * - blocked by any rule, or not human food → `blocked`, so lib/coach/plan-policy.ts
 *   refusePlanBlocked refuses the action whole with the reason;
 * - a rule the evidence cannot settle, a grounded `unverified`, or a food that is not a plain whole
 *   food and has no human-food judgment yet → `unverified`;
 * - evidence that could not be read → `unverified` (never a silent `allowed`).
 *
 * A plan holds only foods the rules clear: gatePlanActions refuses an action holding an
 * `unverified` food too, with its own words (A128, review round 1). Jev decides nothing here:
 * allergen, diet and profile marks are deterministic (Phase 18 W2a/W2c).
 */
import type { CoachAction, GroundedNamedFood } from "@/lib/coach/actions";
import { PLAN_WRITE_KINDS, refusePlanBlocked } from "@/lib/coach/plan-policy";
import {
  loadSuggestionEvidence, suggestionFoodIdentity, type SuggestionEvidence, type SuggestionEvidenceOptions,
} from "@/lib/coach/suggest-policy";
import { plainWholeFood, suggestionPolicyEvidence } from "@/lib/coach/suggest-verdict";
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
  const human = facetOutcome("human_food", facts?.facets.human_food?.p, "exclude");
  if (human === "absent") return { verdict: "blocked", reason: "not_human_food" };
  if (policy.verdict === "unverified") return { verdict: "unverified", marks: policy.marks ?? [] };
  if (food.verdict === "unverified") return { verdict: "unverified", marks: food.marks ?? [] };
  // suggestionItemsVerdict's rule: a plain whole food is human food by its own name; anything else
  // (packaged, branded, a dish) needs a judgment before a plan holds it.
  if (human === "unknown" && !plainWholeFood(facts)) {
    return { verdict: "unverified", marks: policy.marks ?? [] };
  }
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

/**
 * A plan write holding a food the rules could not clear is refused whole, like a blocked one, but
 * says so honestly: the food may be fine, it just could not be checked (A128: fail closed, as
 * suggestions and recipes do). A log is never refused (ruling 2026-09-14).
 */
export function refusePlanUnverified(actions: readonly CoachAction[]): {
  actions: CoachAction[]; refusals: string[];
} {
  const kept: CoachAction[] = [];
  const refusals: string[] = [];
  for (const action of actions) {
    const unchecked = PLAN_WRITE_KINDS.has(action.kind)
      ? planFoodsOf(action).filter((food) => food.verdict === "unverified").map((food) => food.name)
      : [];
    if (unchecked.length === 0) {
      kept.push(action);
      continue;
    }
    refusals.push(`I didn't put ${unchecked.join(", ")} in your plan — I couldn't check `
      + `${unchecked.length === 1 ? "it" : "them"} against your food rules. Pick something else, `
      + "or try again in a moment.");
  }
  return { actions: kept, refusals };
}

/** The whole plan-write gate: judge every plan food, then refuse blocked and unchecked writes. */
export async function gatePlanActions(
  userId: string, actions: readonly CoachAction[], profile: ConstraintProfile,
  options: PlanPolicyOptions = {},
): Promise<{ actions: CoachAction[]; refusals: string[] }> {
  const blocked = refusePlanBlocked(await judgePlanActions(userId, actions, profile, options));
  const unchecked = refusePlanUnverified(blocked.actions);
  return { actions: unchecked.actions, refusals: [...blocked.refusals, ...unchecked.refusals] };
}
