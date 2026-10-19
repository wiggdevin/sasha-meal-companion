import { describe, expect, it } from "vitest";
import { AISLES, aisleLabel, aisleOf, aisleRank, groupByAisle, type Aisle } from "@/lib/foods/aisle";

describe("AISLES", () => {
  it("lists every aisle once, in the fixed shop order, each with a label", () => {
    expect(AISLES.map((row) => row.id)).toEqual(
      ["produce", "protein", "dairy_eggs", "grains", "pantry", "drinks", "other"]);
    for (const row of AISLES) expect(row.label.length).toBeGreaterThan(0);
    expect(aisleLabel("dairy_eggs")).toBe("Dairy and eggs");
    expect(aisleRank("produce")).toBeLessThan(aisleRank("other"));
  });
});

describe("aisleOf", () => {
  it("takes a bundled row's category by id", () => {
    const cases: [string, Aisle][] = [
      ["butternut-squash-baked", "produce"], ["apple-with-skin", "produce"],
      ["chicken-breast-roasted", "protein"], ["whole-milk", "dairy_eggs"],
      ["almond-milk-unsweetened", "dairy_eggs"], ["white-rice-cooked", "grains"],
      ["butter", "pantry"], ["ketchup", "pantry"], ["ice-cream-vanilla", "pantry"],
      ["coffee-black", "drinks"], ["lasagna", "other"],
    ];
    for (const [bundledId, aisle] of cases) expect(aisleOf({ name: "x", bundledId })).toBe(aisle);
  });

  it("takes a row's category by exact name, ignoring case and spacing", () => {
    expect(aisleOf({ name: "Whole milk" })).toBe("dairy_eggs");
    expect(aisleOf({ name: "  apple,   WITH skin " })).toBe("produce");
    expect(aisleOf({ name: "Espresso", role: "fat" })).toBe("drinks");
  });

  it("prefers the bundled id over the name", () => {
    expect(aisleOf({ name: "Whole milk", bundledId: "ketchup" })).toBe("pantry");
  });

  it("falls back to an unknown id's name", () => {
    expect(aisleOf({ name: "Whole milk", bundledId: "no-such-id" })).toBe("dairy_eggs");
  });

  it("reads a curated meal family as protein when the database has no row", () => {
    expect(aisleOf({ name: "Grilled tofu skewers" })).toBe("protein");
    expect(aisleOf({ name: "Smoked salmon bagel", role: "carb" })).toBe("protein");
  });

  it("then uses the stored role, then other", () => {
    expect(aisleOf({ name: "Mystery grain blend", role: "carb" })).toBe("grains");
    expect(aisleOf({ name: "Mystery spread", role: "fat" })).toBe("pantry");
    expect(aisleOf({ name: "Mystery bar", role: "protein" })).toBe("protein");
    expect(aisleOf({ name: "Mystery thing" })).toBe("other");
    expect(aisleOf({ name: "Mystery thing", role: "unknown" })).toBe("other");
    expect(aisleOf({ name: "" })).toBe("other");
  });
});

describe("groupByAisle", () => {
  it("groups in AISLES order, keeps item order inside a group and drops empty aisles", () => {
    const names = ["Coffee, black", "Whole milk", "Apple, with skin", "2% milk", "Butternut squash, baked"];
    const groups = groupByAisle(names, (name) => aisleOf({ name }));
    expect(groups.map((group) => group.aisle)).toEqual(["produce", "dairy_eggs", "drinks"]);
    expect(groups[0].items).toEqual(["Apple, with skin", "Butternut squash, baked"]);
    expect(groups[1]).toEqual({ aisle: "dairy_eggs", label: "Dairy and eggs", items: ["Whole milk", "2% milk"] });
  });
});
