/**
 * Recipe rule marks at the response boundary (2026-10-05, fix/ui-gap-contracts): every planning
 * route's `ruleMark` is parsed once in the client so each surface reads one shape. A well-formed
 * mark is kept as sent, only an explicit `null` is clear, and a malformed value or a missing key is
 * unknown ("We couldn't check this recipe against your food rules."), never a pass. The preview's 422 `recipe_rules_unchecked` becomes a
 * typed error carrying its unknown mark; any other 422 stays a plain message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import { getCatalogRecipe, searchCatalogRecipes } from "@/lib/recipe-catalog-client";
import { acceptRecipePlan, previewRecipePlan, RecipeRulesUncheckedError } from "@/lib/recipe-plan-client";
import { recipeRuleMarkFromWire, rulesUncheckedMark } from "@/lib/recipes/rule-mark-wire";
import { RECIPE_WIRE_UNCHECKED } from "@/lib/recipes/rule-mark-wire";
import type { RuleMark } from "@/lib/types";
import { foodRulesKey } from "@/lib/foods/rule-marks";
import { judgedRulesKey, UNJUDGED_RECIPE_RULES } from "@/lib/recipes/recipe-freshness";

const BLOCKED: RuleMark = { verdict: "blocked", reason: "Peanut sauce has peanut, which your rules exclude." };
const UNKNOWN: RuleMark = { verdict: "unknown", reason: "This recipe could not be checked against your current food rules." };
const UNCHECKED: RuleMark = { verdict: "unknown", reason: RECIPE_WIRE_UNCHECKED };

function answer(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
}

beforeEach(async () => { await resetTestAccount(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("recipeRuleMarkFromWire", () => {
  it("keeps blocked and unknown, reads only null as clear, and a malformed value or missing key as unknown", () => {
    expect(recipeRuleMarkFromWire({ ruleMark: BLOCKED })).toEqual(BLOCKED);
    expect(recipeRuleMarkFromWire({ ruleMark: UNKNOWN })).toEqual(UNKNOWN);
    expect(recipeRuleMarkFromWire({ ruleMark: null })).toBeNull();
    for (const bad of ["blocked", { verdict: "allowed", reason: "x" }, { verdict: "blocked", reason: "" }, 7]) {
      expect(recipeRuleMarkFromWire({ ruleMark: bad })).toEqual(UNCHECKED);
    }
    expect(recipeRuleMarkFromWire({})).toEqual(UNCHECKED);
    expect(rulesUncheckedMark(new Error("x"))).toBeNull();
    expect(rulesUncheckedMark(new RecipeRulesUncheckedError("m", UNKNOWN))).toEqual(UNKNOWN);
  });
});

describe("the recipe clients", () => {
  it("parses every searched recipe's mark", async () => {
    answer({ count: 5, limitations: [], rulesFingerprint: null, recipes: [
      { recipeId: "a", ruleMark: BLOCKED }, { recipeId: "b", ruleMark: UNKNOWN }, { recipeId: "c", ruleMark: null },
      { recipeId: "d", ruleMark: { verdict: "maybe" } }, { recipeId: "e" }] });
    const result = await searchCatalogRecipes({ query: "" }, new AbortController().signal);
    expect(result.recipes.map((recipe) => recipe.ruleMark)).toEqual([BLOCKED, UNKNOWN, null, UNCHECKED, UNCHECKED]);
    // No ruleFlags, and a null fingerprint: judged under nothing the phone can trust.
    expect(result.recipes.every((recipe) => recipe.ruleMarkRulesKey === UNJUDGED_RECIPE_RULES)).toBe(true);
  });

  it("stamps each recipe with the rules the server judged it under", async () => {
    answer({ count: 1, limitations: [], rulesFingerprint: "f", ruleFlags: ["vegan"], recipes: [{ recipeId: "a", ruleMark: null }] });
    const [found] = (await searchCatalogRecipes({ query: "" }, new AbortController().signal)).recipes;
    expect(found.ruleMarkRulesKey).toBe(foodRulesKey({ dietPrefs: { flags: ["vegan"] } }));
    answer({ recipeId: "a", ruleMark: null, ruleFlags: [] });
    expect((await getCatalogRecipe("a")).ruleMarkRulesKey).toBe(foodRulesKey({ dietPrefs: { flags: [] } }));
    answer({ recipeId: "a", ruleMark: UNKNOWN });
    expect((await getCatalogRecipe("a")).ruleMarkRulesKey).toBe(UNJUDGED_RECIPE_RULES);
    expect(judgedRulesKey({ ruleFlags: ["vegan"], rulesFingerprint: null })).toBe(UNJUDGED_RECIPE_RULES);
  });

  it("parses a single recipe's mark", async () => {
    answer({ recipeId: "a", ruleMark: { verdict: "blocked", reason: 4 }, ruleFlags: [] });
    expect((await getCatalogRecipe("a")).ruleMark).toEqual(UNCHECKED);
    answer({ recipeId: "a", ruleMark: BLOCKED, ruleFlags: [] });
    expect((await getCatalogRecipe("a")).ruleMark).toEqual(BLOCKED);
  });

  it("parses the preview's and the accepted selection's marks", async () => {
    answer({ previewId: "p", ruleMark: UNKNOWN, ruleFlags: [] });
    expect((await previewRecipePlan("r", "2026-10-05", "meal-1")).ruleMark).toEqual(UNKNOWN);
    answer({ previewId: "p", ruleMark: "nope" });
    expect((await previewRecipePlan("r", "2026-10-05", "meal-1")).ruleMark).toEqual(UNCHECKED);
    answer({ previewId: "p" });
    expect((await previewRecipePlan("r", "2026-10-05", "meal-1")).ruleMark).toEqual(UNCHECKED);
    answer({ selection: { id: "s", ruleMark: BLOCKED }, ruleFlags: [] });
    expect((await acceptRecipePlan("r", "p", "q", false)).ruleMark).toEqual(BLOCKED);
    answer({ selection: { id: "s", ruleMark: null } });
    expect((await acceptRecipePlan("r", "p", "q", false)).ruleMark).toBeNull();
  });

  it("turns the 422 unchecked answer into a typed error with its unknown mark", async () => {
    answer({ error: "recipe_rules_unchecked", message: UNKNOWN.reason, ruleMark: UNKNOWN }, 422);
    const error = await previewRecipePlan("r", "2026-10-05", "meal-1").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RecipeRulesUncheckedError);
    expect((error as Error).message).toBe(UNKNOWN.reason);
    expect(rulesUncheckedMark(error)).toEqual(UNKNOWN);
    // A malformed (or blocked) mark on that answer still leaves an unknown one with its message.
    answer({ error: "recipe_rules_unchecked", message: "Rules could not be read.", ruleMark: { verdict: "x" } }, 422);
    expect(rulesUncheckedMark(await previewRecipePlan("r", "2026-10-05", "meal-1").catch((cause: unknown) => cause)))
      .toEqual({ verdict: "unknown", reason: "Rules could not be read." });
    // Any other 422 is a plain message, never a mark.
    answer({ error: "recipe_ineligible", message: "This recipe needs a rule check." }, 422);
    const plain = await previewRecipePlan("r", "2026-10-05", "meal-1").catch((cause: unknown) => cause);
    expect(rulesUncheckedMark(plain)).toBeNull();
    expect((plain as Error).message).toBe("This recipe needs a rule check.");
  });
});
