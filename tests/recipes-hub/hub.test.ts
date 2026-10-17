import { describe, expect, it } from "vitest";
import { chipPrompt, eatenStatement, exampleAt, fitLabel, fitToday, hubSearchFor, portionQuestion,
  portionToLog, remainingLine, remainingMacros } from "@/lib/recipes-hub/hub";

describe("recipe widget rules", () => {
  it("reads only a statement of what was eaten as a log, never a question", () => {
    expect(eatenStatement("I had two slices of the lasagna")).toBe("two slices of the lasagna");
    expect(eatenStatement("i just ate a banana.")).toBe("a banana");
    expect(eatenStatement("log a coffee")).toBe("a coffee");
    expect(eatenStatement("How much lasagna can I have?")).toBeNull();
    expect(eatenStatement("I had a long day, any hearty soup?")).toBeNull();
    expect(eatenStatement("I really want steak")).toBeNull();
  });

  it("knows a portion question from a request for options", () => {
    expect(portionQuestion("a friend is cooking lasagna, how much can I eat?")).toBe(true);
    expect(portionQuestion("How many slices of pizza?")).toBe(true);
    expect(portionQuestion("I feel like Italian, is there anything I can have without going over?")).toBe(false);
  });

  it("sizes fit from what is left today, and never calls an unknown a fit", () => {
    const left = remainingMacros({ targets: { kcal: 2000, protein: 150, carbs: 200, fat: 60 },
      consumed: { kcal: 2100, protein: 100, carbs: 150, fat: 40 } });
    expect(left).toEqual({ kcal: 0, protein: 50, carbs: 50, fat: 20 });
    expect(remainingMacros({ targets: null, consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 } })).toBeNull();
    // Re-audit MINOR: the line never pairs kcal with more protein than that kcal can hold.
    // 222 / 4 = 55.5; rounding the capped grams (56) would claim 224 kcal of protein against 222
    // left, so the cap itself is floored to 55 (2026-10-05 audit, MINOR 6).
    expect(remainingLine({ kcal: 222, protein: 73.1, carbs: 0, fat: 0 }))
      .toBe("About 222 kcal · 55 g protein left today");
    expect(remainingLine({ kcal: 900, protein: 40, carbs: 80, fat: 20 }))
      .toBe("About 900 kcal · 40 g protein left today");
    // The displayed grams can never cost more kcal than are left, across a spread of kcal values.
    for (const kcal of [1, 2, 3, 4, 5, 6, 7, 198, 221, 222, 223, 500, 501, 502]) {
      const line = remainingLine({ kcal, protein: 9999, carbs: 0, fat: 0 });
      const grams = Number(line.match(/· (\d+) g/)?.[1] ?? NaN);
      expect(grams * 4).toBeLessThanOrEqual(kcal);
    }
    const room = { kcal: 500, protein: 1, carbs: 60, fat: 20 };
    // Protein is a floor: 30 g against 1 g left still fits.
    expect(fitLabel(fitToday({ kcal: 400, protein: 30, carbs: 40, fat: 12 }, room))).toBe("Fits today");
    expect(fitLabel(fitToday({ kcal: 800, protein: 30, carbs: 40, fat: 12 }, room))).toBe("~300 kcal over");
    expect(fitLabel(fitToday({ kcal: null, protein: 30 }, room))).toBeNull();
    expect(fitLabel(fitToday({ kcal: 400, protein: 30, carbs: 40, fat: 12 }, null))).toBeNull();
  });

  // 2026-10-04 audit (MINOR 9): a serving inside the kcal but far over the fat read "Fits today".
  it("checks fat and carbs as well as kcal, and never calls a serving with unknown macros a fit", () => {
    const room = { kcal: 500, protein: 1, carbs: 60, fat: 20 };
    expect(fitToday({ kcal: 450, protein: 10, carbs: 5, fat: 45 }, room)).toEqual({ kind: "over", by: 25, macro: "fat" });
    expect(fitLabel(fitToday({ kcal: 450, protein: 10, carbs: 5, fat: 45 }, room))).toBe("~25 g fat over");
    expect(fitLabel(fitToday({ kcal: 450, protein: 10, carbs: 100, fat: 2 }, room))).toBe("~40 g carbs over");
    expect(fitLabel(fitToday({ kcal: 900, protein: 10, carbs: 100, fat: 45 }, room))).toBe("~400 kcal over");
    expect(fitToday({ kcal: 400, protein: 30, carbs: null, fat: 10 }, room)).toEqual({ kind: "unknown" });
    // A serving whose protein is unknown is not a fit either (W058).
    expect(fitToday({ kcal: 400, protein: null, carbs: 40, fat: 10 }, room)).toEqual({ kind: "unknown" });
    // An unknown protein still reports a known overage.
    expect(fitToday({ kcal: 800, protein: null, carbs: 40, fat: 10 }, room)).toEqual({ kind: "over", by: 300, macro: "kcal" });
    expect(fitToday({ kcal: 400, protein: 30, carbs: null, fat: 30 }, room)).toEqual({ kind: "over", by: 10, macro: "fat" });
  });

  it("logs only a sized, allowed portion", () => {
    expect(portionToLog([{ foodRefId: "f", name: "lasagna", grams: 350, reason: null, verdict: "allowed" }]))
      .toBe("350 g lasagna");
    expect(portionToLog([{ foodRefId: null, name: "lasagna", grams: null, reason: null, verdict: "unverified" }]))
      .toBeNull();
    expect(portionToLog([{ foodRefId: "f", name: "peanut", grams: 30, reason: "allergen", verdict: "blocked" }]))
      .toBeNull();
  });

  it("asks for fitting recipes from each chip and searches the catalog the same way", () => {
    expect(chipPrompt("High protein")).toMatch(/fit my remaining macros\. Prioritize protein/);
    expect(hubSearchFor({ chip: "Under 30 min" })).toEqual({ query: "", maxMinutes: 30, limit: 3 });
    expect(hubSearchFor({ wish: "  hearty soup " })).toEqual({ query: "hearty soup", limit: 3 });
    expect(hubSearchFor({ chip: "Suggest a recipe" })).toEqual({ query: "", limit: 3 });
  });

  // 2026-10-04 audit (MAJOR 5): every other chip searched the same unfiltered three recipes.
  it("shows no catalog list under a chip whose filter the catalog search cannot hold", () => {
    for (const chip of ["High protein", "Comfort food", "Use what I have"] as const) {
      expect(hubSearchFor({ chip })).toBeNull();
    }
    expect(exampleAt(0)).toBe("I feel like Italian…");
    expect(exampleAt(5)).toBe("Something hearty, it’s cold");
  });
});
