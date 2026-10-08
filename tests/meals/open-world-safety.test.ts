/**
 * Phase 18 W2b safety suite (spec §8): the D4 admission order over the full universe.
 *
 * Acceptance 1: 500 seeded random rule profiles (allergens, banned categories, custom ingredient
 * rules, preference flags, confirmed profile hard rules, Avoid families) admit 0 foods whose
 * `evaluatePolicy` verdict is not `allowed`, and arbitrary prior, graph and Jev outputs cannot
 * add one. The oracle recomputes every admitted item's verdict on its own.
 * Acceptance 2: an Avoid mark on any member of a family removes every item of the family and
 * every graph-neighbour path into it.
 * Acceptance 8: the kosher plate rule (lib/policy/plate-rules.ts).
 */
import { describe, expect, it } from "vitest";
import { baseFoodName } from "@/lib/foods/base-name";
import { ALLERGEN_KEYS, deriveItem, universePolicyEvidence, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import {
  admissionEvidence, admittedGraph, admitUniverse, avoidFamilies, rankAdmitted, type AdmissionRules, type GraphEdge,
} from "@/lib/foods/world/admission";
import { usableForGeneration } from "@/lib/meals/pool";
import { EMPTY_PROFILE, evaluatePolicy, type ConstraintProfile } from "@/lib/policy/constraints";
import { ALLERGEN_RULES } from "@/lib/policy/allergens";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import type { RuleItem } from "@/lib/policy/profiles/types";
import { ruleId } from "@/lib/policy/profiles/types";
import { PREFERENCE_FLAGS } from "@/lib/profile/onboarding-state";

const ITEMS = UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null);
const ASOF = new Date("2026-10-05T12:00:00Z");
/** Each item's own policy inputs, derived once (pure in the bundled row). */
const EVIDENCE = new Map(ITEMS.map((item) => [item.entry.id, admissionEvidence(item)]));

/** mulberry32: a small seeded generator, so a failure names a reproducible profile. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function some<T>(random: () => number, pool: readonly T[], max: number): T[] {
  const count = Math.floor(random() * (max + 1));
  const out = new Set<T>();
  while (out.size < Math.min(count, pool.length)) out.add(pool[Math.floor(random() * pool.length)]);
  return [...out];
}

const CATEGORIES = ["raw_cruciferous", "raw_leafy_greens", "onion_garlic", "beans", "simple_sugars"];
const INGREDIENT_WORDS = ["garlic", "rice", "chicken", "milk", "tomato", "wheat", "pork", "corn", "egg", "beef"];
const HARD_FACETS = ["pork", "alcohol", "food_named:rice", "food_named:salmon", "contains_allergen:sesame",
  "high_sodium", "beef", "shellfish"];

function hardRule(facet: string, basis: "religious" | "user_rule"): RuleItem {
  return { id: ruleId("random", facet), profileId: "random", facet, strength: "never", hardBasis: basis,
    evidenceStrength: null, confirmation: "confirmed", expiresAt: null };
}

type Random = { rules: AdmissionRules; families: string[] };

function randomRules(seed: number): Random {
  const random = rng(seed);
  const familyNames = some(random, ITEMS, 3).map((item) => (random() < 0.5 ? item.row.name : item.row.sr));
  const profile: ConstraintProfile = {
    ...EMPTY_PROFILE,
    avoid_allergens: some(random, Object.keys(ALLERGEN_RULES), 3),
    banned_categories: some(random, CATEGORIES, 3),
    custom_rules: some(random, INGREDIENT_WORDS, 2).map((text, i) => ({ id: `r${i}`, kind: "ingredient" as const, text })),
    profileRules: { asOf: ASOF, items: some(random, HARD_FACETS, 2)
      .map((facet) => hardRule(facet, random() < 0.5 ? "religious" : "user_rule")) },
  };
  return { families: familyNames,
    rules: { profile, preferenceFlags: some(random, PREFERENCE_FLAGS, 3) as PolicyPreferenceFlag[],
      avoidFamilies: avoidFamilies(familyNames) } };
}

/** The oracle: the item's own verdict, recomputed directly from `evaluatePolicy`. */
function oracleAllows(rules: AdmissionRules, item: UniverseItem): boolean {
  if ([item.row.name, item.row.sr].some((name) => rules.avoidFamilies.has(baseFoodName(name)))) return false;
  const verdict = evaluatePolicy(rules.profile, { ...EVIDENCE.get(item.entry.id)!,
    preferenceFlags: rules.preferenceFlags, profileRules: rules.profile.profileRules });
  // Exact: admitted means the raw verdict is `allowed`. No case is excused. And, independently of
  // the tags passed, every avoided allergen's derived state is `clear`.
  const avoided = rules.profile.avoid_allergens.flatMap((key) => (key === "shellfish" ? [key, "crustacean"] : [key]));
  return verdict.verdict === "allowed" && avoided.every((key) => item.allergens[key] === "clear");
}

