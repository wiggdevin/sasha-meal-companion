import { describe, expect, it } from "vitest";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { ASK_SASHA_MAX_MEALS, askCapNotice, ASK_SASHA_MAX_QUESTION, ASK_SASHA_MAX_TEXT, askSashaPayload, askSashaText,
  affectedLabel, impactRecipeOptions, impactSwipe } from "./AvoidImpact";

describe("affected meal swipe", () => {
  it("requires a deliberate horizontal gesture before exposing removal or opening remix", () => {
    expect(impactSwipe(-90, 12)).toBe("remove");
    expect(impactSwipe(90, -12)).toBe("remix");
    expect(impactSwipe(-90, 110)).toBeNull();
    expect(impactSwipe(90, -90)).toBeNull();
    expect(impactSwipe(-60, 0)).toBeNull();
  });
});

describe("verified affected meal replacements", () => {
  function candidate(id: string, name: string, ingredients: string[],
    status: "eligible" | "unknown" = "eligible", linked = false): RecipeCandidate {
    return { recipeId: id, revisionId: id, name, cuisine: "American", dishTags: [],
      totalMinutes: 20, eligibility: { status, reasons: [] },
      ingredients: ingredients.map((ingredient) => ({ name: ingredient,
        foodRefId: linked ? `ref-${ingredient}` : null, foodDbId: null })) } as unknown as RecipeCandidate;
  }

  it("filters the checked ingredient before ranking, even when matching recipes crowd the top results", () => {
    const current = { name: "Banana oats", cuisine: "American", dishTags: [], totalMinutes: 20 };
    const options = [
      candidate("same", "Banana oats", ["banana", "oats"]),
      candidate("b1", "Banana oats with cinnamon", ["banana", "oats"]),
      candidate("b2", "Banana oats bowl", ["banana", "oats"]),
      candidate("b3", "Banana oat breakfast", ["banana", "oats"]),
      candidate("u1", "Lemon chicken unknown", ["chicken breast", "lemon"], "unknown"),
      candidate("safe", "Lemon chicken", ["chicken breast", "lemon"]),
    ];
    expect(impactRecipeOptions(current, options,
      { kind: "ingredient", q: "banana", catalogFoodId: null }, "same")
      .map((recipe) => recipe.recipeId)).toEqual(["safe"]);
  });

  it("keeps an eligible linked recipe when its ingredients do not match the avoided catalog food", () => {
    const current = { name: "Banana oats", cuisine: "American", dishTags: [], totalMinutes: 20 };
    const options = [candidate("safe", "Lemon chicken", ["chicken breast", "lemon"], "eligible", true)];

    expect(impactRecipeOptions(current, options,
      { kind: "ingredient", q: "banana", catalogFoodId: 42 })
      .map((recipe) => recipe.recipeId)).toEqual(["safe"]);
  });
});

describe("Ask Sasha payload", () => {
  it("carries the user's own trimmed wording with the affected ids, deduplicated", () => {
    expect(askSashaPayload("  Can I keep the pasta?  ",
      ["2026-10-01:meal-1", "2026-10-02:meal-2", "2026-10-01:meal-1"])).toEqual({
      question: "Can I keep the pasta?", affectedIds: ["2026-10-01:meal-1", "2026-10-02:meal-2"] });
  });

  it("caps the ids at the existing bounded request limit", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}:meal-1`);
    const payload = askSashaPayload("Swap these?", [...ids, ...ids]);
    expect(ASK_SASHA_MAX_MEALS).toBe(12);
    expect(payload?.affectedIds).toEqual(ids.slice(0, ASK_SASHA_MAX_MEALS));
  });

  it("says when only the first meals are sent: more than the limit is covered", () => {
    expect(askCapNotice(30, 0)).toBe(
      "Asking about the first 12 of 30 affected meals; select specific meals to choose which");
    expect(askCapNotice(12, 0)).toBeNull();
    expect(askCapNotice(30, 3)).toBeNull();
    expect(askCapNotice(30, 15)).toBe(
      "Asking about the first 12 of 15 selected meals; select fewer to choose which");
  });

  it("sends nothing for blank wording and bounds a long one", () => {
    expect(askSashaPayload("   \n ", ["2026-10-01:meal-1"])).toBeNull();
    expect(askSashaPayload("x".repeat(900), [])?.question).toHaveLength(ASK_SASHA_MAX_QUESTION);
  });
});

describe("Ask Sasha request text", () => {
  const long = (label: string, n: number) => `${label} `.padEnd(n, "x");
  const items = (n: number, title = 120) => Array.from({ length: n }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, "0")}`, slot: "meal-1",
    title: long(`Garlic pasta ${i + 1}`, title) }));
  const options = (list: ReturnType<typeof items>, name = 120) => list.map((item, i) => ({
    date: item.date, slot: item.slot,
    names: [long(`Option A${i + 1}`, name), long(`Option B${i + 1}`, name)] }));
  const base = { kind: "ingredient" as const, excluded: "garlic" };

  it("sends everything unchanged when it fits", () => {
    const list = items(2, 30);
    const text = askSashaText({ ...base, question: "Keep these?", items: list, options: options(list, 20) });
    expect(text).toContain("Keep these?");
    for (const item of list) expect(text).toContain(item.title.slice(0, 80));
    for (const row of options(list, 20)) expect(text).toContain(row.names[1]);
  });

  it("trims verified options before any meal title", () => {
    const list = items(12, 60);
    const text = askSashaText({ ...base, question: long("Why?", 400), items: list, options: options(list) });
    expect(text.length).toBeLessThanOrEqual(ASK_SASHA_MAX_TEXT);
    for (const item of list) expect(text).toContain(item.title);
    expect(text).not.toContain(options(list)[11].names[1]);
  });

  it("trims meal titles only after the options are gone, never the question or an id", () => {
    // More meals than the UI sends, so the second stage is reached: titles shorten, ids stay.
    const list = items(20);
    const question = long("Can these stay?", ASK_SASHA_MAX_QUESTION);
    const text = askSashaText({ ...base, question, items: list, options: options(list, 200) });
    expect(ASK_SASHA_MAX_TEXT).toBe(2000);
    expect(text.length).toBeLessThanOrEqual(ASK_SASHA_MAX_TEXT);
    expect(text.startsWith(question)).toBe(true);
    for (const item of list) expect(text).toContain(`${item.date}:${item.slot}`);
    expect(text).not.toContain("Option A1");
    expect(text).not.toContain(list[0].title.slice(0, 80));
  });
});

describe("affected meals chip wording", () => {
  it("never reads 0+: a complete zero is good news, an incomplete zero asks for a check", () => {
    expect(affectedLabel({ count: 0, complete: true })).toBe("No saved meals affected");
    expect(affectedLabel({ count: 0, complete: false })).toBe("Check affected meals");
    expect(affectedLabel({ count: 3, complete: true })).toBe("3 affected");
    expect(affectedLabel({ count: 3, complete: false }, "saved future meals")).toBe("3+ affected saved future meals");
  });
});
