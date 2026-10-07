import { describe, expect, it } from "vitest";
import { classifyQuery, FOOD_DISCOVERY_MAX_TERMS, foodDiscoveryTerms, normalizeBrand, parseQuery,
  PREP_STATES } from "./query";

describe("parseQuery", () => {
  it("takes a trailing brand: field and drops it from raw", () => {
    expect(parseQuery("olive oil brand:Kirkland")).toEqual({
      raw: "olive oil", brand: "Kirkland", prep: null,
    });
  });

  it("takes a quoted brand: value with spaces", () => {
    expect(parseQuery('rolled oats brand:"Bob\'s Red Mill"')).toEqual({
      raw: "rolled oats", brand: "Bob's Red Mill", prep: null,
    });
  });

  it("takes a quoted phrase anywhere as the brand", () => {
    expect(parseQuery('"Rao\'s" marinara sauce')).toEqual({
      raw: "marinara sauce", brand: "Rao's", prep: null,
    });
  });

  it("lifts one prep word out of the query", () => {
    expect(parseQuery("chicken thigh roasted")).toEqual({
      raw: "chicken thigh", brand: null, prep: "roasted",
    });
    expect(parseQuery("Boiled white potato")).toEqual({
      raw: "white potato", brand: null, prep: "boiled",
    });
  });

  it("lifts only the first prep word", () => {
    expect(parseQuery("raw or cooked spinach")).toMatchObject({ raw: "or cooked spinach", prep: "raw" });
  });

  it("never returns an empty raw", () => {
    expect(parseQuery("brand:Kirkland")).toEqual({ raw: "brand:Kirkland", brand: "Kirkland", prep: null });
    expect(parseQuery("roasted")).toEqual({ raw: "roasted", brand: null, prep: "roasted" });
  });

  it("collapses whitespace and trims", () => {
    expect(parseQuery("  sweet   potato  ")).toEqual({ raw: "sweet potato", brand: null, prep: null });
  });

  it("returns no brand and no prep for a plain query", () => {
    expect(parseQuery("ahi tuna")).toEqual({ raw: "ahi tuna", brand: null, prep: null });
  });

  it("never proposes 'unknown' as a parsed prep", () => {
    expect(PREP_STATES).toContain("unknown");
    expect(parseQuery("unknown food").prep).toBeNull();
  });
});

describe("normalizeBrand", () => {
  it("strips accents, lowercases, collapses whitespace", () => {
    expect(normalizeBrand("  Café   MÜLLER ")).toBe("cafe muller");
  });

  it("is stable for an already normal brand", () => {
    expect(normalizeBrand("kirkland")).toBe("kirkland");
  });
});

describe("classifyQuery", () => {
  it("is branded when a brand came out of the query", () => {
    expect(classifyQuery(parseQuery("olive oil brand:Kirkland"))).toBe("branded");
  });

  it("is branded on a capitalised run inside a lowercase query", () => {
    expect(classifyQuery(parseQuery("Kirkland Signature olive oil"))).toBe("branded");
  });

  it("is generic for a lowercase query", () => {
    expect(classifyQuery(parseQuery("chicken breast"))).toBe("generic");
  });

  it("is generic when the whole query is title-cased", () => {
    expect(classifyQuery(parseQuery("Chicken Breast"))).toBe("generic");
  });

  it("is generic for a single capitalised token", () => {
    expect(classifyQuery(parseQuery("RXBAR chocolate"))).toBe("generic");
  });
});

describe("foodDiscoveryTerms", () => {
  it("keeps an ordinary ingredient as its one normalized term", () => {
    expect(foodDiscoveryTerms("  Chicken   Breast ")).toEqual(["chicken breast"]);
  });

  it("sends a misspelling on unchanged, so the server's trigram and synonym search owns it", () => {
    // `brocoli` and `potatoe` are corrected by SQL (pg_trgm and catalog_synonyms), never here:
    // the browser never carries the synonym table.
    expect(foodDiscoveryTerms("brocoli")).toEqual(["brocoli"]);
    expect(foodDiscoveryTerms("Potatoe")).toEqual(["potatoe"]);
  });

  it("adds the foods an existing policy category names when the request is that category", () => {
    expect(foodDiscoveryTerms("Onion and garlic"))
      .toEqual(["onion and garlic", "onion", "garlic", "leek", "shallot"]);
    expect(foodDiscoveryTerms("leafy greens"))
      .toEqual(["leafy greens", "salad greens", "spinach", "rocket"]);
    expect(foodDiscoveryTerms("Raw cruciferous vegetables")).toEqual(["raw cruciferous vegetables",
      "broccoli", "cauliflower", "cabbage", "kale", "brussels sprouts"]);
  });

  it("deduplicates the raw phrase against its aliases", () => {
    expect(foodDiscoveryTerms("beans")).toEqual(["beans", "lentils", "chickpeas", "split peas"]);
  });

  it("stays bounded and answers nothing for a blank request", () => {
    expect(foodDiscoveryTerms("simple sugars").length).toBeLessThanOrEqual(FOOD_DISCOVERY_MAX_TERMS);
    expect(foodDiscoveryTerms("simple sugars")[0]).toBe("simple sugars");
    expect(foodDiscoveryTerms("   ")).toEqual([]);
  });

  it("invents no cuisine alias the catalog policy map does not carry", () => {
    expect(foodDiscoveryTerms("italian")).toEqual(["italian"]);
  });
});
