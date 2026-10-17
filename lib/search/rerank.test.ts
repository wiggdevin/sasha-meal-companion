import { describe, expect, it, vi } from "vitest";
import {
  DISH_MARKER_PENALTY, foldTypos, isUnaskedDish, penalizeDishes, rerankedSearch,
  searchRerankEnabled, trigramSimilarity,
} from "./rerank";

const row = (description: string, score: number) => ({ description, score });

describe("trigramSimilarity", () => {
  it("matches pg_trgm on single words", () => {
    expect(trigramSimilarity("potato", "potato")).toBe(1);
    // "  potatoe " vs "  potato ": 6 shared of 9.
    expect(trigramSimilarity("potatoe", "potato")).toBeCloseTo(6 / 9, 6);
    expect(trigramSimilarity("eggs", "egg")).toBeCloseTo(0.5, 6);
  });
});

describe("foldTypos", () => {
  it("folds an unknown word to its nearest candidate word at 0.6 or above", () => {
    expect(foldTypos("brocoli", ["Broccoli, raw", "Broccoli, cooked, boiled"])).toBe("broccoli");
    expect(foldTypos("bananna", ["Bananas, raw", "Banana bread"])).toBe("banana");
  });

  it("leaves a word a description already spells", () => {
    expect(foldTypos("sweet potato", ["Sweet potato, raw", "Pie, sweet potato"])).toBeNull();
  });

  it("never folds below 0.6, a short word, a number or a plural/stem", () => {
    expect(foldTypos("chkn", ["Chicken, breast, raw"])).toBeNull();
    // 0.56: the curated synonym row (salmom -> fish salmon) owns this one, not the fold.
    expect(foldTypos("salmom", ["Fish, salmon, Atlantic, raw"])).toBeNull();
    expect(foldTypos("egg", ["Eggplant, raw"])).toBeNull();
    expect(foldTypos("2 eggs", ["Egg, whole, raw"])).toBeNull();
    expect(foldTypos("tomatoes", ["Tomato, red, raw"])).toBeNull();
  });

  it("folds only the unknown word of a two-word query", () => {
    expect(foldTypos("frozen brocoli", ["Broccoli, frozen, chopped"])).toBe("frozen broccoli");
  });
});

describe("dish-marker penalty", () => {
  it("marks a dish word the query did not ask for", () => {
    expect(isUnaskedDish("sweet potato", "Pie, sweet potato")).toBe(true);
    expect(isUnaskedDish("carrot", "Muffin, carrot")).toBe(true);
    expect(isUnaskedDish("salmon", "Salmon salad")).toBe(true);
    expect(isUnaskedDish("potato", "Potatoes, french fries, frozen")).toBe(true);
  });

  it("keeps a dish the query names, plural or not", () => {
    expect(isUnaskedDish("carrot cake", "Cake, carrot")).toBe(false);
    expect(isUnaskedDish("muffins", "Muffin, blueberry")).toBe(false);
    expect(isUnaskedDish("salmon salad", "Salmon salad")).toBe(false);
  });

  it("does not mark form words that are not dishes", () => {
    expect(isUnaskedDish("ground beef", "Beef, ground, 80% lean, patty, cooked, broiled")).toBe(false);
    expect(isUnaskedDish("pepper", "Peppers, hot chili, red, raw")).toBe(false);
    expect(isUnaskedDish("carrot", "Carrots, baby, raw")).toBe(false);
  });

  it("lets the plain ingredient row beat the dish row on a short query", () => {
    const ranked = penalizeDishes("sweet potato", [
      row("Pie, sweet potato", 0.42),
      row("Sweet potato, raw, unprepared", 0.38),
      row("Sweet potato, cooked, baked in skin", 0.36),
    ]);
    expect(ranked.map((r) => r.description)).toEqual([
      "Sweet potato, raw, unprepared",
      "Sweet potato, cooked, baked in skin",
      "Pie, sweet potato",
    ]);
    expect(ranked[2].score).toBeCloseTo(0.42 - DISH_MARKER_PENALTY, 6);
  });

  it("keeps an explicit dish name first", () => {
    const ranked = penalizeDishes("carrot cake", [
      row("Cake, carrot, with cream cheese icing", 0.45),
      row("Carrots, raw", 0.3),
    ]);
    expect(ranked[0].description).toBe("Cake, carrot, with cream cheese icing");
    expect(ranked[0].score).toBe(0.45);
  });

  it("keeps an exact match first", () => {
    const ranked = penalizeDishes("salmon salad", [
      row("Salmon salad", 0.5),
      row("Fish, salmon, Atlantic, raw", 0.31),
    ]);
    expect(ranked[0].description).toBe("Salmon salad");
  });

  it("leaves queries of three or more words untouched", () => {
    const rows = [row("Pie, sweet potato", 0.42), row("Sweet potato, raw, unprepared", 0.4)];
    expect(penalizeDishes("sweet potato baked", rows)).toEqual(rows);
  });

  it("is stable on ties and never goes below zero", () => {
    const ranked = penalizeDishes("rice", [
      row("Rice, white, long-grain, raw", 0.3),
      row("Rice, brown, long-grain, raw", 0.3),
      row("Pudding, rice", 0.05),
    ]);
    expect(ranked.map((r) => r.description)).toEqual([
      "Rice, white, long-grain, raw", "Rice, brown, long-grain, raw", "Pudding, rice",
    ]);
    expect(ranked[2].score).toBe(0);
  });
});

describe("rerankedSearch", () => {
  it("off: one call, rows untouched", async () => {
    const rows = [row("Pie, sweet potato", 0.42), row("Sweet potato, raw", 0.38)];
    const run = vi.fn(async () => rows);
    const out = await rerankedSearch("sweet potatoe", run, false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ rows, query: "sweet potatoe" });
  });

  it("on: re-runs a folded query, then ranks the plain row first", async () => {
    const run = vi.fn(async (q: string) =>
      q === "sweet potato"
        ? [row("Pie, sweet potato", 0.45), row("Sweet potato, raw, unprepared", 0.4)]
        : [row("Pie, sweet potato", 0.3), row("Sweet potato, raw, unprepared", 0.25)]);
    const out = await rerankedSearch("sweet potatoe", run, true);
    expect(run.mock.calls.map((c) => c[0])).toEqual(["sweet potatoe", "sweet potato"]);
    expect(out.query).toBe("sweet potato");
    expect(out.rows[0].description).toBe("Sweet potato, raw, unprepared");
  });

  it("on: keeps the first run when the folded query finds nothing", async () => {
    const run = vi.fn(async (q: string) => (q === "brocoli" ? [row("Broccoli, raw", 0.2)] : []));
    const out = await rerankedSearch("brocoli", run, true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ rows: [row("Broccoli, raw", 0.2)], query: "brocoli" });
  });

  it("on: no fold means no second call", async () => {
    const run = vi.fn(async () => [row("Eggs, whole, raw", 0.4)]);
    await rerankedSearch("eggs", run, true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("searchRerankEnabled", () => {
  it("is on only for CATALOG_SEARCH_RERANK=1", () => {
    expect(searchRerankEnabled({})).toBe(false);
    expect(searchRerankEnabled({ CATALOG_SEARCH_RERANK: "true" })).toBe(false);
    expect(searchRerankEnabled({ CATALOG_SEARCH_RERANK: "1" })).toBe(true);
  });
});
