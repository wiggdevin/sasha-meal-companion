/** Onboarding v2's practice, stay-away and cuisine answers: typed, read locally by keyword. */
import { describe, expect, it } from "vitest";
import {
  DISLIKE_FAMILIES, PRACTICE_IDS, parseCuisinesText, parseDislikes, parsePractices,
} from "@/lib/profile/onboarding-prefs-parse";
import { PREFERENCE_FLAGS } from "@/lib/profile/onboarding-state";
import { tasteFamilies } from "@/lib/profile/taste-families";
import { tasteDislike } from "@/lib/profile/taste";

describe("parsePractices", () => {
  it.each([
    ["halal", ["halal"]],
    ["Kosher", ["kosher"]],
    ["I'm vegetarian", ["vegetarian"]],
    ["vegan", ["vegan"]],
    ["plant-based", ["vegan"]],
    ["pescatarian", ["pescatarian"]],
    ["pescetarian", ["pescatarian"]],
    ["no pork", ["no_pork"]],
    ["I don't eat pork or beef", ["no_pork", "no_beef"]],
    ["no pork, no beef", ["no_pork", "no_beef"]],
    ["halal and no beef", ["halal", "no_beef"]],
    ["no red meat", ["no_pork", "no_beef"]],
    ["I'm not vegetarian", []],
    ["used to be vegan", []],
    ["pizza", []],
  ])("reads %j", (text, ids) => {
    expect(parsePractices(text).practices).toEqual(ids);
  });

  it("reads a plain no as answered with none", () => {
    expect(parsePractices("none")).toEqual({ practices: [], none: true });
    expect(parsePractices("No")).toEqual({ practices: [], none: true });
  });

  it("only ever names existing deterministic rule flags, never an allergen", () => {
    for (const id of PRACTICE_IDS) expect(PREFERENCE_FLAGS).toContain(id);
    expect(parsePractices("no shellfish, no peanuts, no eggs").practices).toEqual([]);
  });
});

describe("parseDislikes", () => {
  it("reads a typed list into canonical family keys", () => {
    expect(parseDislikes("mushrooms, olives and cilantro").dislikes)
      .toEqual(["f:mushrooms", "f:olives", "f:cilantro"]);
    expect(parseDislikes("I hate mushroom; no tomatoes").dislikes).toEqual(["f:mushrooms", "f:tomato"]);
    expect(parseDislikes("Brussel sprouts / coriander").dislikes).toEqual(["f:brussels sprouts", "f:cilantro"]);
    expect(parseDislikes("okra").dislikes).toEqual(["f:okra"]);
  });

  it("drops what is not a plain food word, and repeats", () => {
    expect(parseDislikes("olives, olive, 123, !!").dislikes).toEqual(["f:olives"]);
    expect(parseDislikes("nothing")).toEqual({ dislikes: [], none: true });
  });

  it("every tile is a canonical universe family", () => {
    const families = new Set(tasteFamilies());
    for (const family of DISLIKE_FAMILIES) {
      expect(families.has(family), family).toBe(true);
      expect(tasteDislike(`f:${family}`)).toBe(`f:${family}`);
    }
  });
});

describe("parseCuisinesText", () => {
  it("reads cuisines in typed order, from the 12-word vocabulary", () => {
    expect(parseCuisinesText("Mexican, Thai and Italian").cuisines)
      .toEqual(["latin_american", "southeast_asian", "italian"]);
    expect(parseCuisinesText("sushi and greek food").cuisines).toEqual(["japanese", "mediterranean"]);
    expect(parseCuisinesText("I like everything")).toEqual({ cuisines: [], none: false });
    expect(parseCuisinesText("anything")).toEqual({ cuisines: [], none: true });
  });

  it("keeps at most six", () => {
    expect(parseCuisinesText("mexican, italian, greek, indian, chinese, japanese, korean, thai").cuisines)
      .toHaveLength(6);
  });

  it("skips a negated cuisine", () => {
    expect(parseCuisinesText("not indian, but chinese").cuisines).toEqual(["chinese"]);
  });
});
