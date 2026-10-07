/**
 * The rule table, measured against the panel's stated ground truth (round 1, 2026-09-17). Every
 * row named in their false-positive and missed-positive lists is a case here, so a rule change
 * that re-breaks one of them fails before the sample is re-run.
 */
import { describe, expect, it } from "vitest";
import { POLICY_CATEGORY_KEYS, policyCategoriesFor } from "./category-map";

/**
 * A catalog revision as the annotator reads it. `source` is NOT an input: the rules read the
 * description and the provider category only, so a branded row and a USDA row with the same words
 * get the same answer.
 */
function rev(description: string, category: string | null = null) {
  return { description, category };
}

describe("POLICY_CATEGORY_KEYS", () => {
  it("is the five keys the Avoids switches name", () => {
    expect(POLICY_CATEGORY_KEYS).toEqual([
      "raw_cruciferous", "raw_leafy_greens", "onion_garlic", "beans", "simple_sugars",
    ]);
  });
});

describe("raw_cruciferous", () => {
  it("matches a raw cruciferous vegetable", () => {
    for (const d of ["Broccoli, raw", "Cauliflower, raw", "Cabbage, red, raw",
      "Brussels sprouts, raw", "Kale, raw", "Arugula, raw", "Bok choy, raw",
      "Radishes, raw", "Collards, raw", "Kohlrabi, raw", "Turnip greens, raw",
      "Watercress, raw"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .toContain("raw_cruciferous");
    }
  });

  it("matches a row that never says raw but names no preparation either", () => {
    for (const d of ["Radish", "Broccoli salad", "Cabbage, green", "Broccoli slaw"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .toContain("raw_cruciferous");
    }
  });

  it("never matches a cooked, boiled, steamed or roasted preparation", () => {
    for (const d of ["Broccoli, cooked, boiled, drained, without salt",
      "Cabbage, steamed, raw weight basis", "Cauliflower, roasted, raw as purchased",
      "Brussels sprouts, frozen, boiled, drained"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .not.toContain("raw_cruciferous");
    }
  });

  it("never matches a preserved or composed row", () => {
    for (const d of ["Broccoli, frozen, chopped, unprepared", "Broccoli cheese soup",
      "Kale chips", "Cabbage, canned", "Cauliflower, dehydrated", "Beef and broccoli",
      "Chicken and broccoli stir fry", "Cabbage rolls with beef and rice"]) {
      expect(policyCategoriesFor(rev(d))).toEqual([]);
    }
  });

  it("never matches a pickled, salted or fermented preparation — round 2's false positives", () => {
    for (const d of ["Pickles, chowchow, with cauliflower onion mustard, sweet",
      "Cabbage, mustard, salted", "Cabbage, fermented", "Radishes, brined",
      "Cauliflower, pickled"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .not.toContain("raw_cruciferous");
    }
  });
});

describe("raw_leafy_greens", () => {
  it("matches a raw leafy green", () => {
    for (const d of ["Lettuce, cos or romaine, raw", "Lettuce, iceberg (includes crisphead), raw",
      "Spinach, raw", "Chard, swiss, raw", "Endive, raw", "Escarole, raw",
      "Mesclun, raw", "Salad greens, mixed, raw"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .toContain("raw_leafy_greens");
    }
  });

  it("matches the greens the panel reported missing", () => {
    for (const d of ["Spinach, baby", "Spinach, mature", "Arugula, raw", "Beet greens, raw",
      "Dandelion greens, raw", "Cress, raw", "Watercress, raw", "Spring mix",
      "Caesar salad, with romaine, no dressing"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .toContain("raw_leafy_greens");
    }
  });

  it("does not match the cooked, creamed or composed version", () => {
    for (const d of ["Spinach, cooked, boiled, drained, without salt", "Creamed spinach",
      "Spinach souffle", "Spinach artichoke dip", "Spinach, canned, drained",
      "Spinach and chicken pasta", "Lettuce wrap with beef"]) {
      expect(policyCategoriesFor(rev(d))).not.toContain("raw_leafy_greens");
    }
  });

  it("does not match a pasta, a dressing or a seaweed that names a green", () => {
    for (const d of ["Spaghetti, spinach, dry", "Macaroni, spinach, dry",
      "Salad dressing, spinach", "Seaweed, sea lettuce, raw"]) {
      expect(policyCategoriesFor(rev(d))).not.toContain("raw_leafy_greens");
    }
  });

  it("does not match a sandwich that merely contains lettuce", () => {
    for (const d of ["SUBWAY, SUBWAY CLUB sub on white bread with lettuce and tomato",
      "SUBWAY, cold cut sub on white bread with lettuce and tomato",
      "Sandwich, turkey, on wheat bread with lettuce",
      "Cheeseburger, with lettuce and tomato"]) {
      expect(policyCategoriesFor(rev(d))).not.toContain("raw_leafy_greens");
    }
  });

  it("still matches a row that denies a dressing rather than carrying one", () => {
    expect(policyCategoriesFor(rev("Caesar salad, with romaine, no dressing")))
      .toContain("raw_leafy_greens");
  });
});

describe("onion_garlic", () => {
  it("matches the allium as a food, however it is prepared", () => {
    for (const d of ["Onions, raw", "Garlic, raw", "Shallots, raw",
      "Leeks, (bulb and lower leaf-portion), raw", "Onions, spring or scallions, raw",
      "Chives, raw", "Onion rings", "Garlic bread", "Onion dip",
      "Soup, French onion, canned", "Garlic sauce", "Shallots, freeze-dried"]) {
      expect(policyCategoriesFor(rev(d))).toContain("onion_garlic");
    }
  });

  it("does not match a flavour name — the panel's false positives", () => {
    for (const r of [
      rev("Snacks, corn-based, extruded, onion-flavor", "Snacks"),
      rev("Snacks, potato chips, sour-cream-and-onion-flavor", "Snacks"),
      rev("HORMEL ALWAYS TENDER, Pork Loin Filets, Lemon Garlic-Flavored", null),
      rev("Onion flavored rings", "Snacks"),
      rev("Potato chips, sour cream and onion flavored", "Snacks"),
      rev("Potato chips, ruffled, sour cream and onion flavored", "Snacks"),
      rev("Snacks, FRITOLAY, SUNCHIPS, multigrain, French onion flavor", "Snacks"),
    ]) {
      expect(policyCategoriesFor(r)).not.toContain("onion_garlic");
    }
  });

  it("does not match a composed pickle — the onion is in an ingredient list, not the name", () => {
    for (const d of ["Pickles, chowchow, with cauliflower onion mustard, sweet",
      "Relish, onion", "Pickles, dill, with garlic"]) {
      expect(policyCategoriesFor(rev(d))).not.toContain("onion_garlic");
    }
  });

  it("still matches the allium itself when IT is what was pickled", () => {
    for (const d of ["Pickled onions", "Pickled garlic", "Onions, pickled"]) {
      expect(policyCategoriesFor(rev(d))).toContain("onion_garlic");
    }
  });

  it("does not match a powder, salt or granule — those are seasonings, not the food", () => {
    for (const d of ["Onion powder", "Garlic powder", "Garlic salt", "Onion salt",
      "Garlic, granulated"]) {
      expect(policyCategoriesFor(rev(d, "Spices and Herbs"))).not.toContain("onion_garlic");
    }
  });
});

describe("beans", () => {
  it("matches the pulse and dishes named after it", () => {
    for (const r of [
      rev("Beans, black, mature seeds, cooked, boiled, without salt", "Legumes and Legume Products"),
      rev("Lentils, raw", "Legumes and Legume Products"),
      rev("Chickpeas (garbanzo beans), mature seeds, canned", "Legumes and Legume Products"),
      rev("Peas, split, mature seeds, raw", "Legumes and Legume Products"),
      rev("Beans, baked, canned, plain", "Legumes and Legume Products"),
      rev("Soup, bean with bacon, canned", "Soups, Sauces, and Gravies"),
      rev("Vegetables, mixed, with lima beans, frozen", "Vegetables and Vegetable Products"),
    ]) {
      expect(policyCategoriesFor(r)).toContain("beans");
    }
  });

  it("does not match a green pea — the panel's false positives", () => {
    for (const d of ["Green peas, raw", "Green peas, cooked, from restaurant",
      "Green peas, fresh, cooked, no added fat", "Green peas, frozen, cooked, no added fat",
      "Peas, green, raw", "Peas, cooked, from restaurant"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .not.toContain("beans");
    }
  });

  it("keeps tofu, tempeh, hummus and refried beans allowed — the coach's call", () => {
    for (const d of ["Tofu, raw, firm, prepared with calcium sulfate", "Hummus, commercial",
      "Tempeh", "Beans, refried, canned, traditional style"]) {
      expect(policyCategoriesFor(rev(d, "Legumes and Legume Products"))).not.toContain("beans");
    }
  });

  it("does not match a bean that is not a legume", () => {
    for (const d of ["Vanilla beans", "Coffee beans, roasted", "Cocoa beans, raw",
      "Jelly beans, assorted", "Bean sprouts, raw", "Soybean oil, salad or cooking"]) {
      expect(policyCategoriesFor(rev(d, "Sweets"))).not.toContain("beans");
    }
  });

  it("keeps edamame and green soybeans — a ruling for the coach to confirm", () => {
    for (const d of ["Edamame, frozen, prepared", "Soybeans, green, raw", "Green soybeans, cooked"]) {
      expect(policyCategoriesFor(rev(d, "Legumes and Legume Products"))).toContain("beans");
    }
  });

  it("does not match an immature seed — a green shelled bean is eaten as a vegetable", () => {
    for (const d of ["Beans, pinto, immature seeds, frozen, cooked, boiled, drained, with salt",
      "Beans, pinto, immature seeds, frozen, unprepared",
      "Beans, lima, immature seeds, raw"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .not.toContain("beans");
    }
  });

  it("does not match a pod — snap, snow, green, string and wax are vegetables, not pulses", () => {
    for (const d of ["Peas, edible-podded, raw", "Snow peas, raw", "Sugar snap peas, raw",
      "Beans, snap, green, raw", "Green beans, cooked", "String beans, canned",
      "Haricots verts, frozen"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .not.toContain("beans");
    }
  });
});

describe("simple_sugars", () => {
  it("matches the sweetener or the sweet spread itself", () => {
    for (const r of [
      rev("Honey", "Sweets"),
      rev("Syrups, maple", "Sweets"),
      rev("Sugars, granulated", "Sugars, Sweets"),
      rev("Organic Agave Nectar", "simple_sugars"),
      // The spread is the spread whatever fruit it is made of. Her apple floor is enforced by
      // allergen tags, not by this key, so excluding the word here only loses real sweeteners.
      rev("Apple jelly", "Sweets"),
      rev("Apple jam", "Sweets"),
      rev("Beet sugar", "Sugars, Sweets"),
    ]) {
      expect(policyCategoriesFor(r)).toContain("simple_sugars");
    }
  });

  it("does not match a confectionery named in the singular", () => {
    // `candies?` never matched "Candy" — the plural of "candy" is "candies", not "candys".
    for (const d of ["Candy, honey", "Candy bar, chocolate with nougat",
      "Jelly beans, assorted"]) {
      expect(policyCategoriesFor(rev(d, "Sweets"))).not.toContain("simple_sugars");
    }
  });

  it("matches the FNDDS rows the panel reported missing", () => {
    // These carry a WWEIA category that is neither "Sweets" nor "Sugars, Sweets", which is why the
    // category is now an exclusion only and never a requirement.
    for (const d of ["Agave liquid sweetener", "Jam or jelly, NFS", "Jam",
      "Jam or jelly, reduced sugar", "Jam or jelly, fruit juice sweetened", "Marmalade",
      "Molasses", "Corn syrup", "Pancake syrup", "Pancake syrup, light"]) {
      // A WWEIA category that says neither "sweets" nor "sugars": the old conjunction lost all ten.
      expect(policyCategoriesFor(rev(d, "Jams, syrups, toppings")))
        .toContain("simple_sugars");
    }
  });

  it("does not match confectionery — the panel's false positives", () => {
    for (const d of ["Candies, honey-combed, with peanut butter",
      "Candies, NESTLE, BIT-O'-HONEY Candy Chews",
      "Candies, TOBLERONE, milk chocolate with honey and almond nougat",
      "Jams and preserves, no sugar (with sodium saccharin)",
      "Candies, gumdrops, starch jelly pieces"]) {
      expect(policyCategoriesFor(rev(d, "Sweets"))).not.toContain("simple_sugars");
    }
  });

  it("does not match a food that merely contains or is packed in a sweetener", () => {
    // 21 of the first production sample's 30 rows. In every one the sweetener is a qualifier and
    // the head of the description is the food: a bean, a fruit, a vegetable.
    for (const d of [
      "Beans, kidney, dark red, canned, sodium added, sugar added, drained",
      "Beans, kidney, light red, canned, sodium added, sugar added, drained",
      "Plums, dried (prunes), stewed, without added sugar",
      "Plums, dried (prunes), stewed, with added sugar",
      "Rhubarb, frozen, cooked, with sugar",
      "Raspberries, canned, red, heavy syrup pack, solids and liquids",
      "Apricots, canned, light syrup pack, solids and liquids",
      "Peaches, canned, heavy syrup pack, solids and liquids",
      "Pears, canned, extra heavy syrup pack, solids and liquids",
      "Fruit cocktail, canned, heavy syrup, drained",
      "Blueberries, canned, in syrup",
      "Jackfruit, canned, in syrup",
      "Tropical fruit salad, canned, heavy syrup",
      "Strawberries, canned, heavy syrup pack, solids and liquids",
    ]) {
      expect(policyCategoriesFor(rev(d, "Fruits and Fruit Juices"))).not.toContain("simple_sugars");
    }
  });

  it("does not match a fruit named after a sweetener", () => {
    for (const d of ["Sugar-apples, (sweetsop), raw", "Sugar apple, raw", "Sweetsop"]) {
      expect(policyCategoriesFor(rev(d, "Fruits and Fruit Juices")))
        .not.toContain("simple_sugars");
    }
  });

  it("keeps the sweetener rows the same sample confirmed", () => {
    for (const d of ["Sugars, granulated", "Syrups, table blends, pancake, with butter",
      "Jams, preserves, marmalade, reduced sugar", "Syrup, Cane", "Fruit syrup",
      "Syrup, fruit flavored", "Syrups, grenadine",
      "Jellies, reduced sugar, home preserved",
      // "Sweetener" is a container word too: the sweetener noun is the segment after it.
      "Sweetener, syrup, agave"]) {
      expect(policyCategoriesFor(rev(d, "Sweets"))).toContain("simple_sugars");
    }
  });

  it("does not match a baked good, a drink, a condiment or a fruit named after a sweetener", () => {
    for (const r of [
      rev("Cereals ready-to-eat, honey nut toasted oats", "Breakfast Cereals"),
      rev("Honey buns, packaged", "Baked Products"),
      rev("Doughnuts, yeast-leavened, with jelly filling", "Baked Products"),
      rev("Salad dressing, honey mustard", "Fats and Oils"),
      rev("Peanut butter, honey roasted", "Legumes and Legume Products"),
      rev("Melons, honeydew, raw", "Fruits and Fruit Juices"),
      rev("Nectarines, raw", "Fruits and Fruit Juices"),
      rev("Lemonade, sugar sweetened", "Beverages"),
      rev("Sugar snap peas, raw", "Vegetables and Vegetable Products"),
    ]) {
      expect(policyCategoriesFor(r)).not.toContain("simple_sugars");
    }
  });

  it("does not match a food roasted, glazed or coated with a sweetener", () => {
    for (const d of ["Nuts, almonds, honey roasted, unblanched", "Carrots, glazed",
      "Yams, candied", "Almonds, honey coated"]) {
      expect(policyCategoriesFor(rev(d, "Sweets"))).not.toContain("simple_sugars");
    }
  });

  it("matches agave only as a sweetener, never the Southwest vegetable", () => {
    for (const d of ["Agave, raw (Southwest)", "Agave, cooked (Southwest)",
      "Agave, dried (Southwest)"]) {
      expect(policyCategoriesFor(rev(d, "Vegetables and Vegetable Products")))
        .not.toContain("simple_sugars");
    }
    for (const d of ["Agave liquid sweetener", "Agave nectar", "Agave syrup"]) {
      expect(policyCategoriesFor(rev(d, "Sugars and sweets"))).toContain("simple_sugars");
    }
  });

  it("never matches a sugar-free product", () => {
    expect(policyCategoriesFor(rev("Sugar-free pancake syrup", "Sweets")))
      .not.toContain("simple_sugars");
    expect(policyCategoriesFor(rev("Jelly Belly sugar free jelly beans", "Sweets")))
      .not.toContain("simple_sugars");
  });
});

describe("policyCategoriesFor", () => {
  it("returns an empty array for a food no rule names", () => {
    expect(policyCategoriesFor(rev("Chicken, breast, roasted", "Poultry Products"))).toEqual([]);
    expect(policyCategoriesFor(rev("White rice, cooked", null))).toEqual([]);
  });

  it("returns the keys in the rule table's own order, without duplicates", () => {
    const keys = policyCategoriesFor(rev("Salad greens with broccoli and onions",
      "Vegetables and Vegetable Products"));
    expect(keys).toEqual(["raw_cruciferous", "raw_leafy_greens", "onion_garlic"]);
  });

  it("a pickled product is negative for every key", () => {
    expect(policyCategoriesFor(rev("Pickles, chowchow, with cauliflower onion mustard, sweet",
      "Vegetables and Vegetable Products"))).toEqual([]);
    expect(policyCategoriesFor(rev("Relish, sweet pickle, with beans", "Sweets"))).toEqual([]);
  });

  it("is case-insensitive over the description and the category", () => {
    expect(policyCategoriesFor(rev("ONIONS, RAW", "VEGETABLES AND VEGETABLE PRODUCTS")))
      .toEqual(["onion_garlic"]);
  });
});
