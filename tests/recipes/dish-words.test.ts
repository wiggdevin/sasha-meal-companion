/**
 * O4a review round 3: recipe search ranks, it never filters on query words. Only explicit filters
 * (cuisine, time, effort, exclusions, eligibility) remove a recipe. A recipe carrying every query
 * word comes first, then those carrying fewer; `exactMatch: false` says no recipe carried them all.
 */
import { describe, expect, it } from "vitest";
import { recipeSearchFromWish } from "@/lib/coach/recipe-query";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import type { RecipeCandidate, RecipeSearch } from "@/lib/recipe-catalog/types";
import { findRecipeCandidates } from "@/lib/recipes/candidates";
import { recipeOccasions } from "@/lib/recipes/occasion";

const recipes = pilotRecipes();
const run = (search: RecipeSearch) =>
  findRecipeCandidates(recipes, { ...search, limit: 64 }, { profile: EMPTY_PROFILE });
const search = (query: string) => run({ query }).candidates;
const fromWish = (wish: string) => run(recipeSearchFromWish(wish).search).candidates;
const ids = (rows: readonly RecipeCandidate[]) => rows.map((row) => row.revisionId).sort();
const carries = (row: RecipeCandidate, word: string) => new RegExp(word, "i").test([row.name,
  ...row.dishTags, ...row.ingredients.map((item) => item.name)].join(" "));
const all = ids(search(""));

describe("query words rank, never filter", () => {
  it("\"roast chicken\" returns the chicken recipes, ranked above the rest", () => {
    const found = run({ query: "roast chicken" });
    const chicken = recipes.filter((row) => carries(row as RecipeCandidate, "chicken"));
    expect(chicken.length).toBeGreaterThan(0);
    expect(ids(found.candidates)).toEqual(all);
    const top = found.candidates.slice(0, chicken.length);
    expect(top.every((row) => carries(row, "chicken") || carries(row, "roast"))).toBe(true);
    for (const row of chicken) expect(found.candidates.map((c) => c.revisionId)).toContain(row.revisionId);
  });

  it("\"salmon\" ranks the salmon recipes first, and is an exact match", () => {
    const found = run({ query: "salmon" });
    const salmon = found.candidates.filter((row) => carries(row, "salmon")).length;
    expect(salmon).toBeGreaterThan(0);
    expect(found.candidates.slice(0, salmon).every((row) => carries(row, "salmon"))).toBe(true);
    expect(found.exactMatch).toBe(true);
  });

  it("\"pork\", which no recipe has, returns the closest recipes with exactMatch false", () => {
    const found = run({ query: "pork" });
    expect(found.candidates.length).toBeGreaterThan(0);
    expect(ids(found.candidates)).toEqual(all);
    expect(found.exactMatch).toBe(false);
    expect(run({ query: "" }).exactMatch).toBe(true);
  });

  it("time and errand words return the same recipes as the dish alone, dinner first", () => {
    for (const wish of ["chicken for dinner at 7pm", "chicken after work",
      "chicken for dinner tonight around 7"]) {
      expect(ids(fromWish(wish)), wish).toEqual(ids(fromWish("chicken")));
    }
    const dinner = fromWish("chicken for dinner at 7pm");
    expect(carries(dinner[0], "chicken") && recipeOccasions(dinner[0]).has("dinner")).toBe(true);
  });

  it("explicit filters still remove recipes", () => {
    expect(run({ query: "", maxMinutes: 5 }).candidates.length).toBeLessThan(all.length);
    expect(run({ query: "", effort: "none" }).candidates.every((row) => row.effort === "none")).toBe(true);
  });
});

/** mulberry32: a small seeded generator, so the property run is the same on every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: an appended word of any kind never shrinks the candidate set", () => {
  const next = seeded(20261005);
  const LETTERS = "abcdefghijklmnopqrstuvwxyz";
  const randomWord = () => Array.from({ length: 2 + Math.floor(next() * 8) },
    () => LETTERS[Math.floor(next() * LETTERS.length)]).join("");
  const words = ["at", "7pm", "after", "work", "quick", "easy", "roast", "salmon", "pork", "and",
    "with", "beef", "red", "tonight", "19:30", "no-cook", ...Array.from({ length: 60 }, randomWord)];

  it.each(["chicken", "salmon", "stew", "", "rice bowls", "egg", "roast chicken"])("%s", (base) => {
    const expected = ids(search(base));
    for (const word of words) {
      expect(ids(search(`${base} ${word}`)), `"${base}" + "${word}"`).toEqual(expected);
      expect(ids(search(`${word} ${base}`)), `"${word}" + "${base}"`).toEqual(expected);
    }
  }, 20_000); // 152 searches per case: about 1 s alone, past 5 s on a loaded CI runner
});
