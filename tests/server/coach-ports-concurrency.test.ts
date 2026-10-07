/**
 * sol FIX (review round 1, finding #2): `searchExactUserFood`'s allergen-evidence/check reads
 * used to be appended strictly AFTER the pre-existing `food` → `get_or_create_food_ref` → `pref`
 * chain finished, even though `foodKey` (`user_food:${row.id}:${row.rev}`) is known as soon as
 * `food` resolves — well before `ref`/`pref` are awaited. That added a full extra serial round
 * trip to every coach-turn call to this exact-food-search fallback.
 *
 * This proves the shape: the evidence/check reads must be ISSUED as soon as `food` resolves, not
 * gated behind `ref` resolving first. A regression back to `await ref` then `await pref` then
 * `Promise.all([evidence, checks])` would issue those two reads only after `ref` settles, failing
 * this test.
 */
import { describe, expect, it } from "vitest";
import { searchExactUserFood } from "@/lib/server/coach-ports";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const ROW = {
  id: "user-food-1", name: "Grandma's chili", brand: null,
  per_100g: { energy_kcal: 200 }, allergen_tags: [], rev: 3,
  ingredients_text: "Water, sugar, salt, dried beans.", kind: "custom",
};

function makeAdmin(calls: string[], sources: Record<string, Deferred<unknown>>) {
  const from = (table: string) => {
    if (table === "user_foods") {
      return { select: () => ({ eq: () => ({ in: () => ({ is: () => ({ ilike: () => ({
        limit: () => ({ maybeSingle: async () => ({ data: ROW, error: null }) }) }) }) }) }) }) };
    }
    calls.push(table);
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const method of ["select", "eq", "in", "is", "ilike", "limit", "order", "range"]) chain[method] = self;
    chain.maybeSingle = () => sources[table].promise;
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      sources[table].promise.then(onFulfilled, onRejected);
    return chain;
  };
  const rpc = () => {
    calls.push("rpc:get_or_create_food_ref");
    return sources.rpc.promise;
  };
  return { from, rpc } as never;
}

describe("searchExactUserFood: the evidence/check reads run alongside the ref/pref chain", () => {
  it("issues the allergen-evidence and check reads as soon as the row is known, not after the " +
    "ref→pref chain finishes", async () => {
    const calls: string[] = [];
    const sources = {
      rpc: deferred<unknown>(),
      user_food_prefs: deferred<unknown>(),
      food_allergen_evidence: deferred<unknown>(),
      user_allergen_checks: deferred<unknown>(),
    };
    const admin = makeAdmin(calls, sources);

    const pending = searchExactUserFood(admin, "u1", "chili");

    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    // The evidence/check reads and the ref RPC must already be in flight — none of them waited
    // for the ref→pref chain, which cannot even start its pref half yet (ref has not resolved).
    expect(calls).toContain("rpc:get_or_create_food_ref");
    expect(calls).toContain("food_allergen_evidence");
    expect(calls).toContain("user_allergen_checks");
    expect(calls).not.toContain("user_food_prefs");

    sources.rpc.resolve({ data: "ref-1", error: null });
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
    expect(calls).toContain("user_food_prefs");

    sources.user_food_prefs.resolve({ data: null, error: null });
    sources.food_allergen_evidence.resolve({ data: [], error: null });
    sources.user_allergen_checks.resolve({ data: [], error: null });

    const hit = await pending;
    expect(hit).toMatchObject({ foodRefId: "ref-1", name: "Grandma's chili" });
  });
});
