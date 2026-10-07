/**
 * The literal-name guard shared by Foods › Avoids and onboarding's composer. An exclusion matches
 * only its whole saved text, so every refused input below would fail to block the food it names.
 */
import { describe, expect, it } from "vitest";
import { isLiteralName } from "@/components/custom-rule-text";
import { matchesRule } from "@/lib/policy/custom-rules";

const rule = (text: string) => ({ id: "00000000-0000-4000-8000-000000000000", kind: "ingredient" as const, text });

describe("isLiteralName", () => {
  it.each([
    "garlic", "Thai red curry paste", "extra virgin olive oil", "free-range eggs",
    "South Indian", "crème fraîche", "7-Up",
    "free range eggs", "high fructose corn syrup", "low sodium soy sauce", "St. John's wort",
    "gluten-free bread", "sugar-free gum", "all-purpose flour", "no-bake cookies", "ready-to-eat meals",
  ])("accepts the food name %j", (text) => {
    expect(isLiteralName(text)).toBe(true);
  });

  it.each([
    "allergic to garlic", "I can't eat garlic", "avoid garlic", "no garlic",
    "garlic, onion", "garlic and onion", "garlic or onion", "garlic & onion", "garlic/onion",
    "garlic causes hives", "garlic makes me sick", "gluten free", "sugar-free",
    "garlic.", "less than 5g sugar",
    "avoid-garlic", "garlic—or onion", "garlic – onion", "gluten\u2011free", "garlic triggers hives",
    "reaction to garlic", "low sugar", "high protein",
    "foods containing garlic", "anything with garlic", "garlic • onion", "garlic | onion", "garlic * onion",
  ])("refuses %j, which would not block garlic-named foods", (text) => {
    expect(isLiteralName(text)).toBe(false);
  });

  it("the refused shapes really do miss under the matcher, and the bare name hits", () => {
    expect(matchesRule("garlic", rule("garlic, onion"))).toBe(false);
    expect(matchesRule("garlic", rule("garlic causes hives"))).toBe(false);
    expect(matchesRule("roasted garlic", rule("garlic"))).toBe(true);
    expect(matchesRule("free range eggs", rule("free-range eggs"))).toBe(true);
  });
});
