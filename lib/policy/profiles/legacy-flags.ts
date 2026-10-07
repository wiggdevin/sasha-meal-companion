/**
 * Phase 13 slice 4 (§4, §9 R5): maps the 12 legacy `PREFERENCE_FLAGS`
 * (lib/profile/onboarding-state.ts) onto the profile-instance model one-to-one, so a flag an
 * account already turned on keeps working exactly as `evaluatePolicy`/`rankFoods` see it, even
 * before onboarding or chat capture writes that account its own `user_dietary_profiles` row.
 *
 * Every one of the 12 is non-medical (an allergy, a religious pick or the user's own diet rule —
 * never a `user_confirmed_safety` item), so every rule this produces confirms outright: the flag
 * was already the user's own explicit toggle, and mapping it forward is not a NEW confirmation,
 * it carries the one they already gave (contrast R5's medical items, which start unconfirmed no
 * matter how they entered the account). `no_pork`/`no_beef` name no profile in the 124-row catalog
 * (docs/research/dietary-profiles.draft.json models only religious pork/beef rules); rather than
 * drop the flag, this mints a minimal typed `user_rule` instance directly, same typed shape as
 * every catalog-backed one.
 *
 * The re-declared flag literal (not an import of PREFERENCE_FLAGS) keeps this module inside
 * lib/policy/profiles's "pure, no I/O" boundary — onboarding-state.ts reaches into lib/store and
 * lib/device/account, which this module has no business loading. legacy-flags.test.ts pins the two
 * lists equal.
 */
import { profileDefinition } from "@/lib/policy/profiles/catalog";
import { buildProfileInstance, type RuleItemConfirmation } from "@/lib/policy/profiles/loader";
import { ruleId, type ProfileInstance, type RuleItem } from "@/lib/policy/profiles/types";

export const LEGACY_PREFERENCE_FLAGS = [
  "vegetarian", "vegan", "pescatarian", "no_pork", "no_beef", "no_shellfish",
  "no_eggs", "no_soy", "no_peanuts", "low_fodmap", "halal", "kosher",
] as const;
export type LegacyPreferenceFlag = (typeof LEGACY_PREFERENCE_FLAGS)[number];

type SyntheticRule = { profileId: string; facet: string };

/** A flag with more than one row (no_shellfish) confirms every row it names. */
const CATALOG_PROFILE_IDS: Partial<Record<LegacyPreferenceFlag, readonly string[]>> = {
  vegetarian: ["vegetarian_lacto_ovo"],
  vegan: ["vegan"],
  pescatarian: ["pescatarian"],
  no_shellfish: ["allergy_crustacean", "allergy_mollusc"],
  no_eggs: ["allergy_egg"],
  no_soy: ["allergy_soy"],
  no_peanuts: ["allergy_peanut"],
  low_fodmap: ["ibs_low_fodmap"],
  halal: ["halal"],
  kosher: ["kosher"],
};

const SYNTHETIC_RULES: Partial<Record<LegacyPreferenceFlag, SyntheticRule>> = {
  no_pork: { profileId: "legacy_no_pork", facet: "contains_ingredient:pork" },
  no_beef: { profileId: "legacy_no_beef", facet: "contains_ingredient:beef" },
};

/** The catalog instance a legacy flag carries forward. Exported for its guard's own test: a
 *  `user_confirmed_safety` (medical) item is never pre-confirmed here, whatever id it is given —
 *  enforced in code, not only by the header's "every flag is non-medical" claim (R5). */
export function legacyInstanceFromCatalog(profileId: string, confirmedAt: string): ProfileInstance | null {
  const definition = profileDefinition(profileId);
  if (!definition) return null;
  const confirmations: RuleItemConfirmation[] = definition.templates
    .filter((template) => template.strength === "never" && template.hardBasis !== null
      && template.hardBasis !== "user_confirmed_safety")
    .map((template) => ({ facet: template.facet, confirmed: true }));
  return buildProfileInstance(definition, { source: "user_stated", confirmedAt, confirmations });
}

function syntheticInstance(rule: SyntheticRule, confirmedAt: string): ProfileInstance {
  const item: RuleItem = {
    id: ruleId(rule.profileId, rule.facet), profileId: rule.profileId, facet: rule.facet,
    strength: "never", hardBasis: "user_rule", evidenceStrength: null,
    confirmation: "confirmed", expiresAt: null,
  };
  return { profileId: rule.profileId, source: "user_stated", confirmedAt, rules: [item], options: {} };
}

/** Every confirmed instance one legacy flag maps to — zero, one (most flags) or two
 *  (`no_shellfish`: crustacean and mollusc are separate catalog allergies). */
export function profileInstancesForLegacyFlag(
  flag: LegacyPreferenceFlag,
  confirmedAt: string,
): ProfileInstance[] {
  const catalogIds = CATALOG_PROFILE_IDS[flag];
  if (catalogIds) {
    return catalogIds
      .map((id) => legacyInstanceFromCatalog(id, confirmedAt))
      .filter((instance): instance is ProfileInstance => instance !== null);
  }
  const synthetic = SYNTHETIC_RULES[flag];
  return synthetic ? [syntheticInstance(synthetic, confirmedAt)] : [];
}

export function profileInstancesForLegacyFlags(
  flags: readonly LegacyPreferenceFlag[],
  confirmedAt: string,
): ProfileInstance[] {
  return flags.flatMap((flag) => profileInstancesForLegacyFlag(flag, confirmedAt));
}

/** Every profile id the given flags synthesize — the profiles only a preference toggle removes. */
export function legacyProfileIdsFor(flags: readonly LegacyPreferenceFlag[]): Set<string> {
  const ids = new Set<string>();
  for (const flag of flags) {
    for (const id of CATALOG_PROFILE_IDS[flag] ?? []) ids.add(id);
    const synthetic = SYNTHETIC_RULES[flag];
    if (synthetic) ids.add(synthetic.profileId);
  }
  return ids;
}
