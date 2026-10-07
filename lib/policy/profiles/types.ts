/**
 * Phase 13 §9 R5: the typed rule model a profile import must exist behind, before the JSON
 * (docs/research/dietary-profiles.draft.json) is ever read into policy. Pure: no I/O.
 */
import { insideAnyWindow, type ActiveWindow, type TimeWindowKind }
  from "@/lib/policy/profiles/time-windows";

export const RULE_STRENGTHS = ["never", "avoid", "limit", "sometimes", "prefer"] as const;
export type RuleStrength = (typeof RULE_STRENGTHS)[number];

/**
 * The only bases a "never" rule item may block on (map §0/§4): a diagnosis alone is never one
 * of them. `null` marks a soft item (limit/sometimes/prefer, or an unconfirmed medical item).
 */
export const HARD_BASES = ["allergy", "celiac", "religious", "user_rule", "user_confirmed_safety"] as const;
export type HardBasis = (typeof HARD_BASES)[number];

export const EVIDENCE_STRENGTHS = [
  "regulatory", "strong", "moderate", "limited", "insufficient", "expert_opinion",
  "religious_rule", "user_rule",
] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

/**
 * Per-item confirmation (§9 R5): a `user_confirmed_safety` or other hard item only blocks once
 * the user has confirmed that exact item, one at a time — never the whole profile at once.
 */
export const CONFIRMATION_STATES = ["unconfirmed", "confirmed", "declined"] as const;
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

export const RULE_CONTEXTS = ["eating_out", "family_meals", "holidays", "travel"] as const;
export type RuleContext = (typeof RULE_CONTEXTS)[number];

export type Budget = { count: number; per: "meal" | "day" | "week" };

/** A branded id: `<profileId>::<facet>`, unique within one profile instance. */
export type RuleId = string & { readonly __brand: "ProfileRuleId" };

export function ruleId(profileId: string, facet: string): RuleId {
  return `${profileId}::${facet}` as RuleId;
}

export function parseRuleId(id: RuleId): { profileId: string; facet: string } | null {
  const at = id.indexOf("::");
  if (at < 0) return null;
  return { profileId: id.slice(0, at), facet: id.slice(at + 2) };
}

/**
 * One typed rule item (§9 R5): the id, its confirmation and evidence state, an optional expiry
 * and the target modifiers the map's JSON carried as prose. `facet` is a Facet, a NewFacet, or
 * the `contains_allergen:<name>` template — never validated here (lib/policy/profiles/schema.ts
 * owns reference resolution).
 */
export type RuleItem = {
  id: RuleId;
  profileId: string;
  facet: string;
  strength: RuleStrength;
  hardBasis: HardBasis | null;
  evidenceStrength: EvidenceStrength | null;
  confirmation: ConfirmationState;
  /** ISO date-time; null means the item never expires on its own. */
  expiresAt: string | null;
  budget?: Budget;
  context?: readonly RuleContext[];
  /** The map's per-profile `target_modifiers`, carried through untyped (drug timing, etc.). */
  targetModifiers?: Readonly<Record<string, unknown>>;
  /** The profile's typed `time_window` (lib/policy/profiles/time-windows.ts); unset is "none". */
  window?: TimeWindowKind;
  /** A `calendar` item's own dated spans, from the user: outside all of them it never blocks. */
  activeWindows?: readonly ActiveWindow[];
};

export type ProfileSource = "user_stated" | "clinician_directed_per_user" | "coach_suggested_confirmed";

/**
 * One confirmed profile, ready for policy: `evaluatePolicy` reads only `rules` whose
 * `confirmation` is "confirmed" and whose `hardBasis` is set (§4's hard-block floor); `rankFoods`
 * reads every rule regardless of confirmation for soft ranking (map §7.2 — ranking never blocks).
 */
export type ProfileInstance = {
  profileId: string;
  source: ProfileSource;
  /** Required before any rule in this instance can have an effect (R5). */
  confirmedAt: string;
  rules: readonly RuleItem[];
  options: Readonly<Record<string, boolean>>;
  /** The exact drug or formulation the user takes, for a medication profile whose guidance is
   *  per product (§9 R6: lib/policy/profiles/drug-interactions.ts). Unset stays unverified. */
  drug?: string;
  notes?: string;
};

/** A rule item that may legally block: confirmed, and grounded in one of the permitted bases. */
export function isActiveHardRule(item: RuleItem, now: Date): boolean {
  if (item.strength !== "never") return false;
  if (item.hardBasis === null) return false;
  if (item.confirmation !== "confirmed") return false;
  if (item.expiresAt !== null && Date.parse(item.expiresAt) <= now.getTime()) return false;
  if (item.window === "calendar" && !insideAnyWindow(item.activeWindows, now)) return false;
  return true;
}
