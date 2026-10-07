/**
 * Owner decision (2026-10-02): "yes plain whole foods should be cleared" — a plain,
 * single-ingredient whole food clears for the allergens its own class cannot contain, and a
 * food's own NAME can escalate an allergen to blocked even with no ingredient text at all.
 *
 * Live evidence of the problem this closes: an account avoiding gluten and dairy got zero Eats
 * protein suggestions, because every protein ("Ahi tuna, cooked", "Chicken breast", ...) had
 * empty ingredient text, no tags, no category, and so read `no_evidence` — unverified — for both
 * allergens, even though plain fish and plain poultry cannot contain either one. Separately,
 * "Beverages, Protein powder whey based" read only "unverified" for dairy although whey IS dairy
 * and the product's own name said so.
 */
import { describe, expect, it } from "vitest";
import { allergenFinding } from "@/lib/policy/allergens";
import { EMPTY_PROFILE, evaluatePolicy } from "@/lib/policy/constraints";

describe("whole-food clearance (owner decision, 2026-10-02)", () => {
  it("clears a plain fish, poultry, grain and produce for gluten and dairy", () => {
    for (const foodName of ["Ahi tuna, cooked", "Chicken breast", "White rice", "Broccoli", "Apple"]) {
      expect(allergenFinding("gluten", { foodName })).toMatchObject({ outcome: "absent" });
      expect(allergenFinding("dairy", { foodName })).toMatchObject({ outcome: "absent" });
    }
  });

  it("never clears a food's own intrinsic allergen — its own name already blocks it (escalation " +
    "by name): a plain fish or shellfish food is 'present' for its own class, not merely " +
    "'unverified'", () => {
    expect(allergenFinding("fish", { foodName: "Ahi tuna, cooked" }))
      .toMatchObject({ outcome: "present", text: "Contains fish" });
    expect(allergenFinding("shellfish", { foodName: "Shrimp" }))
      .toMatchObject({ outcome: "present" });
    expect(allergenFinding("crustacean", { foodName: "Shrimp" }))
      .toMatchObject({ outcome: "present" });
  });

  it("keeps oats on the gluten mark: cross-contact is not cleared by the name alone", () => {
    expect(allergenFinding("gluten", { foodName: "Oats" }))
      .toMatchObject({ outcome: "unknown", checkable: true });
    expect(allergenFinding("gluten", { foodName: "Oats, gluten-free" }))
      .toMatchObject({ outcome: "absent" });
  });

  it("gives no clearance to a breaded, nugget, teriyaki or sausage name", () => {
    for (const foodName of
      ["Breaded chicken", "Chicken nuggets", "Teriyaki salmon", "Chicken sausage"]) {
      expect(allergenFinding("dairy", { foodName })).toMatchObject({ outcome: "unknown" });
    }
  });

  it("gives no clearance to a branded row", () => {
    expect(allergenFinding("dairy", { foodName: "Chicken breast", brand: "Perdue" }))
      .toMatchObject({ outcome: "unknown" });
  });

  // 2026-10-02 DeepSeek audit (HIGH, finding #2): a scanned barcode or label is packaged by
  // definition, whether or not the row happens to carry a brand string — a store-brand "Chicken
  // breast" with no visible brand text is still a packaged product, never a generic commodity.
  it("gives no clearance to a packaged lane even with no brand on the row", () => {
    expect(allergenFinding("dairy", { foodName: "Chicken breast", packaged: true }))
      .toMatchObject({ outcome: "unknown" });
  });

  // 2026-10-02 DeepSeek audit via Grok (finding C): tempeh's own name still escalates "Contains
  // soy" (allergens.ts's existing keyword table), but no longer clears gluten as a plain whole
  // food — commercial tempeh can be grain-inoculated.
  it("never clears gluten for tempeh, but still names it for soy by its own text", () => {
    expect(allergenFinding("gluten", { foodName: "Tempeh" })).toMatchObject({ outcome: "unknown" });
    expect(allergenFinding("soy", { foodName: "Tempeh" })).toMatchObject({ outcome: "present" });
  });

  it("gives no clearance to a food with its own ingredient list", () => {
    expect(allergenFinding("dairy",
      { foodName: "Chicken breast", ingredientsText: "Chicken, water, salt" }))
      .toMatchObject({ outcome: "unknown" });
  });

  it("a stored listed or label finding still wins over whole-food clearance", () => {
    expect(allergenFinding("gluten", { foodName: "Apple",
      stored: { level: "listed", labelComplete: true } }))
      .toMatchObject({ outcome: "present" });
    expect(allergenFinding("dairy", { foodName: "Broccoli",
      stored: { level: "not_listed", labelComplete: true } }))
      .toMatchObject({ outcome: "absent", text: "No dairy listed on the label" });
  });
});