/** Arbitrary step-4 outputs: scores and similarity edges over every universe id, admitted or not. */
function arbitraryOutputs(seed: number): { scores: Record<string, number>; edges: GraphEdge[] } {
  const random = rng(seed ^ 0x5bd1e995);
  const scores: Record<string, number> = {};
  for (const item of ITEMS) scores[item.entry.id] = random() < 0.05 ? Number.NaN : random() * 10 - 5;
  const edges = Array.from({ length: 400 }, () => ({
    from: ITEMS[Math.floor(random() * ITEMS.length)].entry.id,
    to: ITEMS[Math.floor(random() * ITEMS.length)].entry.id, weight: random() }));
  return { scores, edges };
}

describe("open-world admission over the full universe (W2b acceptance 1)", () => {
  it("500 random rule profiles and arbitrary scores admit zero non-allowed foods", () => {
    let admittedTotal = 0;
    let excludedTotal = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const { rules } = randomRules(seed);
      const { admitted, excluded } = admitUniverse(ITEMS, rules);
      const byId = new Map(ITEMS.map((item) => [item.entry.id, item]));
      const wrong = admitted.filter((id) => {
        const item = byId.get(id)!;
        return !oracleAllows(rules, item) || !usableForGeneration(item.food);
      });
      expect([seed, wrong]).toEqual([seed, []]);
      expect(admitted.length + excluded.length).toBe(ITEMS.length);
      const { scores, edges } = arbitraryOutputs(seed);
      const set = new Set(admitted);
      expect(rankAdmitted(admitted, scores).every((id) => set.has(id))).toBe(true);
      expect(rankAdmitted(admitted, scores)).toHaveLength(admitted.length);
      expect(admittedGraph(edges, set).every((edge) => set.has(edge.from) && set.has(edge.to))).toBe(true);
      admittedTotal += admitted.length;
      excludedTotal += excluded.length;
    }
    // Not vacuous: the random profiles both admit and exclude.
    expect(admittedTotal).toBeGreaterThan(2_000);
    expect(excludedTotal).toBeGreaterThan(100_000);
  }, 120_000);

  it("admission reads no score: the admitted set is the same whatever the step-4 outputs are", () => {
    const { rules } = randomRules(7);
    const first = admitUniverse(ITEMS, rules).admitted;
    for (let seed = 1; seed <= 5; seed += 1) {
      const { scores } = arbitraryOutputs(seed);
      expect(rankAdmitted(first, scores).sort()).toEqual([...first].sort());
    }
  });
});

describe("the admission input (Sol r1 BLOCK 1: fix the input, never the verdict)", () => {
  it("passes a tag list only when every allergen state is known, and then exactly the listed keys", () => {
    for (const item of ITEMS) {
      const states = ALLERGEN_KEYS.map((key) => item.allergens[key]);
      const tags = admissionEvidence(item).allergenTags;
      if (states.includes("unknown")) expect([item.entry.id, tags]).toEqual([item.entry.id, null]);
      else expect([item.entry.id, tags]).toEqual([item.entry.id,
        ALLERGEN_KEYS.filter((key) => item.allergens[key] === "listed")]);
      const { perAllergenEvidence, ...rest } = admissionEvidence(item);
      expect(perAllergenEvidence).toBe(true);
      expect({ ...rest, allergenTags: null }).toEqual(universePolicyEvidence(item));
    }
  });

  // Owner direction 2026-10-08 ("no allow list"): an evidence gap only matters to a rule that needs
  // the evidence. With no rules, every item with usable nutrition is admitted; before, the legacy
  // no-tag-list gate (the closed world's Eats allow list) kept 192 of 319 items out of an account
  // that avoids nothing, while an account WITH an unrelated allergen rule got them (W2b r2 note).
  it("with no rules, admits every item with usable nutrition: an evidence gap no rule reads excludes nothing", () => {
    const rules: AdmissionRules = { profile: EMPTY_PROFILE, preferenceFlags: [], avoidFamilies: new Set() };
    const expected = ITEMS.filter((item) => usableForGeneration(item.food)).map((item) => item.entry.id).sort();
    expect(admitUniverse(ITEMS, rules).admitted).toEqual(expected);
    expect(ITEMS.some((item) => ALLERGEN_KEYS.some((key) => item.allergens[key] === "unknown"))).toBe(true);
  });

  it("an avoided allergen still decides for itself: an item whose state for it is not clear stays out", () => {
    for (const key of ALLERGEN_KEYS) {
      const rules: AdmissionRules = { profile: { ...EMPTY_PROFILE, avoid_allergens: [key] }, preferenceFlags: [],
        avoidFamilies: new Set() };
      const admitted = new Set(admitUniverse(ITEMS, rules).admitted);
      const keys = key === "shellfish" ? [key, "crustacean"] : [key];
      for (const item of ITEMS.filter((row) => admitted.has(row.entry.id))) {
        for (const avoided of keys) expect([key, item.entry.id, item.allergens[avoided]]).toEqual([key, item.entry.id, "clear"]);
      }
    }
  });

  it("a diet flag still excludes what it names: no animal food for vegan, no meat or fish for vegetarian", () => {
    const ANIMAL = /chicken|beef|pork|lamb|turkey|duck|goat|bison|veal|ham|bacon|sausage|steak|fish|salmon|tuna|cod|tilapia|trout|halibut|catfish|sardine|anchov|mackerel|shrimp|prawn|crab|lobster|scallop|mussel|clam|oyster|octopus|squid|egg|milk|cheese|yogurt|butter|ghee|cream|paneer|whey|\bhoney\b/i;
    const MEAT = /chicken|beef|pork|lamb|turkey|duck|goat|bison|veal|ham|bacon|sausage|steak|fish|salmon|tuna|cod|tilapia|trout|halibut|catfish|sardine|anchov|mackerel|shrimp|prawn|crab|lobster|scallop|mussel|clam|oyster|octopus|squid/i;
    const NOT_ANIMAL = /peanut butter|almond butter|cashew butter|sunflower seed butter|nut butter|coconut milk|almond milk|soy milk|oat milk|rice milk|eggplant|butternut|butter bean|cream of wheat/i;
    for (const [flag, words] of [["vegan", ANIMAL], ["vegetarian", MEAT]] as const) {
      const rules: AdmissionRules = { profile: EMPTY_PROFILE, preferenceFlags: [flag as PolicyPreferenceFlag],
        avoidFamilies: new Set() };
      const admitted = new Set(admitUniverse(ITEMS, rules).admitted);
      const wrong = ITEMS.filter((item) => admitted.has(item.entry.id))
        .filter((item) => words.test(item.row.name) && !NOT_ANIMAL.test(item.row.name)).map((item) => item.entry.id);
      expect([flag, wrong]).toEqual([flag, []]);
      expect(admitted.size).toBeGreaterThan(20);
    }
  });
});

