import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { facetQuestions, facetState } from "@/lib/foods/facet-questions";
import { FACET_RULES, type PolicyPreferenceFlag } from "@/lib/policy/facet-rules";

describe("F10 policy provider state", () => {
  it.each(Object.keys(FACET_RULES) as PolicyPreferenceFlag[])(
    "keeps stored user fields out of the %s facet path",
    (flag) => {
      const privateFoodFixture = {
        name: "Rice bowl",
        brand: "Kitchen",
        description: "Cooked rice and vegetables",
        preparation: "cooked",
        ingredientsText: "rice, carrot",
        weight: "177.4 lb private canary",
        conditions: ["ulcerative-colitis-private-canary"],
        notes: "private-gut-note-canary",
        diet_prefs: { text: "private-diet-text-canary" },
      };
      const facets = FACET_RULES[flag].map((rule) => rule.facet);
      const providerPayload = JSON.stringify({
        state: facetState(privateFoodFixture),
        questions: facetQuestions(privateFoodFixture, facets),
      });

      expect(JSON.parse(providerPayload).state).toEqual({
        name: "Rice bowl",
        brand: "Kitchen",
        description: "Cooked rice and vegetables",
        preparation: "cooked",
        ingredientsText: "rice, carrot",
      });
      for (const field of ["weight", "conditions", "notes", "diet_prefs"]) {
        expect(providerPayload).not.toContain(`"${field}"`);
      }
      for (const secret of ["177.4 lb private canary", "ulcerative-colitis-private-canary",
        "private-gut-note-canary", "private-diet-text-canary"]) {
        expect(providerPayload).not.toContain(secret);
      }
    },
  );
});
