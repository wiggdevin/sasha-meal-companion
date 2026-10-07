/**
 * Phase 18 W5b (Sol r5): the onboarding dietary text keeps its suggestions for text the taste safety
 * check keeps from Jev and every model. The phone's keyword suggester maps common entries onto the field's own
 * flags and cooking effort — no Jev, no request — and suggests nothing for medical or symptom text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "account-a", epoch: 1 }),
  accountFetch: (_h: unknown, url: string, init: RequestInit) => mocked.fetch(url, init),
  accountJson: async (_h: unknown, response: Response) => response.json(),
  rethrowAccountChanged: () => undefined,
}));

import { classifyDietaryPreferences, createPreferenceClassifier } from "@/lib/profile/prefs-client";
import { tasteTextRoute } from "@/lib/profile/taste-safety";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS } from "@/tests/fixtures/taste-safety-corpus";

beforeEach(() => { mocked.fetch.mockReset(); });

/** [text, expected flags, expected cooking effort] — common entries a person types into the field. */
const TABLE: readonly [string, string[], string | null][] = [
  ["Vegetarian", ["vegetarian"], null],
  ["I'm vegetarian", ["vegetarian"], null],
  ["vegan", ["vegan"], null],
  ["I'm vegan", ["vegan"], null],
  ["Plant-based", ["vegan"], null],
  ["No meat", ["vegetarian"], null],
  ["I don't eat meat", ["vegetarian"], null],
  ["Pescatarian", ["pescatarian"], null],
  ["I only eat fish, no other meat", ["pescatarian"], null],
  ["No shellfish", ["no_shellfish"], null],
  ["I'm allergic to shrimp", ["no_shellfish"], null],
  ["No pork", ["no_pork"], null],
  ["I don't eat pork or bacon", ["no_pork"], null],
  ["No beef", ["no_beef"], null],
  ["I avoid beef", ["no_beef"], null],
  ["No eggs", ["no_eggs"], null],
  ["Egg allergy", ["no_eggs"], null],
  ["Soy-free", ["no_soy"], null],
  ["No tofu or soy", ["no_soy"], null],
  ["Peanut allergy", ["no_peanuts"], null],
  ["I'm allergic to peanuts", ["no_peanuts"], null],
  ["Low FODMAP", ["low_fodmap"], null],
  ["Halal", ["halal"], null],
  ["I eat halal only", ["halal"], null],
  ["Kosher", ["kosher"], null],
  ["I keep kosher", ["kosher"], null],
  ["Vegetarian, no eggs", ["vegetarian", "no_eggs"], null],
  ["Halal and no shellfish", ["halal", "no_shellfish"], null],
  ["Vegan and soy-free", ["vegan", "no_soy"], null],
  ["I only do quick cooking", [], "minimal"],
  ["Quick and easy meals only", [], "minimal"],
  ["I don't cook", [], "none"],
  ["No cooking please", [], "none"],
  ["Vegetarian, only quick cooking", ["vegetarian"], "minimal"],
  // Sol r6: an exclusion is suggested only where it governs that food in the same clause.
  ["No shellfish; I eat eggs", ["no_shellfish"], null],
  ["No shellfish; I love egg-free cake", ["no_shellfish"], null],
  ["I buy egg-free pasta sometimes", [], null],
  ["Egg-free", ["no_eggs"], null],
  ["I'm egg-free and soy-free", ["no_eggs", "no_soy"], null],
  ["Peanut-free household", ["no_peanuts"], null],
  ["No shellfish, but I eat eggs", ["no_shellfish"], null],
  ["No pork. I love bacon though", ["no_pork"], null],
  ["I eat eggs and tofu, no beef", ["no_beef"], null],
  ["Halal, and I eat shrimp", ["halal"], null],
  ["No eggs but soy is fine", ["no_eggs"], null],
  ["Without pork, beef is fine", ["no_pork"], null],
  ["I avoid pork; eggs are fine", ["no_pork"], null],
  ["Peanut-free, I do eat eggs", ["no_peanuts"], null],
  ["I can't have shellfish, I eat pork", ["no_shellfish"], null],
  ["Skip the tofu, keep the eggs", ["no_soy"], null],
  ["Kosher, no shellfish or pork", ["kosher", "no_shellfish", "no_pork"], null],
  ["Vegan, but I only eat tofu sometimes", ["vegan"], null],
  ["Allergic to peanuts and I eat soy", ["no_peanuts"], null],
  ["I only eat beef and pork", [], null],
];

describe("the phone's flag suggester for kept dietary text", () => {
  it.each(TABLE)("%s", async (text, flags, effort) => {
    expect(tasteTextRoute(text).route).toBe("local");
    const result = await classifyDietaryPreferences(text);
    expect(Object.keys(result?.flags ?? {}).sort()).toEqual([...flags].sort());
    expect(result?.cookingEffortSuggestion ?? null).toBe(effort);
    expect(result).toMatchObject({ jev: flags.length > 0 || effort !== null, source: "local", route: "local" });
  });

  it("holds at least 30 entries, 17 of them mixed-clause, and never makes a request", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(49);
    expect(mocked.fetch).not.toHaveBeenCalled();
  });

  it("suggests nothing for medical or symptom text: the rule editor offer stands", async () => {
    for (const text of ["I avoid eggs because they make me nauseous", "No shellfish, it gives me hives",
      "Vegetarian; dairy upsets my stomach", "I have celiac", "my doctor says no grapefruit", "dairy gives me cramps", "eggs upset my stomach",
      "I'm diabetic so no sugar", "I have IBS and follow low FODMAP", "I'm pregnant and avoid raw fish",
      "Shrimp makes my lips swell", "I take warfarin so no leafy greens"]) {
      const result = await classifyDietaryPreferences(text);
      expect([text, result?.flags, result?.jev, result?.offer]).toEqual([text, {}, false, "rule_editor"]);
    }
  });

  it("the field applies the local flags through its existing classifier", async () => {
    const applied: string[][] = [];
    const classifier = createPreferenceClassifier((flags) => applied.push(flags), () => undefined);
    await classifier.run("Vegetarian, no eggs");
    expect(applied).toEqual([["vegetarian", "no_eggs"]]);
  });

  it("never suggests a flag from a symptom anywhere in the keep-local corpus", async () => {
    for (const c of [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS].filter((c) => c.reason === "symptom")) {
      expect([c.text, (await classifyDietaryPreferences(c.text))?.flags]).toEqual([c.text, {}]);
    }
  });
});
