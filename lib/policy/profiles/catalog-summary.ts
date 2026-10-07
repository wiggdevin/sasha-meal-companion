/**
 * Phase 13 slice 4 (§4 "onboarding capture"): the plain-language half of the catalog. The map's
 * own `do`/`dont` prose (docs/research/dietary-profiles.draft.json) is already reviewed,
 * profile-specific copy — this module reads it straight off the validated document rather than
 * deriving anything from facet codes, so onboarding and the chat confirm card show the same words
 * a reviewer already signed off on. Pure: no I/O, no policy effect (loader.ts/account-rules.ts own
 * that half).
 */
import { DIETARY_PROFILES_DOCUMENT, PROFILE_DEFINITIONS } from "@/lib/policy/profiles/catalog";
import {
  conditionPacksEnabled, isConditionPackCategory, type ConditionPacksEnv,
} from "@/lib/policy/profiles/condition-packs";
import type { HardBasis, RuleStrength } from "@/lib/policy/profiles/types";

/** One facet a confirm UI can offer, without exposing evidence/expiry/target-modifier detail a
 *  caller has no business setting from a tap. */
export type ProfileSummaryItem = {
  facet: string;
  strength: RuleStrength;
  hardBasis: HardBasis | null;
};

/** A yes/no variant the user sets (halal "Meat must be halal-slaughtered", kosher "Passover
 *  rules"). A variant whose answer is a word or a number (kosher's observance level, its
 *  meat→dairy wait) is not carried: ProfileInstance.options stores booleans only. */
export type ProfileOption = { id: string; label: string; default: boolean };

export type ProfileSummary = {
  id: string;
  label: string;
  category: string;
  synonyms: readonly string[];
  do: readonly string[];
  dont: readonly string[];
  hardBasis: HardBasis | null;
  requiresUserConfirmation: boolean;
  /** Every rule item confirming this profile can set, in the order `buildProfileInstance`
   *  (lib/policy/profiles/loader.ts) built them from — what a confirm card sends back as
   *  `{ facet, confirmed }` pairs. */
  items: readonly ProfileSummaryItem[];
  options: readonly ProfileOption[];
};

let cached: readonly ProfileSummary[] | null = null;

/** Every profile the validated document carries, in its own catalog order. */
export function catalogSummaries(): readonly ProfileSummary[] {
  if (cached === null) {
    cached = DIETARY_PROFILES_DOCUMENT.profiles.map((profile) => {
      const definition = PROFILE_DEFINITIONS.get(profile.id);
      return {
        id: profile.id,
        label: profile.label,
        category: profile.category,
        synonyms: profile.synonyms,
        do: profile.do,
        dont: profile.dont,
        hardBasis: profile.hard_basis,
        requiresUserConfirmation: profile.requires_user_confirmation,
        items: (definition?.templates ?? []).map((template) => ({
          facet: template.facet, strength: template.strength, hardBasis: template.hardBasis,
        })),
        options: profile.options.flatMap((option) => typeof option.default === "boolean"
          ? [{ id: option.id, label: option.label, default: option.default }] : []),
      };
    });
  }
  return cached;
}

export function profileSummary(id: string): ProfileSummary | null {
  return catalogSummaries().find((summary) => summary.id === id) ?? null;
}

/**
 * Whether a capture surface may offer (show, propose or save) this profile right now: a condition
 * pack (medical_condition / clinician_directive) only while CONDITION_PACKS_ENABLED is on (§4 —
 * off in production until the pack wording is reviewed). Every other profile always.
 */
export function isOfferedProfile(
  summary: Pick<ProfileSummary, "category">, env?: ConditionPacksEnv,
): boolean {
  return !isConditionPackCategory(summary.category) || conditionPacksEnabled(env);
}

/** The catalog a capture surface offers: catalogSummaries() less any gated condition pack. */
export function offeredCatalogSummaries(env?: ConditionPacksEnv): readonly ProfileSummary[] {
  return catalogSummaries().filter((summary) => isOfferedProfile(summary, env));
}

/**
 * R5's per-item confirmation gate, restated for a confirm UI: a `never` item with a
 * `user_confirmed_safety` basis needs its own explicit tap (isActiveHardRule,
 * lib/policy/profiles/types.ts). A `limit`/`sometimes`/`prefer` item inherits the profile's
 * `hardBasis` as metadata (lib/policy/profiles/loader.ts's `templatesFor` — every template of one
 * profile carries the same `hardBasis`) but is never gated by it, so it confirms with a blanket
 * tap like any other non-medical item. Every confirm surface (onboarding's picker, the chat
 * confirm card) calls this rather than re-deriving the rule.
 */
export function isMedicalItem(item: ProfileSummaryItem): boolean {
  return item.strength === "never" && item.hardBasis === "user_confirmed_safety";
}

/**
 * The map's `requires_user_confirmation` semantics (dietary-profiles.draft.json: "true = each hard
 * rule item is confirmed individually by the user before it activates"): an item a confirm UI must
 * show on its own row and confirm with its own tap — every medical item, and every hard rule of an
 * item-level profile (halal's pork, alcohol and blood product each). Only a profile-level profile
 * (a named allergy) and soft items confirm with the blanket tap.
 */
export function needsOwnConfirmation(
  profile: Pick<ProfileSummary, "requiresUserConfirmation">, item: ProfileSummaryItem,
): boolean {
  if (isMedicalItem(item)) return true;
  return profile.requiresUserConfirmation && item.strength === "never" && item.hardBasis !== null;
}

/** A facet's plain label for a confirm row ("blood_product" → "blood product"). */
export function itemLabel(item: Pick<ProfileSummaryItem, "facet">): string {
  return item.facet.replaceAll(/[_:]/g, " ");
}