describe("escalation by name (owner decision, 2026-10-02)", () => {
  it("blocks whey and casein protein powders for a dairy avoid with no ingredient text at all", () => {
    expect(allergenFinding("dairy", { foodName: "Beverages, Protein powder whey based" }))
      .toMatchObject({ outcome: "present", text: "Contains dairy" });
    expect(allergenFinding("dairy", { foodName: "Beverages, Whey protein powder isolate" }))
      .toMatchObject({ outcome: "present", text: "Contains dairy" });
  });

  it("blocks other major-allergen names the same way: egg, peanut, soy, shrimp", () => {
    expect(allergenFinding("egg", { foodName: "Egg white protein powder" }))
      .toMatchObject({ outcome: "present" });
    expect(allergenFinding("peanut", { foodName: "Peanut butter powder" }))
      .toMatchObject({ outcome: "present" });
    expect(allergenFinding("soy", { foodName: "Soy protein isolate" }))
      .toMatchObject({ outcome: "present" });
    expect(allergenFinding("shellfish", { foodName: "Shrimp flavor seasoning mix" }))
      .toMatchObject({ outcome: "present" });
  });

  it("a name with no allergen word keeps today's behavior: no evidence, no escalation", () => {
    expect(allergenFinding("dairy", { foodName: "Vanilla extract" }))
      .toMatchObject({ outcome: "unknown" });
  });

  it("reads a food's name without inventing dairy: cream of wheat and plant milks", () => {
    for (const foodName of ["Cream of wheat", "Oat milk", "Almond milk", "Coconut milk"]) {
      expect(allergenFinding("dairy", { foodName }).outcome, foodName).not.toBe("present");
    }
    expect(allergenFinding("gluten", { foodName: "Cream of wheat" }).outcome).toBe("present");
    expect(allergenFinding("dairy", { foodName: "Rice, white, long-grain, regular, enriched, cooked" }).outcome).toBe("absent");
  });

  // Live trace 2026-10-02: the composer fills fat first, and no fat on a gluten- and dairy-free
  // account ever cleared, so every suggestion card was hidden. Avocado and plain olive or avocado
  // oil cannot contain either; a seed or nut oil keeps its own allergen by staying uncleared.
  it("clears avocado and plain olive or avocado oil, and never a nut, seed or soy oil", () => {
    for (const foodName of ["Avocados, raw", "Avocado", "Olive oil", "Extra virgin olive oil", "Avocado oil"]) {
      expect(allergenFinding("gluten", { foodName })).toMatchObject({ outcome: "absent" });
      expect(allergenFinding("dairy", { foodName })).toMatchObject({ outcome: "absent" });
    }
    for (const foodName of ["Peanut oil", "Sesame oil", "Soybean oil", "Walnut oil", "Garlic oil"]) {
      expect(allergenFinding("gluten", { foodName }).outcome).not.toBe("absent");
    }
    expect(allergenFinding("dairy", { foodName: "Olive oil", packaged: true }).outcome).not.toBe("absent");
  });
});

