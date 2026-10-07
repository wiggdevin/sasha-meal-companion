/**
 * Saved plan content against the account's CURRENT food rules (2026-10-05 calculation audit F1-F3).
 *
 * Pure: runs in resolveDay on the phone and the server. The only authority is the server-verified
 * eligible set the phone already holds (`/api/foods/eligible`, projected by
 * `lib/foods/eligible-client.ts`); this module never re-implements the policy engine. It fails
 * closed: a saved line it cannot tie to a currently verified food is `unknown`, a line whose food
 * is on Avoid or excluded by the server is `blocked`. Nothing is hidden or deleted.
 */
import { SNAPSHOT_MAX_AGE_MS, type MealEvidence } from "@/lib/meals/snapshot";
import type { OpenWorldInputs } from "@/lib/meals/open-world";
import type { Food } from "@/lib/foods";
import { sameBaseName } from "@/lib/foods/base-name";
import { namedRuleMark } from "@/lib/foods/rule-reason";
import { normalizePreferenceFlags } from "@/lib/profile/onboarding-state";
import type { FoodComponent, RuleMark, Settings, SlotOverride } from "@/lib/types";

/** The phone's verified set, stamped with the local rule inputs it was verified against. */
export type VerifiedEligibleSet = ReadonlySet<string> & {
  /** Local food id → why the server did not clear that Eats food. */
  readonly marks: ReadonlyMap<string, RuleMark>;
  /** `foodRulesKey` of the diet flags the SERVER judged under (not the phone's own copy). */
  readonly rulesKey: string;
  /** The rules epoch its request started in (`lib/foods/rules-epoch.ts`). */
  readonly epoch: number;
  /** True once any rule changed after its request started; the set is then never used again. */
  readonly revoked: boolean;
  /**
   * The account's meal snapshot evidence (Phase 17 O2, lib/meals/snapshot.ts) read with this set.
   * Absent: the set came from an older server (v1), so ranking uses curated evidence only.
   * `null`: a snapshot was required and none usable is held; no new suggestion is made.
   */
  readonly meals?: MealEvidence | null;
  /**
   * Phase 18 W8: an open food-world account's admitted pool, taste and search (lib/meals/open-world.ts);
   * absent for a closed account and once the set is revoked.
   */
  readonly open?: OpenWorldInputs;
};

/**
 * The open-world inputs a set carries, or undefined (a closed account, a plain set, a revoked one,
 * or one older than 7 days).
 */
export function openWorldOf(set: ReadonlySet<string> | undefined, now: number = Date.now()): OpenWorldInputs | undefined {
  if (!set || !isVerifiedEligibleSet(set) || set.revoked) return undefined;
  const open = (set as { open?: OpenWorldInputs }).open;
  if (!open) return undefined;
  const age = now - Date.parse(open.computedAt);
  return Number.isFinite(age) && age <= SNAPSHOT_MAX_AGE_MS ? open : undefined;
}

/**
 * The snapshot evidence a set carries; `undefined` for a plain or v1 set. Evidence older than
 * 7 days is `null` on every use (D2), however long the set was held.
 */
export function mealEvidenceOf(set: ReadonlySet<string> | undefined, now: number = Date.now()):
  MealEvidence | null | undefined {
  if (!set || !("meals" in set)) return undefined;
  // A revoked set (rules changed, or held past 7 days) clears no food, so it speaks for none.
  if (isVerifiedEligibleSet(set) && set.revoked) return null;
  const meals = (set as { meals?: MealEvidence | null }).meals;
  if (!meals) return meals;
  const age = now - Date.parse(meals.computedAt);
  return Number.isFinite(age) && age <= SNAPSHOT_MAX_AGE_MS ? meals : null;
}

/** What resolveDay may use right now: current Eats only, plus the server's reasons. */
export type EligibleView = {
  ids: ReadonlySet<string>; marks: ReadonlyMap<string, RuleMark>;
  /** The verified set's rules epoch; absent for an unstamped (server or test) set. */
  epoch?: number;
  /** The verified set's diet-flags key; absent for an unstamped set. */
  rulesKey?: string;
};

