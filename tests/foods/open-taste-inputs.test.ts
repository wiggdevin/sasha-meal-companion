/**
 * Phase 18 W8: the bridge from the account's taste evidence to `pref-2`'s inputs
 * (lib/foods/world/taste-inputs.ts), closing W7's open items:
 *   - the universe-id-keyed prior and substitute graph reach the ranking's NAME keys;
 *   - an account copy of a catalog food and the `catalog:` key resolve to one identity;
 *   - no reviewed sensory edge exists, so a taste dislike never spreads to a neighbour;
 *   - a new eaten episode raises H and M (and the food's z).
 */
import { describe, expect, it } from "vitest";
import { deriveItem } from "@/lib/foods/universe/derive";
import { universePoolId } from "@/lib/foods/universe/food";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { priorFromRows, priorScores, type AccountPrior } from "@/lib/foods/universe/prior";
import type { SubstituteGraph } from "@/lib/foods/universe/substitutes";
import { preferenceInputFor, type PoolFact, type TasteContext } from "@/lib/foods/world/taste-inputs";
import { foodKey } from "@/lib/meals/parts";
import { preferenceScores } from "@/lib/meals/preference";
import { tasteProfile, type EatenItem } from "@/lib/meals/taste";
import { identityOf } from "@/lib/meals/taste-identity";
import { UNIVERSE_PARTS } from "@/tests/helpers/open-snapshot";

const universeFact = (id: string): PoolFact => {
  const item = deriveItem(universeEntry(id)!)!;
  return { id: universePoolId(id), name: item.food.name, key: foodKey(item.food), universeId: id, refIds: [], favored: false };
};
const NEUTRAL: AccountPrior = { prior: { status: "neutral", reason: "country_unset" }, cohort: "national" };
const context = (overrides: Partial<TasteContext> = {}): TasteContext => ({
  profile: { m: 0, identities: [] }, identities: new Map(), dislikes: [], cuisines: [], prior: NEUTRAL,
  universeParts: UNIVERSE_PARTS, graph: null, ...overrides });

const SALMON = "canned-salmon-pink";
const NEIGHBOURS = ["tilapia-cooked", "catfish-cooked", "cod-cooked", "sardines-canned-in-oil", "trout-cooked"];
const GRAPH: SubstituteGraph = { type: "substitute", version: "test", weights: { tax: 0.4, nutr: 0.25, ctx: 0.15, like: 0.15, comp: 0.05 },
  absent: ["like", "comp"], edges: NEIGHBOURS.map((to, i) => ({ from: SALMON, to, sub: 0.75 - i * 0.02 }))
    .concat(NEIGHBOURS.map((from, i) => ({ from, to: SALMON, sub: 0.75 - i * 0.02 }))) };

describe("universe-keyed inputs reach the ranking's name keys", () => {
  it("the prior is centred over the whole universe, so it does not depend on what the account admits", () => {
    const rows = Object.keys(UNIVERSE_PARTS).map((id, i) => ({ cohort: "national", food_key: id,
      rate: 0.01 + (i % 17) / 40, n_eff: 100 }));
    const prior: AccountPrior = { prior: priorFromRows(rows), cohort: "national" };
    const expected = priorScores(prior.prior, "national", UNIVERSE_PARTS);
    const few = ["tuna-canned-in-water-light", "cod-cooked"].map(universeFact);
    const many = Object.keys(UNIVERSE_PARTS).slice(0, 120).map(universeFact).concat(few);
    for (const pool of [few, many]) {
      const input = preferenceInputFor(pool, context({ prior }));
      for (const fact of few) {
        const food = input.foods.find((row) => row.key === fact.key)!;
        expect([fact.key, food.prior ?? 0]).toEqual([fact.key, expected[fact.universeId!]]);
      }
    }
  });

  it("graph edges land on pool name keys only: no edge reaches a food outside the admitted pool", () => {
    const pool = [SALMON, "tilapia-cooked", "cod-cooked"].map(universeFact);
    const input = preferenceInputFor(pool, context({ graph: GRAPH }));
    const salmon = input.foods.find((row) => row.key === universeFact(SALMON).key)!;
    expect(salmon.neighbours?.map((edge) => edge.key).sort())
      .toEqual([universeFact("cod-cooked").key, universeFact("tilapia-cooked").key].sort());
    expect(salmon.neighbours?.every((edge) => edge.sensory !== true)).toBe(true);
  });

  it("an account food made from a catalog food and the catalog key resolve to one identity", () => {
    const item = deriveItem(universeEntry("chicken-breast-roasted")!)!;
    const identity = identityOf({ foodDbId: "chicken-breast-roasted" })!;
    const own: PoolFact = { id: "11111111-1111-4111-8111-111111111111", name: "Grilled chicken (mine)",
      key: "grilled chicken (mine)", universeId: null, refIds: ["ref-own", "cat-501"], favored: true };
    const row = { key: identity.key, name: item.food.name, h: 2.2, q: 1, days180: 4, episodes: 4, lastOn: "2026-10-05",
      provenance: { match: "universe" as const, estimated: false, sources: { log: 4, recipe: 0, tick: 0, mixed_dish: 0 },
        collapsed: 0, choices: { swap_pick: 0, plan_add: 0, shopping_manual: 1 } } };
    // History resolved a `catalog:501` tick to the catalog ref only; the account copy holds both refs.
    for (const refIds of [new Set(["cat-501"]), new Set(["ref-own"])]) {
      const input = preferenceInputFor([own], context({ profile: { m: 4, identities: [row] },
        identities: new Map([[identity.key, { refIds, favoredRefIds: new Set<string>(), universeId: "chicken-breast-roasted" }]]) }));
      expect(input.foods[0].signals).toMatchObject({ favored: true, eaten: 2.2, chosen: 1 });
    }
  });
});

