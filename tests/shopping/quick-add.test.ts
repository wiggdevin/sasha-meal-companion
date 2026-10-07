import { describe, expect, it } from "vitest";
import { favoriteChips, listAsText, parseQuickAdd } from "@/lib/shopping/quick-add";
import type { ShoppingLine } from "@/lib/shopping/types";

const line = (over: Partial<ShoppingLine> & { name: string }): ShoppingLine => ({
  id: over.name, periodId: "p", origin: "manual", identity: null, category: "manual", needGrams: null,
  confirmedStockGrams: null, buyGrams: null, packageGrams: null, purchaseConversionStatus: "unknown",
  sources: [], pinned: false, checked: false, note: null, revision: 1, ...over,
});

describe("parseQuickAdd", () => {
  it("splits commas, semicolons and new lines into items, keeping each item's own words", () => {
    expect(parseQuickAdd("2 avocados, eggs; oat milk\nmac and cheese")).toEqual(
      ["2 avocados", "eggs", "oat milk", "mac and cheese"]);
  });

  it("drops blanks, trims, and keeps one of each item whatever its case", () => {
    expect(parseQuickAdd(" eggs ,, Eggs , ,bread ")).toEqual(["eggs", "bread"]);
  });

  it("skips an item already on the list", () => {
    expect(parseQuickAdd("eggs, milk", [line({ name: "Eggs" })])).toEqual(["milk"]);
  });

  it("caps one add at twenty items of at most 160 characters", () => {
    const many = Array.from({ length: 30 }, (_, i) => `item ${i}`).join(",");
    expect(parseQuickAdd(many)).toHaveLength(20);
    expect(parseQuickAdd("x".repeat(200))[0]).toHaveLength(160);
  });
});

describe("favoriteChips", () => {
  it("offers Favorites not already on the list, in their order, at most eight", () => {
    const names = ["Eggs, large", "Avocado", "Banana", "A", "B", "C", "D", "E", "F", "G"];
    const chips = favoriteChips(names, [line({ name: "avocado" })]);
    expect(chips[0]).toBe("Eggs");
    expect(chips).not.toContain("Avocado");
    expect(chips).toHaveLength(8);
  });
});

describe("favoriteChips names", () => {
  it("offers what you buy, not how it is cooked: one chip per food", () => {
    expect(favoriteChips(["Sirloin steak, cooked", "Canned salmon, drained", "Banana, medium", "Banana, raw",
      "Fat, beef tallow", "Avocado, Hass, peeled, raw", "Sweet potato, peeled & cooked"], []))
      .toEqual(["Sirloin steak", "Canned salmon", "Banana", "Fat, beef tallow", "Avocado, Hass", "Sweet potato"]);
  });
});

describe("listAsText", () => {
  it("lists what is still to buy first, with amounts, then what is in the cart", () => {
    const text = listAsText("Shopping 2 Oct – 8 Oct", [
      line({ name: "Rice", origin: "plan", category: "core", buyGrams: 400 }),
      line({ name: "Eggs", checked: true }),
      line({ name: "Oat milk" }),
    ]);
    expect(text).toBe("Shopping 2 Oct – 8 Oct\n\n☐ Rice — 400 g\n☐ Oat milk\n\nIn cart\n☑ Eggs");
  });
});
