/**
 * W106: the map's keyword-first facets (tyramine_rich from R2-20's label list, grapefruit_family,
 * star_fruit, fava_bean, aspartame, phosphate_additive, gelatin, honey, mollusc). A named match is
 * present; nothing is ever absent, so an unlisted food stays `unverified` under a hard rule.
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "@/lib/policy/constraints";
import { evaluateNewFacet } from "@/lib/policy/profiles/new-facets";
import { ruleId } from "@/lib/policy/profiles/types";
import type { NewFacet } from "@/lib/foods/facet-vocabulary";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const W106: readonly NewFacet[] = ["tyramine_rich", "grapefruit_family", "star_fruit", "fava_bean",
  "aspartame", "phosphate_additive", "gelatin", "honey", "mollusc"];

describe("W106 keyword facets", () => {
  it.each([
    // R2-20: wine, alcohol-free beer, yogurt, liver and pickled herring are on the list.
    ["tyramine_rich", "Pinot noir wine", "present"],
    ["tyramine_rich", "Non-alcoholic beer", "present"],
    ["tyramine_rich", "Greek yogurt, plain", "present"],
    ["tyramine_rich", "Chicken liver", "present"],
    ["tyramine_rich", "Pickled herring in wine sauce", "present"],
    ["tyramine_rich", "Aged cheddar", "present"],
    ["tyramine_rich", "Cottage cheese", "unknown"],
    ["tyramine_rich", "Fresh chicken breast", "unknown"],
    ["grapefruit_family", "Ruby red grapefruit juice", "present"],
    ["grapefruit_family", "Seville orange marmalade", "present"],
    ["grapefruit_family", "Navel orange", "unknown"],
    ["star_fruit", "Carambola slices", "present"],
    ["fava_bean", "Ful medames", "present"],
    ["fava_bean", "Falafel wrap", "present"],
    ["fava_bean", "Black beans", "unknown"],
    ["aspartame", "Diet cola (aspartame)", "present"],
    ["aspartame", "Phenylketonurics: contains phenylalanine", "present"],
    ["phosphate_additive", "Cola, phosphoric acid, caramel color", "present"],
    ["phosphate_additive", "Ham, water, sodium tripolyphosphate", "present"],
    ["phosphate_additive", "Plain rice", "unknown"],
    ["gelatin", "Gummy bears, gelatin", "present"],
    ["gelatin", "Fruit snacks, pectin", "unknown"],
    ["honey", "Honey nut cereal", "present"],
    ["honey", "Honeydew melon", "unknown"],
    ["mollusc", "Pasta with clams", "present"],
    ["mollusc", "Stir-fry, oyster sauce", "present"],
    ["mollusc", "Oyster mushrooms, sauteed", "unknown"],
    ["mollusc", "Clam chowder with oyster crackers", "present"],
    ["mollusc", "Tomato soup with oyster crackers", "unknown"],
  ] as const)("%s: %j -> %s", (facet, text, expected) => {
    expect(evaluateNewFacet(facet, { text })).toBe(expected);
  });

  it("never returns absent, whatever the text", () => {
    for (const facet of W106) {
      for (const text of ["", "Water.", "Banana", "Plain white rice, cooked"]) {
        expect(evaluateNewFacet(facet, { text }), `${facet} ${text}`).not.toBe("absent");
      }
    }
  });

  it("a confirmed MAOI rule blocks a listed food and leaves an unlisted one unverified", () => {
    const profileRules = { asOf: new Date("2026-10-17T12:00:00Z"), items: [{
      id: ruleId("maoi", "tyramine_rich"), profileId: "maoi", facet: "tyramine_rich", strength: "never",
      hardBasis: "user_confirmed_safety", evidenceStrength: "strong", confirmation: "confirmed",
      expiresAt: null,
    }] } as const;
    const judge = (foodName: string) => evaluatePolicy({ ...TEST_PROFILE, allergens: [] }, {
      foodRefId: null, allergenTags: [], category: [], onEatsList: true, onAvoidList: false,
      foodName, profileRules,
    }).verdict;
    expect(judge("Red wine")).toBe("blocked");
    expect(judge("Banana")).toBe("unverified");
  });
});
