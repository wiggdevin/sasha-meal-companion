/**
 * Phase 13 §9 R1, client half: "I checked this product's label" (lib/foods/label-check-client.ts).
 * The account comes from the device account handle (lib/device/account.ts), not the removed
 * lib/log/reconcile helper — see lib/foods/starter-client.test.ts for the same bind/unbind pattern.
 *
 * ROUND 10 finding #5: this now goes through `accountFetch`/`accountJson` for the bound account
 * only, the same shape tests/foods/allergen-check-client.test.ts proves for the barcode card — the
 * round-8 explicit `userId` override is gone (see lib/foods/label-check-client.ts's own doc).
 *
 * ROUND 10 findings #2 and #3: `allergenKeys` and `expectedRevisions` are both required now — the
 * caller binds both at the moment the sheet resolves them, and the server records a check only for
 * the keys given, never the account's current profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_HEADER, bindAccount, unbindAccount } from "@/lib/device/account";
import { DEADLINES } from "@/lib/fetch-with-deadline";
import { markFoodLabelChecked } from "@/lib/foods/label-check-client";
import { FOOD_PREF_REFS_KEY } from "@/lib/foods/prefs-client";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const BOUND = { allergenKeys: ["gluten"], expectedRevisions: { "ref-catalog-1": 410 } };

/** lib/foods/prefs-client.ts is synchronous localStorage; stubbed as tests/foods/prefs-client.test.ts does. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  } as Storage;
}

function seedRefs(userId: string, foodId: string, refs: { userRefId?: string; catalogRefId?: string }) {
  localStorage.setItem(FOOD_PREF_REFS_KEY, JSON.stringify({ [userId]: { [foodId]: refs } }));
}

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
  bindAccount(USER_ID);
});
afterEach(() => { unbindAccount(); });

describe("markFoodLabelChecked", () => {
  it("posts the food's server ref, its allergen keys and its expected revision to the " +
    "allergen-check route under the bound account", async () => {
    seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1", catalogRefId: "ref-catalog-1" });
    const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: ["dairy", "sesame"] });

    const result = await markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND });

    expect(result).toEqual(["dairy", "sesame"]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/foods/allergen-check");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      foodRefIds: ["ref-catalog-1"], checked: true,
      allergenKeys: ["gluten"], expectedRevisions: { "ref-catalog-1": 410 },
    });
  });

  it("carries the bound account's x-smc-account header", async () => {
    seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1", catalogRefId: "ref-catalog-1" });
    const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: ["gluten"] });

    await markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get(ACCOUNT_HEADER)).toBe(USER_ID);
  });

  describe("finding #6: exactly the revision the user inspected, never both refs at once", () => {
    it("sends only the catalog ref when this food is mapped to a catalog product — the mapped " +
      "catalog revision, not the separate user-food row, is the one the check must bind to", async () => {
        seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1", catalogRefId: "ref-catalog-1" });
        const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: [] });

        await markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND });

        const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(JSON.parse(String((init as RequestInit).body)).foodRefIds).toEqual(["ref-catalog-1"]);
      });

    it("falls back to the user's own ref when the food has no catalog mapping", async () => {
      seedRefs(USER_ID, "my-custom-soup", { userRefId: "ref-user-2" });
      const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: [] });

      await markFoodLabelChecked("my-custom-soup", true, { fetchImpl, ...BOUND });

      const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(String((init as RequestInit).body)).foodRefIds).toEqual(["ref-user-2"]);
    });
  });

  describe("finding #2: the request carries only the allergen keys bound when the sheet opened",
    () => {
      it("sends exactly the given allergenKeys, not a wider set", async () => {
        seedRefs(USER_ID, "white-rice", { catalogRefId: "ref-catalog-1" });
        const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: ["gluten"] });

        await markFoodLabelChecked("white-rice", true, {
          fetchImpl, allergenKeys: ["gluten", "dairy"],
          expectedRevisions: { "ref-catalog-1": 410 },
        });

        const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(JSON.parse(String((init as RequestInit).body)).allergenKeys)
          .toEqual(["gluten", "dairy"]);
      });
    });

  describe("finding #7: expectedRevisions, required (round 10 finding #3)", () => {
    it("sends expectedRevisions in the body", async () => {
      seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1", catalogRefId: "ref-catalog-1" });
      const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: ["gluten"] });

      await markFoodLabelChecked("white-rice", true,
        { fetchImpl, allergenKeys: ["gluten"], expectedRevisions: { "ref-catalog-1": 410 } });

      const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        foodRefIds: ["ref-catalog-1"], checked: true,
        allergenKeys: ["gluten"], expectedRevisions: { "ref-catalog-1": 410 },
      });
    });

    it("reports a server-refused stale revision as null, not a false success", async () => {
      seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1", catalogRefId: "ref-catalog-1" });
      // The server's own markLabelChecked skips a ref whose active revision moved: empty foodKeys.
      const fetchImpl = answer(200, { foodKeys: [], stale: ["ref-catalog-1"], allergens: ["gluten"] });

      const result = await markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND });

      expect(result).toBeNull();
    });

    it("reports the route's 422 refusal (no expectation the server can act on) as null", async () => {
      seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1", catalogRefId: "ref-catalog-1" });
      const fetchImpl = answer(422, { error: "revision_required" });

      expect(await markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND })).toBeNull();
    });
  });

  it("returns null (not a false success) when the server reports no food matched", async () => {
    seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1" });
    const fetchImpl = answer(200, { foodKeys: [], allergens: ["gluten"] });

    expect(await markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND })).toBeNull();
  });

  it("returns null without a fetch when no account is bound", async () => {
    unbindAccount();
    seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1" });
    const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: [] });

    expect(await markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null without a fetch when the food has no server refs yet", async () => {
    const fetchImpl = answer(200, { foodKeys: [], allergens: [] });

    expect(await markFoodLabelChecked("unknown-food", true, { fetchImpl, ...BOUND })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the route refuses", async () => {
    seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1" });
    expect(await markFoodLabelChecked("white-rice", true,
      { fetchImpl: answer(429, { error: "x" }), ...BOUND })).toBeNull();
  });

  it("returns null on a network error", async () => {
    seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1" });
    const fetchImpl = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    expect(await markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND })).toBeNull();
  });

  it("review r2 correct/FIX: gives up at the commit budget instead of hanging forever — a raw " +
    "fetch with no deadline left the FoodSheet button stuck in 'saving' when the server never " +
    "answered (lib/fetch-with-deadline.ts T0 §2)", async () => {
      seedRefs(USER_ID, "white-rice", { userRefId: "ref-user-1" });
      const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      vi.useFakeTimers();
      try {
        const outcome = markFoodLabelChecked("white-rice", true, { fetchImpl, ...BOUND });
        await vi.advanceTimersByTimeAsync(DEADLINES.commit + 10);
        expect(await outcome).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

  describe("ORCHESTRATOR fix (round 7, item 2): an explicit foodRefId is used exactly as given, " +
    "never re-read from the cache", () => {
    it("sends the given foodRefId even when the cache now holds a different one", async () => {
      seedRefs(USER_ID, "white-rice", { catalogRefId: "ref-catalog-NEW" });
      const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: ["gluten"] });

      await markFoodLabelChecked("white-rice", true, {
        fetchImpl, allergenKeys: ["gluten"],
        foodRefId: "ref-catalog-BOUND", expectedRevisions: { "ref-catalog-BOUND": 5 },
      });

      const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        foodRefIds: ["ref-catalog-BOUND"], checked: true,
        allergenKeys: ["gluten"], expectedRevisions: { "ref-catalog-BOUND": 5 },
      });
    });

    it("returns null without a fetch when foodRefId is explicitly null, even though the cache " +
      "holds a ref — a caller that bound 'no ref yet' at open time must not fall back to one", async () => {
        seedRefs(USER_ID, "white-rice", { catalogRefId: "ref-catalog-1" });
        const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: [] });

        const result = await markFoodLabelChecked("white-rice", true,
          { fetchImpl, ...BOUND, foodRefId: null });

        expect(result).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
      });
  });
});