export function isVerifiedEligibleSet(set: ReadonlySet<string>): set is VerifiedEligibleSet {
  return "rulesKey" in set && "marks" in set && "revoked" in set && "epoch" in set;
}

/**
 * The rule inputs the phone holds locally beyond its Food rows: the diet flags, normalized the way
 * the server reads them. A set is stamped with the flags the SERVER judged under, so a refetch
 * answered before a flag change reached the server never matches the phone's new flags.
 *
 * Allergens, banned categories, conditions, custom rules and profile hard rules are not held on the
 * phone; their watermark is the rules epoch instead (`lib/foods/rules-epoch.ts`): every direct rule
 * write (success or conflict) and every constraint revision the phone sees move it, and a set from
 * an older epoch is revoked. Food status is not part of either: the view below drops a food no
 * longer on Eats at once, so a local Avoid mark never waits for a refresh.
 */
export function foodRulesKey(settings: Pick<Settings, "dietPrefs">): string {
  const raw = (settings.dietPrefs?.flags ?? []).filter((flag) => typeof flag === "string");
  return JSON.stringify({ flags: [...normalizePreferenceFlags(raw)].sort() });
}

/**
 * The usable view of a verified set: `undefined` (fail closed) when the set is missing, revoked or
 * stamped under other rules; otherwise only foods that are still on Eats here and now.
 */
export function currentEligibleView(foods: Record<string, Food>, settings: Pick<Settings, "dietPrefs">,
  set: ReadonlySet<string> | undefined): EligibleView | undefined {
  if (!set) return undefined;
  if (isVerifiedEligibleSet(set) && (set.revoked || set.rulesKey !== foodRulesKey(settings))) {
    return undefined;
  }
  const ids = new Set([...set].filter((id) => foods[id]?.status === "eats"));
  return isVerifiedEligibleSet(set) ? { ids, marks: set.marks, epoch: set.epoch, rulesKey: set.rulesKey }
    : { ids, marks: new Map() };
}

/**
 * One saved line. Blocked beats unknown beats clear; a line with no checked food is unknown.
 *
 * `admitted` (Phase 18 W8): an open account's current admitted pool (`livePool`). A line that names
 * none of the account's own foods is clear when its name is EXACTLY an admitted pool food's (a
 * universe item the server admitted under the current token); an Avoid match decides first.
 */
export function componentRuleMark(component: Pick<FoodComponent, "name">,
  foods: Record<string, Food>, view: EligibleView | undefined, admitted?: readonly Food[]): RuleMark | null {
  const name = component.name.trim() || "This food";
  const matches = Object.values(foods).filter((food) => sameBaseName(food.name, component.name));
  if (matches.some((food) => food.status === "avoid")) {
    return { verdict: "blocked", reason: `${name} is on your Avoid list.` };
  }
  if (!view) {
    return { verdict: "unknown", reason: `${name} has not been checked against your current food rules.` };
  }
  const serverMarks = matches.map((food) => view.marks.get(food.id))
    .filter((mark): mark is RuleMark => mark !== undefined);
  const blocked = serverMarks.find((mark) => mark.verdict === "blocked");
  if (blocked) return namedRuleMark(name, blocked);
  const unknown = serverMarks.find((mark) => mark.verdict === "unknown");
  if (unknown) return namedRuleMark(name, unknown);
  // Clear only when every Eats food sharing the name is verified: a same-name sibling the server
  // never cleared keeps the line unknown (fail closed).
  const eats = matches.filter((food) => food.status === "eats");
  if (eats.length > 0 && eats.every((food) => view.ids.has(food.id))) return null;
  // Exact name only: a base-name match would clear "Shrimp, breaded" on an admitted "Shrimp, cooked".
  const exact = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  if (matches.length === 0 && admitted?.some((food) => exact(food.name) === exact(component.name))) return null;
  return matches.length === 0
    ? { verdict: "unknown", reason: `${name} is not in your foods, so it cannot be checked against your rules.` }
    : { verdict: "unknown", reason: `${name} has not been verified against your current food rules.` };
}

