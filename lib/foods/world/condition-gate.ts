/**
 * The open-world condition gate (Phase 18 D4, W2b; owner decision Q4,
 * docs/decisions/2026-10-05-phase-18-open-questions.md). An account with a stated condition opens
 * only when the user has confirmed EACH condition in reviewed wording: either the matching pack's
 * safety items (`pack`) or "This condition does not limit what I eat" (`no_limit`). The wording
 * is reviewed only once a qualified clinical reviewer and the owner have signed it off; until then
 * `CONDITION_PACKS_ENABLED` stays off and no confirmation is accepted, so every account with a
 * condition stays closed.
 *
 * A condition added or edited later on an open account closes it again; the database does that in
 * the same write (migrations 20261213090200 and 20261213090400), and the gate here decides what the user must confirm.
 *
 * Pure. No I/O beyond the one env read `conditionPacksEnabled` makes.
 */
import { conditionPacksEnabled, type ConditionPacksEnv } from "@/lib/policy/profiles/condition-packs";

export type ConditionChoice = "pack" | "no_limit";
export type ConditionConfirmation = { condition: string; choice: ConditionChoice };

const SPACE = /[ \t\n\r\f\v]+/g;

/** The one key a condition is confirmed under; SQL `food_world_condition_key` matches it. */
export function conditionKey(condition: string): string {
  return condition.replace(SPACE, " ").trim().toLowerCase();
}

/** The stated conditions with no confirmation, by key, first spelling kept, in stated order. */
export function unconfirmedConditions(conditions: readonly string[],
  confirmedKeys: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  return conditions.filter((condition) => {
    const key = conditionKey(condition);
    if (!key || confirmedKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A pack whose confirmed safety items are allergen rules the account then avoids. Celiac's gluten
 * rule is the first. The wording is held behind `CONDITION_PACKS_ENABLED` until the clinical
 * review (Q4); a condition with no pack here can still be confirmed as `no_limit`.
 */
export type AllergenPack = { id: string; label: string; allergens: readonly string[] };

const ALLERGEN_PACKS: readonly (AllergenPack & { keys: readonly string[] })[] = [
  { id: "celiac", label: "Celiac disease", allergens: ["gluten"],
    keys: ["celiac", "celiac disease", "coeliac", "coeliac disease"] },
];

export function allergenPackFor(condition: string): AllergenPack | null {
  const key = conditionKey(condition);
  const pack = ALLERGEN_PACKS.find((entry) => entry.keys.includes(key));
  return pack ? { id: pack.id, label: pack.label, allergens: pack.allergens } : null;
}

export type ConfirmationPlan =
  | { ok: true; confirmations: { key: string; choice: ConditionChoice }[]; allergens: string[] }
  | { ok: false; reason: "packs_disabled" | "unknown_condition" | "no_pack"; conditions: string[] };

/**
 * What a set of confirmations writes: one row per stated condition it names, and the allergen
 * rules its packs add. Refused whole when the reviewed wording is not live, when it names a
 * condition the account does not state, or when it picks `pack` for a condition with no pack.
 */
export function planConfirmations(stated: readonly string[], confirmations: readonly ConditionConfirmation[],
  env?: ConditionPacksEnv): ConfirmationPlan {
  if (confirmations.length === 0) return { ok: true, confirmations: [], allergens: [] };
  const names = confirmations.map((entry) => entry.condition);
  if (!conditionPacksEnabled(env)) return { ok: false, reason: "packs_disabled", conditions: names };
  const statedKeys = new Set(stated.map(conditionKey));
  const unknown = names.filter((name) => !statedKeys.has(conditionKey(name)));
  if (unknown.length) return { ok: false, reason: "unknown_condition", conditions: unknown };
  const noPack = confirmations.filter((entry) => entry.choice === "pack" && !allergenPackFor(entry.condition))
    .map((entry) => entry.condition);
  if (noPack.length) return { ok: false, reason: "no_pack", conditions: noPack };
  return {
    ok: true,
    confirmations: confirmations.map((entry) => ({ key: conditionKey(entry.condition), choice: entry.choice })),
    allergens: [...new Set(confirmations.filter((entry) => entry.choice === "pack")
      .flatMap((entry) => allergenPackFor(entry.condition)?.allergens ?? []))],
  };
}
