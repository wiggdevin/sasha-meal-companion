/**
 * Phase 13 §6 row 5: the dietary-profile half of the reply check (lib/server/reply-check.ts).
 *
 * A confirmed profile hard rule (religious, user_rule, user_confirmed_safety — the ones
 * `isActiveHardRule` accepts) is judged against each named food's own deterministic evidence.
 * Phase 18 W2c (docs/specs/phase-18-open-world-foods.md D4, D9): no Jev facet is read and no Jev
 * tag is requested here any more. A food's evidence (name, ingredient text, stored non-Jev allergen
 * evidence, tags, categories) comes from the same read suggestions use; whatever it cannot decide
 * stays unknown, and the caller treats unknown as unresolved.
 *
 * I/O only through the ports; pure otherwise.
 */
import { FACETS, type Facet } from "@/lib/foods/facet-vocabulary";
import type { DietEvidence } from "@/lib/policy/diet-evidence";
import {
  activeConfirmedHardMarks, type ProfilePolicyMark, type ProfileRuleSet,
} from "@/lib/policy/profiles/hard-rules";

export type FacetFood = { foodRefId: string; catalogFoodRevisionId: number | null };

export type ProfileEvidencePorts = {
  /** Each food's deterministic evidence, keyed by food ref id. Never a model call. */
  foodEvidence?: (userId: string, foods: readonly FacetFood[]) => Promise<ReadonlyMap<string, DietEvidence>>;
};

export type Settled<T> = { ok: true; value: T } | { ok: false };

/** The work's value, or `{ ok: false }` when it rejects or `deadlineAt` (epoch ms) passes first. */
export async function settleBy<T>(work: Promise<T>, deadlineAt: number): Promise<Settled<T>> {
  const budgetMs = deadlineAt - Date.now();
  const settled = work.then((value): Settled<T> => ({ ok: true, value }), (): Settled<T> => ({ ok: false }));
  if (budgetMs <= 0) return { ok: false };
  let timer!: ReturnType<typeof setTimeout>;
  const late = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), budgetMs);
  });
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}

const FACET_SET = new Set<string>(FACETS);

/** The frozen facets the active rules reference: the ones a food's stored evidence can answer. */
export function ruleFacets(rules: ProfileRuleSet): Facet[] {
  return [...new Set(rules.items.map((rule) => rule.facet))]
    .filter((facet): facet is Facet => FACET_SET.has(facet));
}

/**
 * Every food's deterministic evidence, read once. `null` only when the read itself failed or ran
 * late: the caller fails closed on that.
 */
export async function resolveProfileEvidence(
  userId: string, foods: readonly FacetFood[], rules: ProfileRuleSet,
  ports: ProfileEvidencePorts, deadlineAt: number,
): Promise<Map<string, DietEvidence> | null> {
  const out = new Map<string, DietEvidence>();
  if (ruleFacets(rules).length === 0 || foods.length === 0 || !ports.foodEvidence) return out;
  const read = await settleBy(ports.foodEvidence(userId, foods), deadlineAt);
  if (!read.ok) return null;
  for (const [id, evidence] of read.value) out.set(id, evidence);
  return out;
}

/**
 * The profile marks one food earns: "present" blocks, "unknown" is unresolved. The named words and
 * the food's own name both count toward "present"; only the food's own stored name can clear it as
 * a plain whole food, never the words alone.
 */
export function profileMarksFor(
  rules: ProfileRuleSet, name: string, ingredientsText: string | null | undefined,
  evidence?: DietEvidence,
): ProfilePolicyMark[] {
  return activeConfirmedHardMarks(rules, {
    ...evidence,
    ingredientsText: evidence?.ingredientsText ?? ingredientsText,
    foodName: [name, evidence?.foodName].filter(Boolean).join(", "),
    wholeFoodName: evidence?.foodName ?? null,
  });
}
