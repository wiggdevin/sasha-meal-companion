/**
 * Owner ask 2026-10-02: the reply's own "Added apple and oat milk to your list." confirmation is
 * not advice and must not trip the hard-rule scan. Audits 2026-10-02 (Grok, DeepSeek, BLOCK): the
 * item NAMES are not exempt — a reply that also recommends the food is still judged. Only a
 * sentence that is nothing but the confirmation is set aside (lib/coach/shopping-confirmation.ts).
 * DeepSeek audit round 9 (HIGH): the item itself is still judged, so a food that definitely clashes
 * with a hard rule never goes on the list unremarked.
 */
import { describe, expect, it } from "vitest";
import { isReask } from "@/lib/coach/reask";
import { checkReply, loggedFoodIdentities } from "@/lib/coach/reply-check";
import {
  checkReplyLive, startReplyScan, type ReplyCheckPorts, type ReplyScanInput,
} from "@/lib/server/reply-check";
import type { FoodHit } from "@/lib/coach/executors";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";


const shoppingAction = {
  actionId: "a1", kind: "add_to_shopping_list" as const, flagged: [] as string[],
  names: ["apple", "oat milk"],
};
const bananaAction = { ...shoppingAction, names: ["banana", "oat milk"] };

describe("loggedFoodIdentities", () => {
  it("never exempts a shopping item by its name", () => {
    expect(loggedFoodIdentities([shoppingAction])).toEqual({ names: new Set(), refs: new Set() });
  });
});

describe("checkReply (pure): a shopping item is not advice", () => {
  const evidence = { apple: { foodRefId: "ref-1", allergenTags: ["apple"], category: [],
    onEatsList: false, onAvoidList: false } };

  it("does not re-ask over an item this turn just added to the shopping list", () => {
    const result = checkReply({
      text: "Added banana and oat milk to your list.", named: [], draft: null,
      actions: [bananaAction], evidence, profile: TEST_PROFILE,
    });
    expect(result.content).toBe("Added banana and oat milk to your list.");
    expect(result.textChecks).toEqual([]);
  });

  it("re-asks when the item it added is a hard allergen (DeepSeek round 9)", () => {
    const result = checkReply({
      text: "Added apple and oat milk to your list.", named: [], draft: null,
      actions: [shoppingAction], evidence, profile: TEST_PROFILE,
    });
    expect(isReask(result.content)).toBe(true);
    expect(result.actions).toEqual([]);
  });

  it("re-asks when the reply also recommends the item it added (the audited bypass)", () => {
    for (const text of ["Apple slices are a great snack. I added apple and oat milk to your list.",
      "Added apple to your list, it's fine for you."]) {
      const result = checkReply({ text, named: [], draft: null, actions: [shoppingAction],
        evidence, profile: TEST_PROFILE });
      expect(isReask(result.content)).toBe(true);
    }
  });

  it("control: the same reply with no shopping action re-asks — apple is a hard allergen", () => {
    const result = checkReply({
      text: "Added apple and oat milk to your list.", named: [], draft: null,
      actions: [], evidence, profile: TEST_PROFILE,
    });
    expect(isReask(result.content)).toBe(true);
  });
});

