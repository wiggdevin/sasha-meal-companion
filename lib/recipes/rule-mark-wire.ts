import { ruleMarkFromWire } from "@/lib/foods/rule-mark-wire";
import type { RuleMark } from "@/lib/types";

/** A planning answer whose verdict is missing or unreadable: never a pass. */
export const RECIPE_WIRE_UNCHECKED = "We couldn't check this recipe against your food rules.";

/**
 * A planning route's recipe verdict at the response boundary (GET /api/recipes, GET
 * /api/recipes/[id], the preview POST, the accept POST's `selection`). Only an explicit
 * `ruleMark: null` is clear; a well-formed mark is shown as sent; a missing key or a malformed value
 * is unknown, never a pass.
 */
export function recipeRuleMarkFromWire(owner: unknown): RuleMark | null {
  const value = owner && typeof owner === "object" && "ruleMark" in owner
    ? (owner as { ruleMark: unknown }).ruleMark : undefined;
  if (value === null) return null;
  return ruleMarkFromWire(value) ?? { verdict: "unknown", reason: RECIPE_WIRE_UNCHECKED };
}

/** The same object with its `ruleMark` parsed; nothing else is touched. */
export function withRecipeRuleMark<T extends object>(owner: T): T & { ruleMark: RuleMark | null } {
  return { ...owner, ruleMark: recipeRuleMarkFromWire(owner) };
}

/**
 * The preview's 422 `recipe_rules_unchecked`: the rules could not be read, so no proof was stored.
 * Its message is the mark's sentence; `ruleMark` is always an unknown mark (parsed, else the
 * generic one), so a surface can say "Check" rather than call it a failure.
 */
export class RecipeRulesUncheckedError extends Error {
  constructor(message: string, readonly ruleMark: RuleMark) {
    super(message);
    this.name = "RecipeRulesUncheckedError";
  }
}

/** The unknown mark a failed preview carried when its rules were unread; null for any other failure. */
export function rulesUncheckedMark(cause: unknown): RuleMark | null {
  return cause instanceof RecipeRulesUncheckedError ? cause.ruleMark : null;
}