describe("no reviewed sensory edge: a dislike lowers only what it names", () => {
  it("disliking strong fish lowers canned salmon and leaves its substitutes exactly where they were", () => {
    const pool = [SALMON, ...NEIGHBOURS].map(universeFact);
    const plain = preferenceScores(preferenceInputFor(pool, context({ graph: GRAPH })));
    const disliked = preferenceScores(preferenceInputFor(pool, context({ graph: GRAPH, dislikes: ["t:strong_fish"] })));
    expect(disliked[universeFact(SALMON).key].base.z).toBeLessThan(plain[universeFact(SALMON).key].base.z);
    // Sardines carry the tag themselves; every other neighbour is untouched.
    const untagged = NEIGHBOURS.filter((id) => !universeEntry(id)!.sensory.includes("strong_fish"));
    expect(untagged.length).toBeGreaterThanOrEqual(3);
    for (const id of untagged) {
      const key = universeFact(id).key;
      expect([key, disliked[key].base.z]).toEqual([key, plain[key].base.z]);
    }
  });

  it("a family dislike matches every food of the family, and nothing else", () => {
    const pool = ["tuna-canned-in-water-light", "tuna-canned-in-oil-light", "cod-cooked"].map(universeFact);
    const input = preferenceInputFor(pool, context({ dislikes: ["f:tuna"] }));
    expect(input.foods.filter((row) => row.signals?.disliked).map((row) => row.key).sort())
      .toEqual(pool.filter((fact) => fact.key.startsWith("tuna")).map((fact) => fact.key).sort());
  });
});

describe("account-level M: a new eaten episode raises H and M", () => {
  it("adding one eaten meal raises the identity's H, the account's M, and the food's z", () => {
    const today = "2026-10-06";
    const identity = identityOf({ foodDbId: "cod-cooked" })!;
    const eat = (localDate: string, slot: string): EatenItem => ({ localDate, slot, source: "log", identity, grams: 150 });
    const before = [eat("2026-09-20", "meal-2"), eat("2026-09-28", "meal-3")];
    const after = [...before, eat("2026-10-05", "meal-3")];
    const profile = (items: EatenItem[]) => tasteProfile({ today, items, choices: [], admitted: new Set([identity.key]) });
    const p0 = profile(before);
    const p1 = profile(after);
    const h = (p: ReturnType<typeof profile>) => p.identities.find((row) => row.key === identity.key)!.h;
    expect(h(p1)).toBeGreaterThan(h(p0));
    expect(p1.m).toBeGreaterThan(p0.m);
    const pool = ["cod-cooked", "tilapia-cooked"].map(universeFact);
    const z = (p: ReturnType<typeof profile>) => preferenceScores(preferenceInputFor(pool,
      context({ profile: p })))[universeFact("cod-cooked").key].base.z;
    expect(z(p1)).toBeGreaterThan(z(p0));
    // M fades the prior: with a loaded prior, more episodes give the prior less weight.
    const input = preferenceInputFor(pool, context({ profile: p1 }));
    expect(input.episodes).toBe(p1.m);
  });
});