/**
 * Live check 2026-10-02: a user's own food carries no stored policy category, so "Black beans"
 * passed an account that bans beans once whole-food clearance had cleared its allergens. With no
 * stored category, the food's name is categorised by the catalog's own rules.
 */
describe("banned categories with no stored category", () => {
  const profile = { ...EMPTY_PROFILE, avoid_allergens: ["gluten", "dairy"],
    banned_categories: ["beans", "onion_garlic", "simple_sugars"] };
  const judge = (foodName: string, category: string[] | null = null) => evaluatePolicy(profile, {
    foodRefId: null, allergenTags: [], foodName, category, onEatsList: true, onAvoidList: false,
  });

  it("blocks a banned food read from its own name", () => {
    expect(judge("Black beans").verdict).toBe("blocked");
    expect(judge("Garlic").verdict).toBe("blocked");
  });

  it("keeps an allowed whole food allowed, and a stored category still wins", () => {
    expect(judge("Banana, medium").verdict).toBe("allowed");
    expect(judge("Black beans", []).verdict).toBe("allowed");
  });
});

/** Grok audit round 5: oats' cross-contact is wheat as well as gluten (HIGH); frozen yogurt is a
 *  formulated dessert and dried meat is cured with soy or wheat, not plain foods (HIGH). */
describe("whole-food clearance edges (Grok audit, 2026-10-02)", () => {
  it("keeps plain oats unverified for wheat, unless they carry a gluten-free claim", () => {
    for (const foodName of ["Rolled oats", "Oatmeal", "Steel-cut oats"]) {
      expect(allergenFinding("wheat", { foodName }).outcome).not.toBe("absent");
    }
    expect(allergenFinding("wheat", { foodName: "Oats, gluten-free" })).toMatchObject({ outcome: "absent" });
  });

  it("never clears frozen yogurt or dried meat as a plain food", () => {
    for (const foodName of ["Yogurt, frozen", "Yogurt frozen", "Frozen yogurt"]) {
      expect(allergenFinding("gluten", { foodName }).outcome).not.toBe("absent");
    }
    for (const foodName of ["Beef, dried", "Chicken, dried", "Dried beef"]) {
      expect(allergenFinding("soy", { foodName }).outcome).not.toBe("absent");
      expect(allergenFinding("wheat", { foodName }).outcome).not.toBe("absent");
    }
    // A frozen vegetable or fruit and a dried fruit stay plain foods.
    expect(allergenFinding("dairy", { foodName: "Broccoli, frozen" })).toMatchObject({ outcome: "absent" });
    expect(allergenFinding("dairy", { foodName: "Apricots, dried" })).toMatchObject({ outcome: "absent" });
  });
});

/** 2026-10-03 coach reliability sweep (item B): live catalog and custom names on one account's
 *  Eats list read "Check the label" although each is one plain food. */
