import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FACETS, facetRubricVersion } from "@/lib/foods/facets";
import {
  facetQuestions, facetState, OCCASION_DISH_EXAMPLES, OCCASION_RUBRIC_VERSION, RUBRIC_VERSION,
} from "@/lib/foods/facet-questions";
import { OCCASION_FACETS } from "@/lib/foods/facet-vocabulary";

const V1_FACETS = [
  "human_food",
  "requires_preparation",
  "breakfast_fit",
  "lunch_fit",
  "dinner_fit",
  "snack_fit",
  "meat",
  "fish_seafood",
  "shellfish",
  "animal_product",
  "pork",
  "beef",
  "alcohol",
  "contains_gluten",
  "contains_dairy",
  "contains_egg",
  "contains_peanut",
  "contains_tree_nut",
  "contains_soy",
  "contains_sesame",
  "raw_cruciferous",
  "raw_leafy_greens",
  "onion_garlic",
  "beans",
  "simple_sugars",
] as const;

describe("food facet rubric v1 (occasion facets at v2)", () => {
  it("freezes the complete v1 vocabulary as atomic Noul questions", () => {
    const questions = facetQuestions({ name: "Rice" }, FACETS);
    expect(RUBRIC_VERSION).toBe(1);
    expect(OCCASION_RUBRIC_VERSION).toBe(2);
    expect(FACETS).toEqual(V1_FACETS);
    expect(FACETS).not.toContain("high_fodmap");
    expect(Object.keys(questions)).toEqual(V1_FACETS);
    for (const question of Object.values(questions)) {
      expect(question.type).toBe("noul");
      expect(question.instructions).toMatch(/[?]$/);
      expect(Object.keys(question.criteria ?? {}).sort()).toEqual(["false", "true"]);
      expect(question.criteria?.true.length).toBeGreaterThan(20);
      expect(question.criteria?.false.length).toBeGreaterThan(20);
    }
  });

  it("describes only the food, never a user's diet or condition", () => {
    const forbidden = /\b(?:user|you|your|diet|conditions?)\b/i;
    for (const question of Object.values(facetQuestions({ name: "Rice" }))) {
      expect(question.instructions).not.toMatch(forbidden);
      expect(question.criteria?.true).not.toMatch(forbidden);
      expect(question.criteria?.false).not.toMatch(forbidden);
    }
  });

  it("builds only the requested questions and removes duplicates", () => {
    const questions = facetQuestions(
      { name: "Toast" },
      ["contains_gluten", "breakfast_fit", "contains_gluten"],
    );
    expect(Object.keys(questions)).toEqual(["contains_gluten", "breakfast_fit"]);
  });

  it("serialises only minimal food facts, never private fixture context", () => {
    const privateFixture = {
      name: "Rice bowl",
      brand: "Kitchen",
      description: "Cooked rice and vegetables",
      preparation: "cooked",
      ingredientsText: "rice, carrot",
      userId: "private-user-9",
      weight: "177.4 lb",
      conditions: ["ulcerative-colitis-secret"],
      notes: "gut-note-private-canary",
      flags: ["preference-flag-private-canary"],
    };
    const serialised = JSON.stringify(facetState(privateFixture));
    expect(JSON.parse(serialised)).toEqual({
      name: "Rice bowl",
      brand: "Kitchen",
      description: "Cooked rice and vegetables",
      preparation: "cooked",
      ingredientsText: "rice, carrot",
    });
    for (const secret of ["private-user-9", "177.4 lb", "ulcerative-colitis-secret",
      "gut-note-private-canary", "preference-flag-private-canary"]) {
      expect(serialised).not.toContain(secret);
    }
  });
});

describe("occasion rubric v2 (Phase 17 O3, D6)", () => {
  it("versions the four occasion facets at v2 and every other facet at v1", () => {
    for (const facet of FACETS) {
      expect(facetRubricVersion(facet), facet)
        .toBe((OCCASION_FACETS as readonly string[]).includes(facet) ? 2 : 1);
    }
  });

  it("asks for typical practice among people who eat the food, with dishes from several cuisines", () => {
    const questions = facetQuestions({ name: "Congee" }, OCCASION_FACETS);
    expect(questions.breakfast_fit.instructions)
      .toBe("Is this food a typical choice at breakfast for most people who eat this food?");
    expect(questions.snack_fit.instructions)
      .toBe("Is this food a typical choice as a snack for most people who eat this food?");
    for (const [facet, question] of Object.entries(questions)) {
      expect(question.criteria?.true, facet).toMatch(/most people who eat this food/i);
      expect(question.criteria?.false, facet).toMatch(/possible but unusual/i);
      expect(JSON.stringify(question), facet).not.toMatch(/at least one ordinary food culture/);
      for (const region of ["South Asia", "East Asia", "Latin America", "Mediterranean",
        "North America and Europe", "West Africa"]) expect(question.criteria?.true, facet).toContain(region);
    }
    expect(Object.keys(OCCASION_DISH_EXAMPLES)).toEqual(["breakfast", "lunch", "dinner", "snack"]);
  });

  it("keeps the frozen v1 wording only for the committed jev-facets eval", () => {
    const v1 = facetQuestions({ name: "Rice" }, ["breakfast_fit", "meat"], "v1");
    expect(v1.breakfast_fit.instructions).toBe("Is this food conventionally suitable to eat as breakfast?");
    expect(v1.breakfast_fit.criteria?.true).toMatch(/at least one ordinary food culture/);
    expect(v1.meat).toEqual(facetQuestions({ name: "Rice" }, ["meat"]).meat);
  });
});