/** The slot's mark: its first blocked line, else its first unknown line, else clear. */
export function worstRuleMark(marks: readonly (RuleMark | null)[]): RuleMark | null {
  return marks.find((mark) => mark?.verdict === "blocked")
    ?? marks.find((mark) => mark?.verdict === "unknown") ?? null;
}

export const RECIPE_RECHECK = "Checking against your updated food rules.";
export const RECIPE_UNCHECKED = "This recipe has not been checked against your current food rules.";

/**
 * An ingredient name the account's own foods mark right now: a local Avoid row or a server block
 * (blocked), or a same-name Eats food the server marked unknown or never cleared (unknown, round 3
 * WARN 2). An ingredient the account has no food for is left to the server's verdict.
 */
function liveIngredientMark(name: string, foods: Record<string, Food>,
  view: EligibleView | undefined): RuleMark | null {
  const label = name.trim() || "An ingredient";
  const matches = Object.values(foods).filter((food) => sameBaseName(food.name, name));
  if (matches.some((food) => food.status === "avoid")) {
    return { verdict: "blocked", reason: `${label} is on your Avoid list.` };
  }
  const marks = view ? matches.map((food) => view.marks.get(food.id)) : [];
  const blocked = marks.find((mark) => mark?.verdict === "blocked");
  if (blocked) return namedRuleMark(label, blocked);
  const unknown = marks.find((mark) => mark?.verdict === "unknown");
  if (unknown) return namedRuleMark(label, unknown);
  const unverified = view && matches.some((food) => food.status === "eats" && !view.ids.has(food.id));
  return unverified
    ? { verdict: "unknown", reason: `${label} has not been verified against your current food rules.` }
    : null;
}

/**
 * An accepted recipe on a slot (F2, review round 2). Never judged by its title.
 *
 * 1. Its ingredients against the account's foods as they stand NOW: an ingredient put on Avoid (an
 *    outbox write that moves no rules epoch) blocks the recipe at once, exactly as it blocks a
 *    saved food line.
 * 2. Otherwise the server's verdict, counted only when it was fetched in the same rules epoch as
 *    the current verified view. No verdict, no ingredient list, no view, an unstamped view or
 *    another epoch is unknown: never a pass.
 */
export function recipeRuleMark(override: Pick<SlotOverride, "ruleMark" | "ruleMarkEpoch"
  | "ruleMarkRulesKey" | "ruleIngredients">, foods: Record<string, Food>,
view: EligibleView | undefined): RuleMark | null {
  // An empty list names nothing to check: the same as no list (round 3 NOTE 7).
  const ingredients = Array.isArray(override.ruleIngredients) && override.ruleIngredients.length > 0
    ? override.ruleIngredients : null;
  const live = (ingredients ?? []).map((name) => liveIngredientMark(name, foods, view));
  const blocked = live.find((mark) => mark?.verdict === "blocked");
  if (blocked) return blocked;
  if (override.ruleMark === undefined || ingredients === null) {
    return { verdict: "unknown", reason: RECIPE_UNCHECKED };
  }
  // The verdict counts only in the view's rules epoch AND under the diet flags that view was
  // verified with (which currentEligibleView already matched to the phone's own): a clear
  // fetched before a diet change is never a pass (round 3 BLOCK).
  if (!view || view.epoch === undefined || override.ruleMarkEpoch !== view.epoch
    || view.rulesKey === undefined || override.ruleMarkRulesKey !== view.rulesKey) {
    return { verdict: "unknown", reason: RECIPE_RECHECK };
  }
  if (override.ruleMark?.verdict === "blocked") return override.ruleMark;
  return live.find((mark) => mark !== null) ?? override.ruleMark;
}
