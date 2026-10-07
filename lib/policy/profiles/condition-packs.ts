/**
 * Phase 13 §4 (DECIDED (run), amends rev 2), §9 R5: a condition pack is an opt-in bundle of a
 * `medical_condition`/`clinician_directive` profile's soft rules, plus any
 * `user_confirmed_safety` items it names — never a hard block from the diagnosis alone.
 * `lib/policy/condition-rules.ts`'s `CONDITION_RULES` stays empty (unchanged, v1 by design); a
 * pack's `user_confirmed_safety` items still need their own per-item confirmation
 * (isActiveHardRule, lib/policy/profiles/types.ts) before they can ever reach evaluatePolicy —
 * this module only describes what a pack offers, it does not confirm anything. Pure: no I/O
 * beyond the one env read `conditionPacksEnabled` makes.
 */
import type { RawProfile } from "@/lib/policy/profiles/schema";
import type { EvidenceStrength, HardBasis, RuleStrength } from "@/lib/policy/profiles/types";

export const CLINICIAN_ADVICE_FIRST_NOTE = "Your clinician's advice comes first.";

const PACK_CATEGORIES = ["medical_condition", "clinician_directive"] as const;

export type ConditionPackSoftRule = {
  facet: string;
  strength: RuleStrength;
  evidenceStrength: EvidenceStrength;
  /** The first citation id backing this rule; null when the profile cites none. */
  sourceCitationId: string | null;
};

export type ConditionPackSafetyItem = { facet: string; hardBasis: HardBasis };

export type ConditionPack = {
  profileId: string;
  label: string;
  softRules: readonly ConditionPackSoftRule[];
  /** Each still needs its own confirmation (§9 R5) — this pack only lists the candidates. */
  confirmableSafetyItems: readonly ConditionPackSafetyItem[];
  clinicianNote: typeof CLINICIAN_ADVICE_FIRST_NOTE;
};

/** Whether a profile of this category is a condition pack (§4) — offered only behind the flag. */
export function isConditionPackCategory(category: string): boolean {
  return (PACK_CATEGORIES as readonly string[]).includes(category);
}

function softRulesFor(profile: RawProfile): ConditionPackSoftRule[] {
  const sourceCitationId = profile.citations[0]?.id ?? null;
  const rule = (facet: string, strength: RuleStrength): ConditionPackSoftRule =>
    ({ facet, strength, evidenceStrength: profile.evidence.strength, sourceCitationId });
  return [
    ...profile.soft_limit_facets.map((facet) => rule(facet, "limit" as const)),
    ...profile.prefer_facets.map((facet) => rule(facet, "prefer" as const)),
  ];
}

/**
 * `null` when `profile` cannot be a condition pack at all (wrong category), or would carry
 * nothing (no soft rule and no confirmable safety item) — an empty pack offers the user nothing.
 */
export function conditionPackFrom(profile: RawProfile): ConditionPack | null {
  if (!isConditionPackCategory(profile.category)) return null;
  const softRules = softRulesFor(profile);
  const confirmableSafetyItems: ConditionPackSafetyItem[] = profile.hard_basis === "user_confirmed_safety"
    ? profile.hard_avoid_facets.map((facet) => ({ facet, hardBasis: "user_confirmed_safety" as const }))
    : [];
  if (softRules.length === 0 && confirmableSafetyItems.length === 0) return null;
  return {
    profileId: profile.id, label: profile.label, softRules, confirmableSafetyItems,
    clinicianNote: CLINICIAN_ADVICE_FIRST_NOTE,
  };
}

export function conditionPacks(profiles: readonly RawProfile[]): ConditionPack[] {
  return profiles.map(conditionPackFrom).filter((pack): pack is ConditionPack => pack !== null);
}

/**
 * Off in production until the owner reviews pack wording on a Preview (§4, §8 item 4) — that review
 * gates only this flag, not the rest of slice 3. Reads the env var directly, the same pattern as
 * `lib/capture/public-flags.ts`'s `NEXT_PUBLIC_FEATURE_SCAN`: unset or anything but "1" is off.
 */
export type ConditionPacksEnv = { CONDITION_PACKS_ENABLED?: string };

export function conditionPacksEnabled(env?: ConditionPacksEnv): boolean {
  return (env?.CONDITION_PACKS_ENABLED ?? process.env.CONDITION_PACKS_ENABLED) === "1";
}

/** The packs to actually offer right now — empty whenever the flag is off, regardless of how
 *  many the document defines. */
export function availableConditionPacks(
  profiles: readonly RawProfile[],
  env?: ConditionPacksEnv,
): ConditionPack[] {
  return conditionPacksEnabled(env) ? conditionPacks(profiles) : [];
}
