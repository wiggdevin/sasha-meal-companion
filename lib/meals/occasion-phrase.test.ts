// Phase 17 O4a: one occasion-phrase parser. It names the meal a request is for and removes the
// WHOLE phrase that named it, so a modifier ("late", "quick") never leaks into a dish query.
import { describe, expect, it } from "vitest";
import { parseOccasionPhrase } from "@/lib/meals/occasion-phrase";

const parse = parseOccasionPhrase;

describe("explicit for/at/as phrases", () => {
  it("removes the whole phrase, modifiers and determiner included", () => {
    expect(parse("salmon at lunch")).toEqual({ occasion: "lunch", rest: "salmon" });
    expect(parse("salmon for a late dinner")).toEqual({ occasion: "dinner", rest: "salmon" });
    expect(parse("chicken for an early lunch")).toEqual({ occasion: "lunch", rest: "chicken" });
    expect(parse("eggs as a snack")).toEqual({ occasion: "snack", rest: "eggs" });
    expect(parse("yogurt as a quick snack")).toEqual({ occasion: "snack", rest: "yogurt" });
    expect(parse("rice for my post-workout snack")).toEqual({ occasion: "snack", rest: "rice" });
    expect(parse("something warm for a quick and easy dinner")).toEqual({ occasion: "dinner", rest: "something warm" });
    expect(parse("salmon for lunch today")).toEqual({ occasion: "lunch", rest: "salmon" });
    expect(parse("salmon for tonight")).toEqual({ occasion: "dinner", rest: "salmon" });
  });

  it("takes the time words around the phrase with it (review round 1 BLOCK 2)", () => {
    expect(parse("chicken for dinner tomorrow night")).toEqual({ occasion: "dinner", rest: "chicken" });
    expect(parse("tomorrow night for dinner, chicken")).toEqual({ occasion: "dinner", rest: "chicken" });
    expect(parse("salmon at lunch on friday")).toEqual({ occasion: "lunch", rest: "salmon" });
    expect(parse("eggs for breakfast this morning")).toEqual({ occasion: "breakfast", rest: "eggs" });
    expect(parse("soup for dinner later tonight")).toEqual({ occasion: "dinner", rest: "soup" });
    // A time word after the meal word means the meal word is not part of a dish name.
    expect(parse("for dinner tonight salmon")).toEqual({ occasion: "dinner", rest: "salmon" });
  });

  it("reads brunch as breakfast and supper as dinner", () => {
    expect(parse("for brunch")).toEqual({ occasion: "breakfast", rest: "" });
    expect(parse("pancakes for brunch")).toEqual({ occasion: "breakfast", rest: "pancakes" });
    expect(parse("soup for supper")).toEqual({ occasion: "dinner", rest: "soup" });
  });

  it("takes the first meal of a list and removes the whole list", () => {
    expect(parse("salmon for lunch or dinner")).toEqual({ occasion: "lunch", rest: "salmon" });
  });

  it("keeps the text around the phrase, minus stray punctuation", () => {
    expect(parse("Salmon, for dinner, under 30 minutes"))
      .toEqual({ occasion: "dinner", rest: "Salmon, under 30 minutes" });
  });
});

describe("a meal word inside a dish name", () => {
  it("stays in the dish, and an explicit phrase beats it", () => {
    expect(parse("breakfast burrito for dinner")).toEqual({ occasion: "dinner", rest: "breakfast burrito" });
    expect(parse("breakfast burrito")).toEqual({ occasion: "breakfast", rest: "breakfast burrito" });
    expect(parse("snack bar")).toEqual({ occasion: "snack", rest: "snack bar" });
    expect(parse("ideas for breakfast sandwiches"))
      .toEqual({ occasion: "breakfast", rest: "ideas for breakfast sandwiches" });
  });

  it("keeps a bare word for a different meal as the food's description", () => {
    expect(parse("breakfast for dinner")).toEqual({ occasion: "dinner", rest: "breakfast" });
    // The same meal named twice is one occasion: both leave.
    expect(parse("dinner ideas for tonight")).toEqual({ occasion: "dinner", rest: "ideas" });
  });
});

describe("bare meal words", () => {
  it("names the meal and leaves quality words in the dish", () => {
    expect(parse("easy breakfast")).toEqual({ occasion: "breakfast", rest: "easy" });
    expect(parse("salmon tonight")).toEqual({ occasion: "dinner", rest: "salmon" });
    expect(parse("brunch ideas")).toEqual({ occasion: "breakfast", rest: "ideas" });
    expect(parse("Find me an easy chicken dinner recipe"))
      .toEqual({ occasion: "dinner", rest: "Find me an easy chicken recipe" });
  });

  it("removes a time-of-day word with the meal", () => {
    expect(parse("late night snack")).toEqual({ occasion: "snack", rest: "" });
    expect(parse("chicken dinner tomorrow night")).toEqual({ occasion: "dinner", rest: "chicken" });
    expect(parse("dinnertime stew")).toEqual({ occasion: "dinner", rest: "dinnertime stew" });
    expect(parse("an early lunch with tofu")).toEqual({ occasion: "lunch", rest: "with tofu" });
  });

  it("names nothing when there is no meal word", () => {
    expect(parse("chicken stew")).toEqual({ occasion: null, rest: "chicken stew" });
    expect(parse("")).toEqual({ occasion: null, rest: "" });
    expect(parse(null)).toEqual({ occasion: null, rest: "" });
    // "pre-dinner" is one word; the snack is the meal.
    expect(parse("pre-dinner snack").occasion).toBe("snack");
  });
});
