/**
 * Shopping and pantry lines judged against the account's CURRENT food rules on every read
 * (2026-10-05 calc audit F4). A line is never hidden, refused or deleted for a rule: it carries a
 * `ruleMark` in every shopping route's JSON for the list to show beside it (rendering it is the UI
 * lane's job), the same marks-never-refuses ruling logging follows
 * (docs/decisions/2026-09-14-logging-marks-never-refuses.md).
 *
 * Two kinds of line:
 *
 * - A line with a food ref (`identity.foodRefId`) is judged by `evaluatePolicy` on the evidence
 *   the eligible-foods path loads (lib/coach/suggest-policy.ts loadSuggestionEvidence): blocked →
 *   "blocked", unverified → "unknown", allowed → null.
 * - A line with no food ref (a typed manual line, or a bundled `foodDbId`-only identity) has only
 *   its text. It is "blocked" when that text itself matches a current rule — a same-name Avoid
 *   entry or an Avoid-listed bundled food, an allergen named in it ("peanut butter"), a custom
 *   ingredient rule, a banned category the name implies. Otherwise it is "unknown" when the Avoid
 *   list or the profile failed to read (an unread rule may name it; t18 r2), and null only when
 *   both were read and nothing matched. Missing food evidence alone never makes it "unknown": the
 *   text carries no evidence that evidence could clear.
 *
 * An account with no food rules at all gets null on every line. Each input fails on its own, and
 * a failure is never read as "no rules" (the read itself always still succeeds):
 *
 * - A line with a food ref whose evidence read returned nothing for its (ref, revision) is
 *   "unknown" ("We couldn't check …"), unless its own text already shows a block.
 * - A line with a food ref is "unknown" whenever any input could not be read: the constraint
 *   profile, the complete Avoid list, or the food evidence (which also carries the account's
 *   preference flags). A failed read is not proof that nothing applies.
 * - A line without one is matched by its text against whatever rules were read (blocked or null).
 *   With no rules readable at all it is null: there is nothing its text could match.
 *
 * Pure. No I/O.
 */
import { policyCategoriesFor } from "@/lib/catalog/category-map";
import type { SuggestionFoodEvidence } from "@/lib/coach/suggest-policy";
import { FOOD_DB } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import {
  EMPTY_PROFILE, evaluatePolicy, type ConstraintProfile, type PolicyVerdict,
} from "@/lib/policy/constraints";
import { reasonFragment } from "@/lib/policy/reason-words";
import { unknownAllergenFragment } from "@/lib/policy/held-allergens";
import type { RuleMark } from "@/lib/types";
import type { IngredientIdentity } from "./types";

export type ShoppingAvoid = {
  refIds: ReadonlySet<string>;
  /** Base names (lib/foods/base-name.ts). */
  names: ReadonlySet<string>;
  foodDbIds: ReadonlySet<string>;
};
export type ShoppingEvidence =
  | { status: "unavailable" }
  | { status: "ready"; preferenceFlags: readonly PolicyPreferenceFlag[];
    /** Keyed by `evidenceKey(foodRefId, pinned revision)`, so each pin is judged on its own. */
    facts: ReadonlyMap<string, SuggestionFoodEvidence> };
export type ShoppingRuleContext = {
  /** null: the constraint profile could not be read. */
  profile: ConstraintProfile | null;
  /** null: the complete Avoid list could not be read. */
  avoid: ShoppingAvoid | null;
  evidence: ShoppingEvidence;
};

export const UNAVAILABLE_CONTEXT: ShoppingRuleContext = {
  profile: null, avoid: null, evidence: { status: "unavailable" },
};

export type MarkableItem = { name: string; identity: IngredientIdentity | null };

const FOOD_DB_BY_ID = new Map(FOOD_DB.map((food) => [food.id, food]));
const NO_AVOID: ShoppingAvoid = { refIds: new Set(), names: new Set(), foodDbIds: new Set() };

export function evidenceKey(foodRefId: string, catalogFoodRevisionId: number | null | undefined): string {
  return `${foodRefId}:${catalogFoodRevisionId ?? ""}`;
}

/** Whether any rule that WAS read could mark anything. Only meaningful beside the read states. */
export function hasActiveRules(profile: ConstraintProfile, avoid: ShoppingAvoid,
  preferenceFlags: readonly PolicyPreferenceFlag[]): boolean {
  return profile.avoid_allergens.length > 0 || profile.banned_categories.length > 0
    || profile.avoid_food_ref_ids.length > 0
    || (profile.custom_rules?.length ?? 0) > 0 || (profile.conditions?.length ?? 0) > 0
    || (profile.profileRules?.items?.length ?? 0) > 0
    || preferenceFlags.length > 0
    || avoid.refIds.size > 0 || avoid.names.size > 0 || avoid.foodDbIds.size > 0;
}