describe("checkReplyLive: a shopping item is not advice", () => {
  const hit = (over: Partial<FoodHit> & { name: string }): FoodHit => ({
    foodRefId: "3f1b1a2c-0000-4000-8000-000000000021", brand: null, kcalPer100g: 52,
    prefStatus: null, allergenTags: null, category: null, ...over,
  });
  const apple = hit({ name: "Apple, raw", allergenTags: ["apple"] });
  type Input = Parameters<typeof checkReplyLive>[0] & Pick<ReplyScanInput, "userId" | "pendingActions">;
  const live = (input: Input, ports: ReplyCheckPorts) =>
    checkReplyLive(input, startReplyScan(input, ports, Date.now() + 1_000));
  // One item, not the two-item `shoppingAction` above: "oat milk" is not itself a catalog or
  // lexicon food, and a live scan that cannot resolve it at all is a different (correct) re-ask
  // than the one this test proves does not happen — see reply-check-live.test.ts's own lexicon
  // cases for that behavior.
  const appleOnly = { actionId: "a1", kind: "add_to_shopping_list" as const, flagged: [],
    names: ["apple"] };
  const banana = hit({ name: "Banana, raw", foodRefId: "3f1b1a2c-0000-4000-8000-000000000022" });
  const bananaOnly = { ...appleOnly, names: ["banana"] };

  it("keeps the reply and the action when the item it added meets the rules", async () => {
    const searchFoods = async (_u: string, q: string) => (q === "banana" ? [banana] : []);
    const result = await live({
      userId: "u1", text: "Added banana to your list.", named: [], draft: null,
      actions: [bananaOnly], evidence: {}, profile: TEST_PROFILE,
    }, { searchFoods });
    expect(result.content).toBe("Added banana to your list.");
    expect(result.actions).toEqual([bananaOnly]);
  });

  it("keeps an item the catalog does not know (nothing to clash with)", async () => {
    const towels = { ...appleOnly, names: ["paper towels"] };
    const result = await live({
      userId: "u1", text: "Added paper towels to your list.", named: [], draft: null,
      actions: [towels], evidence: {}, profile: TEST_PROFILE,
    }, { searchFoods: async () => [] });
    expect(result.content).toBe("Added paper towels to your list.");
  });

  it("re-asks when the added item is a hard allergen, even with its mirror card (DeepSeek round 9)",
    async () => {
      const searchFoods = async (_u: string, q: string) => (q === "apple" ? [apple] : []);
      const { withoutShoppingMirrors } = await import("@/lib/coach/shopping-confirmation");
      const result = await live({
        userId: "u1", text: "Added apple to your list.", draft: null,
        named: withoutShoppingMirrors([{ name: "apple" }], [appleOnly]),
        actions: [], pendingActions: [appleOnly], evidence: {}, profile: TEST_PROFILE,
      }, { searchFoods });
      expect(isReask(result.content)).toBe(true);
      expect(result.actions).toEqual([]);
    });

  it("re-asks when the item's lookup fails: a hard rule cannot be proven met", async () => {
    const result = await live({
      userId: "u1", text: "Added banana to your list.", named: [], draft: null,
      actions: [bananaOnly], evidence: {}, profile: TEST_PROFILE,
    }, { searchFoods: async () => { throw new Error("catalog down"); } });
    expect(isReask(result.content)).toBe(true);
  });

  it("re-asks when the reply recommends the item as well as adding it", async () => {
    const searchFoods = async (_u: string, q: string) => (q.includes("apple") ? [apple] : []);
    const result = await live({
      userId: "u1", text: "An apple is a perfect snack for you. Added apple to your list.",
      named: [], draft: null, actions: [appleOnly], evidence: {}, profile: TEST_PROFILE,
    }, { searchFoods });
    expect(isReask(result.content)).toBe(true);
  });

  it("control: the same food only SUGGESTED, not added to the list, still re-asks", async () => {
    const searchFoods = async (_u: string, q: string) => (q === "apple" ? [apple] : []);
    const result = await live({
      userId: "u1", text: "You could pick up an apple while you're there.", named: [], draft: null,
      actions: [], evidence: {}, profile: TEST_PROFILE,
    }, { searchFoods });
    expect(isReask(result.content)).toBe(true);
  });
});

describe("withoutShoppingMirrors", () => {
  it("drops a suggestion card that only mirrors an item this turn put on the list", async () => {
    const { withoutShoppingMirrors } = await import("@/lib/coach/shopping-confirmation");
    const cards = [{ name: "eggs" }, { name: "Oat milk" }, { name: "Salmon" }];
    // shoppingAction lists "apple" and "oat milk".
    expect(withoutShoppingMirrors(cards, [shoppingAction, { kind: "log_meal" }]).map((c) => c.name))
      .toEqual(["eggs", "Salmon"]);
    expect(withoutShoppingMirrors(cards, [])).toEqual(cards);
  });
});

/** Grok audit round 10 (HIGH): the item names are the model's own words, so a "name" carrying
 *  advice ("it's safe") must never let its sentence leave the scan. */
describe("withoutShoppingConfirmations: names the model chose", () => {
  const add = (names: string[]) => [{ kind: "add_to_shopping_list", names }];
  it("keeps a sentence whose 'item names' carry advice", async () => {
    const { withoutShoppingConfirmations } = await import("@/lib/coach/shopping-confirmation");
    const text = "Added peanuts and it's safe to your list.";
    expect(withoutShoppingConfirmations(text, add(["peanuts", "it's safe"]))).toBe(text);
    expect(withoutShoppingConfirmations("Added peanuts and it's safe to your list.",
      add(["peanuts and it's safe"]))).toBe("Added peanuts and it's safe to your list.");
  });

  it("matches names as whole phrases only", async () => {
    const { withoutShoppingConfirmations } = await import("@/lib/coach/shopping-confirmation");
    expect(withoutShoppingConfirmations("Added peanut butter to your list.", add(["pea"])))
      .toBe("Added peanut butter to your list.");
    expect(withoutShoppingConfirmations("Done, I added eggs and oat milk to your shopping list.",
      add(["eggs", "oat milk"]))).toBe("");
  });
});
