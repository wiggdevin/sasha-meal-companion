/**
 * Owner decision (2026-10-02): plain whole foods clear for the allergens their class
 * cannot contain. These are the classifier's own unit tests; tests/policy/allergen-evidence.test.ts
 * covers the integration into `allergenFinding`.
 */
import { describe, expect, it } from "vitest";
import { classifyWholeFood } from "@/lib/policy/whole-foods";

describe("classifyWholeFood", () => {
  it("matches a plain fish and carries only fish as intrinsic", () => {
    expect(classifyWholeFood({ foodName: "Ahi tuna, cooked" }))
      .toEqual({ label: "fish", intrinsic: ["fish"] });
    expect(classifyWholeFood({ foodName: "Salmon" }))
      .toEqual({ label: "fish", intrinsic: ["fish"] });
  });

  it("matches plain poultry, red meat, vegetables, fruit and gluten-free grain with no intrinsic allergen", () => {
    expect(classifyWholeFood({ foodName: "Chicken breast" })).toEqual({ label: "poultry", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Ground beef" })).toEqual({ label: "red meat", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Broccoli" })).toEqual({ label: "vegetables", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Apple" })).toEqual({ label: "fruit", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "White rice" })).toEqual({ label: "grain", intrinsic: [] });
  });

  it("matches shellfish with both shellfish and crustacean intrinsic", () => {
    expect(classifyWholeFood({ foodName: "Shrimp" }))
      .toEqual({ label: "shellfish", intrinsic: ["shellfish", "crustacean"] });
  });

  it("keeps oats on the gluten and wheat marks unless the name itself claims gluten-free", () => {
    expect(classifyWholeFood({ foodName: "Oats" })).toEqual({ label: "oats", intrinsic: ["gluten", "wheat"] });
    expect(classifyWholeFood({ foodName: "Oats, gluten-free" }))
      .toEqual({ label: "oats", intrinsic: [] });
  });

  it("keeps wheat-family grains intrinsic to gluten and wheat", () => {
    expect(classifyWholeFood({ foodName: "Barley" }))
      .toEqual({ label: "grain", intrinsic: ["gluten", "wheat"] });
  });

  it("clears tree nuts, peanuts, sesame, soy and legumes for everything but their own allergen", () => {
    expect(classifyWholeFood({ foodName: "Almonds" })).toEqual({ label: "tree nuts", intrinsic: ["tree-nut"] });
    expect(classifyWholeFood({ foodName: "Peanuts" })).toEqual({ label: "peanuts", intrinsic: ["peanut"] });
    expect(classifyWholeFood({ foodName: "Sesame seeds" })).toEqual({ label: "sesame", intrinsic: ["sesame"] });
    expect(classifyWholeFood({ foodName: "Tofu" })).toEqual({ label: "soy", intrinsic: ["soy"] });
    expect(classifyWholeFood({ foodName: "Black beans" })).toEqual({ label: "legume", intrinsic: [] });
  });

  it("gives no clearance to a prepared or compound name", () => {
    expect(classifyWholeFood({ foodName: "Breaded chicken" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Chicken nuggets" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Teriyaki salmon" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Chicken sausage" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Chicken and rice" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Beef with gravy" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Protein powder, whey based" })).toBeNull();
  });

  // 2026-10-02 DeepSeek audit (finding #2): a packaged lane never gets whole-food clearance,
  // even when the row has no brand string of its own.
  it("gives no clearance to a packaged row, even with no brand", () => {
    expect(classifyWholeFood({ foodName: "Chicken breast", packaged: true })).toBeNull();
  });

  it("gives no clearance to a branded row or a name outside the table", () => {
    expect(classifyWholeFood({ foodName: "Chicken breast", brand: "Perdue" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Unicorn jerky" })).toBeNull();
    expect(classifyWholeFood({ foodName: null })).toBeNull();
    expect(classifyWholeFood({ foodName: "" })).toBeNull();
  });

  it("gives no clearance to a food with a multi-item ingredient list", () => {
    expect(classifyWholeFood({ foodName: "Chicken breast", ingredientsText: "Chicken, water, salt" }))
      .toBeNull();
  });

  it("tolerates a single-item ingredient statement that just repeats the food", () => {
    expect(classifyWholeFood({ foodName: "Broccoli", ingredientsText: "Broccoli" }))
      .toEqual({ label: "vegetables", intrinsic: [] });
  });

  // The catalog names commodity foods with comma descriptors ("Rice, white, long-grain, cooked"),
  // and the owner named rice among the foods that must clear (2026-10-02).
  it("reads catalog comma names by their head food", () => {
    for (const name of ["Rice, white, long-grain, regular, enriched, cooked", "Jasmine rice, cooked",
      "Rice, brown, medium-grain, cooked", "Fish, tuna, yellowfin, fresh, cooked",
      "Chicken, broilers or fryers, breast, meat only, cooked, roasted"]) {
      expect(classifyWholeFood({ foodName: name }), name).not.toBeNull();
    }
    expect(classifyWholeFood({ foodName: "Fish, tuna, yellowfin, fresh, cooked" })?.intrinsic).toEqual(["fish"]);
    for (const name of ["Rice, white, with pasta, cooked", "Chicken, breast, fried, batter",
      "Beef, ground, 85% lean, patty, cooked", "Tuna, light, canned in water"]) {
      expect(classifyWholeFood({ foodName: name }), name).toBeNull();
    }
  });

  it("knows common steak cuts are plain beef", () => {
    for (const name of ["Sirloin steak, cooked", "Ribeye steak, grilled", "Flank steak"]) {
      expect(classifyWholeFood({ foodName: name })?.label, name).toBe("red meat");
    }
  });

  // 2026-10-02 DeepSeek audit (HIGH, whole-foods.ts ~145-156): the comma-head fallback used to
  // accept the head word alone and silently discard every OTHER segment — "Fish, fish sticks,
  // frozen, prepared" read as plain "fish" and cleared for gluten even though it is breaded. A
  // descriptor outside the plain-descriptor whitelist, and not itself a match for the head's own
  // class, must block the whole-food reading.
  it("never clears a comma name whose non-head segment is not a plain descriptor", () => {
    for (const name of ["Fish, fish sticks, frozen, prepared", "Chicken, rotisserie",
      "Fish, sticks", "Beans, refried"]) {
      expect(classifyWholeFood({ foodName: name }), name).toBeNull();
    }
  });

  it("still clears catalog comma names whose extra segments are plain descriptors", () => {
    expect(classifyWholeFood({ foodName: "Rice, white, long-grain, regular, enriched, cooked" }))
      .toEqual({ label: "grain", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Fish, tuna, yellowfin, fresh, cooked" }))
      .toEqual({ label: "fish", intrinsic: ["fish"] });
    expect(classifyWholeFood({
      foodName: "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
    })).toEqual({ label: "poultry", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Jasmine rice, cooked" }))
      .toEqual({ label: "grain", intrinsic: [] });
  });

  // 2026-10-02 DeepSeek audit via Grok (BLOCK): normalize() used to delete a cooking-state word
  // from ANYWHERE in the name, so a prefix that actually names the dish ("baked" in "baked beans",
  // a canned bean dish in tomato sauce) was stripped away just like a genuine trailing doneness
  // word, leaving a bare food word that matched its class. Cooking-state words are now stripped
  // only from the end of the full name, or as their own comma segment — never from the middle or
  // the front of a multi-word phrase.
  it("never clears a dish name formed by a leading cooking-state word", () => {
    for (const name of ["Baked beans", "Roasted chicken breast", "Grilled cheese"]) {
      expect(classifyWholeFood({ foodName: name }), name).toBeNull();
    }
  });

  it("still clears a comma-form cooking word and a genuine trailing one", () => {
    expect(classifyWholeFood({ foodName: "Potato, baked" })).toEqual({ label: "potato", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Salmon, baked" })).toEqual({ label: "fish", intrinsic: ["fish"] });
  });

  // 2026-10-02 DeepSeek audit via Grok (HIGH): hasMultiItemIngredientList only ever split on
  // commas, so a single-item ingredient line that does NOT repeat the food itself ("Soy sauce",
  // "Breadcrumbs" against a "Chicken breast" name) was not treated as disqualifying.
  it("gives no clearance when the single ingredient line names something other than the food", () => {
    expect(classifyWholeFood({ foodName: "Chicken breast", ingredientsText: "Soy sauce" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Chicken breast", ingredientsText: "Breadcrumbs" })).toBeNull();
  });

  // 2026-10-02 DeepSeek audit via Grok (finding C): commercial tempeh can carry barley, so it is
  // no longer read as a plain single-ingredient soy food (the "Contains soy" escalation by name in
  // lib/policy/allergens.ts still fires independently — tempeh is one of its own keywords).
  it("never clears tempeh as a plain whole food", () => {
    expect(classifyWholeFood({ foodName: "Tempeh" })).toBeNull();
  });

  it("names potatoes and corn as themselves, not as grain", () => {
    expect(classifyWholeFood({ foodName: "Sweet potato, baked" })?.label).toBe("potato");
    expect(classifyWholeFood({ foodName: "Potatoes, baked" })?.label).toBe("potato");
    expect(classifyWholeFood({ foodName: "Corn" })?.label).toBe("corn");
  });

  // 2026-10-02 DeepSeek audit round 3 (F4, MED): the app's own catalog data names plain foods the
  // comma-head fallback still can't read — a missing cooking-state word (broiled, braised,
  // hard-boiled, pan-fried, dry heat), a two-word descriptor (wild sockeye, Atlantic farmed, with
  // skin), a lean ratio ("90/10"), and a `with`/`and` segment the old global COMPOUND check killed
  // before the segment whitelist ever ran ("Potato, baked, WITH SKIN" has "with" in it).
  it("clears the app's own catalog names the comma fallback used to miss (F4)", () => {
    expect(classifyWholeFood({ foodName: "Ground beef 90/10, cooked" }))
      .toEqual({ label: "red meat", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Salmon, wild sockeye, cooked" }))
      .toEqual({ label: "fish", intrinsic: ["fish"] });
    expect(classifyWholeFood({ foodName: "Salmon, Atlantic farmed, cooked" }))
      .toEqual({ label: "fish", intrinsic: ["fish"] });
    expect(classifyWholeFood({ foodName: "Fish, salmon, Atlantic, farmed, cooked, dry heat" }))
      .toEqual({ label: "fish", intrinsic: ["fish"] });
    expect(classifyWholeFood({ foodName: "Potato, baked, with skin" }))
      .toEqual({ label: "potato", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Apple, with skin" }))
      .toEqual({ label: "fruit", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Broccoli, cooked, boiled, drained, without salt" }))
      .toEqual({ label: "vegetables", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Chicken, ground, raw" }))
      .toEqual({ label: "poultry", intrinsic: [] });
    expect(classifyWholeFood({ foodName: "Egg, hard-boiled" }))
      .toEqual({ label: "egg", intrinsic: ["egg"] });
    expect(classifyWholeFood({ foodName: "Tofu, firm" }))
      .toEqual({ label: "soy", intrinsic: ["soy"] });
  });

  // Every previous null case stays null — the fix widens what a comma segment can be, it never
  // loosens the head match or the PREPARED/disqualifying-ingredient gates.
  it("still gives no clearance to the previous null cases (F4 regression guard)", () => {
    for (const name of ["Fish, fish sticks, frozen, prepared", "Chicken, rotisserie",
      "Fish, sticks", "Beans, refried", "Breaded chicken", "Chicken nuggets",
      "Teriyaki salmon", "Chicken sausage", "Chicken and rice", "Beef with gravy",
      "Protein powder, whey based", "Baked beans", "Roasted chicken breast", "Grilled cheese",
      "Rice, white, with pasta, cooked", "Chicken, breast, fried, batter",
      "Beef, ground, 85% lean, patty, cooked", "Tuna, light, canned in water"]) {
      expect(classifyWholeFood({ foodName: name }), name).toBeNull();
    }
  });

  // Owner's call, fail closed when unsure (F4): "meat and skin" is ambiguous enough on its own —
  // left uncleared rather than special-cased.
  it("does not clear 'meat and skin' — left uncleared, fail closed", () => {
    expect(classifyWholeFood({ foodName: "Chicken, meat and skin, cooked, roasted" })).toBeNull();
  });

  // 2026-10-02 DeepSeek audit round 3 (F5, LOW): a comma-form cooking word that names a DISH, not
  // a doneness, must still be read as prepared — "baked" strips to "" as a bare cooking-state
  // segment, but "beans, baked" / "apples, baked" are baked beans and baked apples, not plain
  // legumes or fruit.
  it("never clears 'beans, baked' or 'apples, baked' as plain whole foods (F5)", () => {
    expect(classifyWholeFood({ foodName: "Beans, baked" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Apples, baked" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Bean, baked" })).toBeNull();
    expect(classifyWholeFood({ foodName: "Apple, baked" })).toBeNull();
  });

  // 2026-10-02 DeepSeek audit round 3 (F6, LOW): FDA lists coconut among tree nuts for labelling —
  // fail closed and never clear tree-nut for a plain "Coconut".
  it("keeps coconut intrinsic to tree-nut (F6, FDA labelling)", () => {
    expect(classifyWholeFood({ foodName: "Coconut" }))
      .toEqual({ label: "fruit", intrinsic: ["tree-nut"] });
    expect(classifyWholeFood({ foodName: "Coconuts" })?.intrinsic).toContain("tree-nut");
    // Every other fruit in the class keeps its existing, unaffected clearance.
    expect(classifyWholeFood({ foodName: "Apple" })).toEqual({ label: "fruit", intrinsic: [] });
  });
});