export function shoppingRuleMark(item: MarkableItem, context: ShoppingRuleContext): RuleMark | null {
  const name = displayName(item.name);
  const foodRefId = item.identity?.foodRefId ?? null;
  const foodDbId = item.identity?.foodDbId ?? null;
  const { evidence } = context;
  const profile = context.profile ?? EMPTY_PROFILE;
  const avoid = context.avoid ?? NO_AVOID;
  const preferenceFlags = evidence.status === "ready" ? evidence.preferenceFlags : [];
  const onAvoidByName = avoid.names.has(baseFoodName(item.name))
    || (foodDbId !== null && avoid.foodDbIds.has(foodDbId))
    || (foodRefId !== null && avoid.refIds.has(foodRefId));

  if (foodRefId === null) {
    // A no-ref line is judged by its text against what was read. A block it shows stands; with
    // the Avoid list or the profile unread, anything else is unproven, never clear (t18 r2).
    return textMark(name, item.name, foodDbId, onAvoidByName, profile, avoid, preferenceFlags)
      ?? (context.profile === null || context.avoid === null ? unavailable(name) : null);
  }

  // Any unread input leaves a referenced food unproven, whatever else is in hand.
  if (context.profile === null || context.avoid === null || evidence.status !== "ready") {
    return unavailable(name);
  }
  if (!hasActiveRules(profile, avoid, preferenceFlags)) return null;
  const facts = evidence.facts.get(evidenceKey(foodRefId, item.identity?.catalogFoodRevisionId));
  if (!facts) {
    // The read succeeded but returned nothing for this pin: a block the text already shows
    // stands, anything else is unproven.
    return textMark(name, item.name, foodDbId, onAvoidByName, profile, avoid, preferenceFlags)
      ?? unchecked(name);
  }
  const verdict = evaluatePolicy(profile, {
    foodRefId,
    allergenTags: facts.allergenTags,
    allergenEvidence: facts.allergenEvidence ?? {},
    checkedAllergens: facts.checkedAllergens ?? [],
    ingredientsText: facts.ingredientsText ?? null,
    ingredientsTextIsLabel: facts.ingredientsTextIsLabel,
    foodName: facts.foodName ?? item.name,
    foodBrand: facts.foodBrand ?? null,
    packaged: facts.packaged,
    category: facts.policyCategories,
    onEatsList: facts.onEatsList === true,
    // The resolved food's own name counts too: a line labelled differently is still that food.
    onAvoidList: facts.onAvoidList === true || onAvoidByName
      || (facts.foodName != null && avoid.names.has(baseFoodName(facts.foodName))),
    preferenceFlags,
    facets: facts.facets ?? {}, attestedFacets: facts.attestedFacets,
    facetAction: "exclude",
    profileRules: profile.profileRules,
  });
  if (verdict.verdict === "blocked") return { verdict: "blocked", reason: blockedWords(name, verdict) };
  if (verdict.verdict === "unverified") return { verdict: "unknown", reason: unknownWords(name, verdict) };
  return null;
}

/** A line's own text against the rules in hand: blocked or null, never unknown. */
function textMark(name: string, text: string, foodDbId: string | null, onAvoidByName: boolean,
  profile: ConstraintProfile, avoid: ShoppingAvoid,
  preferenceFlags: readonly PolicyPreferenceFlag[]): RuleMark | null {
  if (!hasActiveRules(profile, avoid, preferenceFlags)) return null;
  // `category: null` lets the engine derive banned categories from the name itself.
  const verdict = evaluatePolicy(profile, {
    foodRefId: null, allergenTags: null, category: bundledCategories(foodDbId),
    onEatsList: false, onAvoidList: onAvoidByName, foodName: text,
    preferenceFlags, facetAction: "exclude",
  });
  return verdict.verdict === "blocked"
    ? { verdict: "blocked", reason: blockedWords(name, verdict) } : null;
}

/** Each item with its mark; the input order and every other field are kept. Never throws. */
export function withShoppingRuleMarks<T extends MarkableItem>(items: readonly T[],
  context: ShoppingRuleContext): (T & { ruleMark: RuleMark | null })[] {
  return items.map((item) => {
    let ruleMark: RuleMark | null;
    try {
      ruleMark = shoppingRuleMark(item, context);
    } catch {
      ruleMark = fallbackMark(item, context);
    }
    try {
      return { ...item, ruleMark };
    } catch {
      // A row whose own fields cannot be copied still leaves with its mark, not as an error.
      return { ruleMark } as T & { ruleMark: RuleMark | null };
    }
  });
}

/**
 * A malformed stored line must not fail the whole read: a referenced one fails closed, and a
 * typed one is still matched by its bare text where that can be read.
 */
function fallbackMark(item: unknown, context: ShoppingRuleContext): RuleMark | null {
  if (hasFoodRef(item)) return unavailable("This item");
  try {
    const text = (item as MarkableItem).name;
    if (typeof text !== "string") return null;
    const avoid = context.avoid ?? NO_AVOID;
    const flags = context.evidence.status === "ready" ? context.evidence.preferenceFlags : [];
    return textMark(displayName(text), text, null, avoid.names.has(baseFoodName(text)),
      context.profile ?? EMPTY_PROFILE, avoid, flags);
  } catch {
    return null;
  }
}

function hasFoodRef(item: unknown): boolean {
  try {
    return Boolean((item as MarkableItem | null)?.identity?.foodRefId);
  } catch {
    return true;
  }
}

function displayName(value: unknown): string {
  return (typeof value === "string" ? value.trim() : "") || "This item";
}

function bundledCategories(foodDbId: string | null): string[] | null {
  const food = foodDbId ? FOOD_DB_BY_ID.get(foodDbId) : undefined;
  if (!food || food.sr.startsWith("label:")) return null;
  return policyCategoriesFor({ description: food.sr, category: food.category });
}

function blockedWords(name: string, verdict: PolicyVerdict): string {
  return `${name} ${reasonFragment(verdict.reason)}`;
}

function unknownWords(name: string, verdict: PolicyVerdict): string {
  const allergens = unknownAllergenFragment(verdict.allergens ?? []);
  return allergens ? `${name} ${allergens}`
    : `${name} cannot be checked against your current food rules.`;
}

function unchecked(name: string): RuleMark {
  return { verdict: "unknown", reason: `We couldn't check ${name} against your food rules.` };
}

function unavailable(name: string): RuleMark {
  return { verdict: "unknown",
    reason: `${name} could not be checked against your current food rules right now.` };
}
