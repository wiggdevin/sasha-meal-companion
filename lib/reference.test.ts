/**
 * D1 §6.2: lib/reference.ts is a LABEL AND HELP DICTIONARY for the avoid half of Foods, not a
 * rule list. It used to hold one account's rules — three locked allergens and five categories
 * with clinical reasons — which components/AvoidRules.tsx rendered whoever was signed in.
 *
 * So what is guarded here is the opposite of what it used to guard: that a key can be named and
 * explained, and that naming one asserts nothing about anybody's diet.
 */
import { describe, expect, it } from "vitest";
import { POLICY_CATEGORY_KEYS } from "@/lib/catalog/category-map";
import {
  ALLERGEN_KEYS, ALLERGEN_LABELS, CATEGORY_KEYS, CATEGORY_LABELS, ruleHelp, ruleLabel,
} from "./reference";

describe("the rule dictionaries", () => {
  it("covers every banned-category key the policy matches, and only those", () => {
    expect(CATEGORY_KEYS).toEqual([...POLICY_CATEGORY_KEYS]);
  });

  it("offers the common allergens a rule can name", () => {
    for (const key of ["gluten", "dairy", "egg", "soy", "peanut", "shellfish", "sesame"]) {
      expect(ALLERGEN_KEYS, key).toContain(key);
    }
  });

  it("never offers apple, but still labels a row that carries it (Devin, 2026-09-22)", () => {
    expect(ALLERGEN_KEYS).not.toContain("apple");
    expect(ruleLabel("apple")).toBe("Apple");
    expect(ruleHelp("apple").length).toBeGreaterThan(0);
  });

  it("gives every key a label and a help line", () => {
    for (const [key, rule] of [...Object.entries(ALLERGEN_LABELS),
      ...Object.entries(CATEGORY_LABELS)]) {
      expect(rule.label.length, key).toBeGreaterThan(0);
      expect(rule.help.length, key).toBeGreaterThan(0);
    }
  });

  it("describes what a key covers, never who avoids it", () => {
    const prose = [...Object.values(ALLERGEN_LABELS), ...Object.values(CATEGORY_LABELS)]
      .map((rule) => `${rule.label} ${rule.help}`).join(" ");
    expect(prose).not.toMatch(/\bavoid|\btrigger|colitis|\bplan\b/i);
    expect(prose).not.toMatch(/\b(?:she|her|hers|herself)\b/i);
  });

  it("falls back to the key itself for one this build does not know", () => {
    expect(ruleLabel("gluten")).toBe("Gluten");
    expect(ruleLabel("carrageenan")).toBe("carrageenan");
    expect(ruleHelp("carrageenan")).toBe("");
  });
});
