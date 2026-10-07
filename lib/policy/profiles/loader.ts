/**
 * Phase 13 §9 R5: turns one validated `RawProfile` (lib/policy/profiles/schema.ts) into typed
 * `RuleItem`s and a confirmed `ProfileInstance` — the step that must exist, with typed rule ids,
 * per-item confirmation state, evidence state, expiry and target modifiers, before a profile's
 * JSON data can have any policy effect. Pure: no I/O, no Jev call.
 */
import type { RawProfile } from "@/lib/policy/profiles/schema";
import { timeWindowKind, type ActiveWindow, type TimeWindowKind }
  from "@/lib/policy/profiles/time-windows";
import {
  ruleId, type EvidenceStrength, type HardBasis, type ProfileInstance, type ProfileSource,
  type RuleContext, type RuleItem, type RuleStrength,
} from "@/lib/policy/profiles/types";

export type RuleTemplate = Omit<RuleItem, "confirmation">;

/** One profile's rule templates, built once from its JSON row. Every hard/soft/prefer facet
 *  becomes exactly one template; none are confirmed yet (§9 R5 — import alone confirms nothing). */
export type ProfileDefinition = {
  id: string;
  label: string;
  category: string;
  hardBasis: HardBasis | null;
  requiresUserConfirmation: boolean;
  evidenceStrength: EvidenceStrength;
  /** The typed `time_window` every template carries (lib/policy/profiles/time-windows.ts). */
  timeWindow: TimeWindowKind;
  templates: readonly RuleTemplate[];
};

/** The map's `flex_model.exceptions[].strength` uses "allowed_in_budget", not one of the five
 *  canonical rule strengths (enums.rule_strength) — prose the JSON never reconciled with its own
 *  enum. Normalized to "sometimes" (§9 R5: prose becomes a typed rule, not left as free text). */
function normalizedExceptionStrength(raw: string): RuleStrength {
  return raw === "allowed_in_budget" ? "sometimes" : (raw as RuleStrength);
}

function templatesFor(profile: RawProfile, window: TimeWindowKind): RuleTemplate[] {
  const templates: RuleTemplate[] = [];
  const push = (facet: string, strength: RuleStrength) => templates.push({
    id: ruleId(profile.id, facet),
    profileId: profile.id,
    facet,
    strength,
    hardBasis: profile.hard_basis,
    evidenceStrength: profile.evidence.strength,
    expiresAt: null,
    targetModifiers: profile.target_modifiers,
    window,
  });
  for (const facet of profile.hard_avoid_facets) push(facet, "never");
  for (const facet of profile.soft_limit_facets) push(facet, "limit");
  for (const facet of profile.prefer_facets) push(facet, "prefer");

  const flex = profile.flex_model;
  if (flex?.base && typeof flex.base.facet === "string") {
    const strength = typeof flex.base.strength === "string"
      ? normalizedExceptionStrength(flex.base.strength) : "limit";
    if (!templates.some((t) => t.facet === flex.base!.facet)) push(flex.base.facet, strength);
  }
  for (const exception of flex?.exceptions ?? []) {
    if (templates.some((t) => t.facet === exception.facet)) continue;
    templates.push({
      id: ruleId(profile.id, exception.facet),
      profileId: profile.id,
      facet: exception.facet,
      strength: normalizedExceptionStrength(exception.strength),
      hardBasis: null,
      evidenceStrength: profile.evidence.strength,
      expiresAt: null,
      targetModifiers: profile.target_modifiers,
      window,
    });
  }
  return templates;
}

/** Throws on a `time_window` the typed table does not classify (§9 R5: no prose left behind). */
export function profileDefinitionFrom(profile: RawProfile): ProfileDefinition {
  const timeWindow = timeWindowKind(profile);
  return {
    id: profile.id,
    label: profile.label,
    category: profile.category,
    hardBasis: profile.hard_basis,
    requiresUserConfirmation: profile.requires_user_confirmation,
    evidenceStrength: profile.evidence.strength,
    timeWindow,
    templates: templatesFor(profile, timeWindow),
  };
}

export function loadProfileCatalog(profiles: readonly RawProfile[]): Map<string, ProfileDefinition> {
  return new Map(profiles.map((profile) => [profile.id, profileDefinitionFrom(profile)]));
}

export type RuleItemConfirmation = {
  facet: string;
  confirmed: boolean;
  /** Overrides the template's expiry/budget/context; unset keeps the template's own. */
  expiresAt?: string | null;
  budget?: RuleItem["budget"];
  context?: readonly RuleContext[];
  /** A `calendar` item's own dated spans (lib/policy/profiles/time-windows.ts). */
  activeWindows?: readonly ActiveWindow[];
};

/** A windowed hard item confirms only once its window was answered: a `calendar` item needs the
 *  user's own dates, an `expiry` item needs its end date asked (a date, or an explicit null). */
function windowAnswered(template: RuleTemplate, override: RuleItemConfirmation | undefined): boolean {
  if (template.window === "calendar") return (override?.activeWindows?.length ?? 0) > 0;
  if (template.window === "expiry") return override?.expiresAt !== undefined;
  return true;
}

/**
 * Builds a confirmed `ProfileInstance` from a definition and the user's own per-item decisions.
 * A hard ("never") item with a permitted basis stays "unconfirmed" — and so inert to
 * `evaluatePolicy` (`isActiveHardRule`) — unless its own facet is named in `confirmations`
 * (§9 R5: the whole profile's `requires_user_confirmation` never substitutes for one hard item's
 * own confirmation). A soft item (limit/sometimes/prefer) confirms with the profile itself, since
 * ranking never blocks (map §7.2) — nothing here can hurt a user who never saw the item.
 */
export function buildProfileInstance(
  definition: ProfileDefinition,
  params: { source: ProfileSource; confirmedAt: string; confirmations?: readonly RuleItemConfirmation[];
    options?: Readonly<Record<string, boolean>>; drug?: string; notes?: string },
): ProfileInstance {
  const byFacet = new Map((params.confirmations ?? []).map((c) => [c.facet, c]));
  const rules: RuleItem[] = definition.templates.map((template) => {
    const override = byFacet.get(template.facet);
    const isHard = template.strength === "never" && template.hardBasis !== null;
    const confirmed = isHard
      ? override?.confirmed === true && windowAnswered(template, override)
      : override?.confirmed !== false;
    return {
      ...template,
      confirmation: confirmed ? "confirmed" : (isHard && override?.confirmed === false ? "declined" : "unconfirmed"),
      ...(override?.expiresAt !== undefined ? { expiresAt: override.expiresAt } : {}),
      ...(override?.budget !== undefined ? { budget: override.budget } : {}),
      ...(override?.context !== undefined ? { context: override.context } : {}),
      ...(override?.activeWindows !== undefined ? { activeWindows: override.activeWindows } : {}),
    };
  });
  return {
    profileId: definition.id,
    source: params.source,
    confirmedAt: params.confirmedAt,
    rules,
    options: params.options ?? {},
    ...(params.drug !== undefined ? { drug: params.drug } : {}),
    ...(params.notes !== undefined ? { notes: params.notes } : {}),
  };
}