describe("Avoid families (W2b acceptance 2)", () => {
  it("an Avoid mark on a food also keeps out the universe item that is a form of it (canned, smoked, ground …)", () => {
    const rules: AdmissionRules = { profile: EMPTY_PROFILE, preferenceFlags: [], avoidFamilies: avoidFamilies(["Salmon"]) };
    const admitted = admitUniverse(ITEMS, rules).admitted;
    expect(admitted.filter((id) => id.includes("salmon"))).toEqual([]);
    expect(ITEMS.some((item) => item.entry.id === "canned-salmon-pink")).toBe(true);
  });

  const families = [...new Set(ITEMS.map((item) => baseFoodName(item.row.name)))]
    .filter((key) => ITEMS.filter((item) => baseFoodName(item.row.name) === key).length > 1);

  it("the universe has multi-member families to test", () => {
    expect(families.length).toBeGreaterThan(0);
  });

  it("an Avoid mark on any one member removes every item of the family", () => {
    for (const family of families) {
      const members = ITEMS.filter((item) => baseFoodName(item.row.name) === family);
      for (const marked of members) {
        // The mark names one row, with its own qualifiers ("Rice, white, cooked"): the family is the base name.
        const rules: AdmissionRules = { profile: EMPTY_PROFILE, preferenceFlags: [],
          avoidFamilies: avoidFamilies([`${marked.row.name}, as marked`]) };
        const { admitted } = admitUniverse(ITEMS, rules);
        expect(members.filter((item) => admitted.includes(item.entry.id))).toEqual([]);
      }
    }
  });

  it("no graph-neighbour path reaches an avoided family", () => {
    const family = families[0];
    const rules: AdmissionRules = { profile: EMPTY_PROFILE, preferenceFlags: [], avoidFamilies: new Set([family]) };
    const admitted = new Set(admitUniverse(ITEMS, rules).admitted);
    const { edges } = arbitraryOutputs(11);
    const members = ITEMS.filter((item) => baseFoodName(item.row.name) === family).map((item) => item.entry.id);
    // Wire every member into the graph from several admitted foods, then walk every path.
    const wired = [...edges, ...members.flatMap((id) => [...admitted].slice(0, 5)
      .flatMap((from) => [{ from, to: id, weight: 1 }, { from: id, to: from, weight: 1 }]))];
    const graph = admittedGraph(wired, admitted);
    const reached = new Set<string>([...admitted].slice(0, 1));
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of graph) {
        if (reached.has(edge.from) && !reached.has(edge.to)) { reached.add(edge.to); changed = true; }
      }
    }
    expect(members.filter((id) => reached.has(id))).toEqual([]);
    expect(graph.some((edge) => members.includes(edge.from) || members.includes(edge.to))).toBe(false);
  });
});