describe("whole-food clearance for catalog variety names (2026-10-03)", () => {
  it("clears plain foods named with 'without sauce', a variety, an origin or a parenthetical", () => {
    for (const foodName of [
      "Chicken breast, grilled without sauce, skin eaten",
      "Chicken breast, grilled without sauce, skin not eaten",
      "Chicken thigh, grilled without sauce, skin not eaten",
      "Avocado, Hass, peeled, raw",
      "Scallops, bay, Patagonian, frozen, wild caught",
      "Scallops, sea, frozen, wild caught",
      "Melon (cantaloupe)",
      "Melons, cantaloupe, raw",
      "Melons, honeydew, raw",
    ]) {
      expect(allergenFinding("gluten", { foodName }), foodName).toMatchObject({ outcome: "absent" });
      expect(allergenFinding("dairy", { foodName }), foodName).toMatchObject({ outcome: "absent" });
    }
    // A scallop keeps its own class mark, however it is named.
    expect(allergenFinding("shellfish", { foodName: "Scallops, bay, Patagonian, frozen, wild caught" }))
      .toMatchObject({ outcome: "present" });
  });

  it("never clears a sauced, breaded, soup, broth, jerky or cured food", () => {
    for (const foodName of [
      "Chicken breast, with sauce",
      "Chicken breast, grilled with sauce, skin eaten",
      "Chicken breast, grilled without sauce, breaded",
      "Chicken breast, grilled without sauce, with gravy",
      "Chicken breast without sauce, teriyaki",
      "Chicken, in sauce",
      "Scallops, bay, breaded, fried",
      "Scallops, bay, in sauce",
      "Melon (in syrup)",
      "Melon (cantaloupe soup)",
      "Avocado, Hass, guacamole",
      "Soup, beef",
      "Chicken broth",
      "Broth, chicken, without sauce",
      "Beef jerky",
      "Prosciutto",
      "Ham, cured",
      "Fat, beef tallow",
      "Sweet potato, candied",
      "Avocado, for use on a sandwich",
    ]) {
      expect(allergenFinding("gluten", { foodName }).outcome, foodName).not.toBe("absent");
      expect(allergenFinding("dairy", { foodName }).outcome, foodName).not.toBe("absent");
    }
  });

  it("never clears a parenthetical that names another food or a preparation (Grok)", () => {
    for (const foodName of ["Apples (coconut, raw)", "Melon (peanut)", "Avocado (with walnuts)",
      "Scallops (breaded)", "Melon (coconut)", "Avocado (coconut)"]) {
      for (const allergen of ["tree-nut", "peanut", "gluten", "dairy"]) {
        expect(allergenFinding(allergen, { foodName }).outcome, `${foodName} ${allergen}`)
          .not.toBe("absent");
      }
    }
  });

  it("keeps every named food's own allergen, not just the head's", () => {
    expect(allergenFinding("tree-nut", { foodName: "Apples, coconut, raw" }).outcome).not.toBe("absent");
    expect(allergenFinding("tree-nut", { foodName: "Melon (cantaloupe)" })).toMatchObject({ outcome: "absent" });
  });

  it("keeps variety words scoped to their own class", () => {
    // "Sea" sizes a scallop; a sea cucumber is an animal, never a plain vegetable.
    expect(allergenFinding("dairy", { foodName: "Cucumbers, sea" }).outcome).not.toBe("absent");
    expect(allergenFinding("dairy", { foodName: "Chicken, bay" }).outcome).not.toBe("absent");
    expect(allergenFinding("dairy", { foodName: "Scallops, hass" }).outcome).not.toBe("absent");
  });
});

/** DeepSeek audit round 6 (MED): the name-derived category list is for the banned-category check
 *  only. Read as preference evidence it said "no onion, garlic or beans" for a low-FODMAP account
 *  on the strength of a name like "Meatballs". */
describe("name categories never clear a preference", () => {
  it("keeps an uncategorised food unverified for low FODMAP", () => {
    const verdict = evaluatePolicy({ ...EMPTY_PROFILE }, {
      foodRefId: null, allergenTags: [], foodName: "Meatballs", category: null,
      onEatsList: true, onAvoidList: false, preferenceFlags: ["low_fodmap"],
    }).verdict;
    expect(verdict).toBe("unverified");
  });
});

it("reads a baked fruit as a dish, like baked apples: never a plain whole food", () => {
  for (const foodName of ["Banana, baked", "Bananas, baked", "Pears, baked", "Peaches, baked"]) {
    expect(allergenFinding("gluten", { foodName }).outcome).not.toBe("absent");
  }
});

it("reads any cooked fruit as a dish, not only the ones named (DeepSeek audit round 7)", () => {
  for (const foodName of ["Apricots, baked", "Cherries, baked", "Figs, roasted", "Mango, grilled", "Pears, poached"]) {
    expect(allergenFinding("dairy", { foodName }).outcome).not.toBe("absent");
  }
  for (const foodName of ["Apricots, dried", "Mango, raw", "Cherries, frozen"]) {
    expect(allergenFinding("dairy", { foodName })).toMatchObject({ outcome: "absent" });
  }
});
