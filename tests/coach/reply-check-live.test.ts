import { describe, expect, it, vi } from "vitest";
import { isReask } from "@/lib/coach/reask";
import {
  checkReplyLive, hasActiveHardRules, startReplyScan, type ReplyCheckPorts, type ReplyScanInput,
} from "@/lib/server/reply-check";
import { candidatePhrases, hitNamesPhrase, lexiconMentions } from "@/lib/coach/reply-mentions";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";
import type { FoodHit } from "@/lib/coach/executors";
import type { ProfileRuleSet } from "@/lib/policy/profiles/hard-rules";
import { ruleId } from "@/lib/policy/profiles/types";

const REF = (n: number) => `3f1b1a2c-0000-4000-8000-00000000000${n}`;
const hit = (over: Partial<FoodHit> & { name: string }): FoodHit => ({
  foodRefId: REF(1), brand: null, kcalPer100g: 100,
  prefStatus: null, allergenTags: null, category: null, ...over,
});
const allowedHit = (name: string, over: Partial<FoodHit> = {}) => hit({
  name, allergenTags: [], prefStatus: "eats", checkedAllergens: ["gluten", "dairy", "apple"], ...over,
});

type Input = Parameters<typeof checkReplyLive>[0] & Pick<ReplyScanInput, "userId" | "blockFoods">;
const baseInput = (over: Partial<Input> = {}): Input => ({
  userId: "u1", text: "How about that for today?", named: [], draft: null, actions: [],
  evidence: {}, profile: EMPTY_PROFILE, ...over,
});
const live = (input: Input, ports: ReplyCheckPorts, budgetMs = 1_000) =>
  checkReplyLive(input, startReplyScan(input, ports, Date.now() + budgetMs));
const FISH = { ...EMPTY_PROFILE, avoid_allergens: ["fish"] };

describe("hasActiveHardRules", () => {
  it("is false for a profile with nothing to avoid", () => {
    expect(hasActiveHardRules(EMPTY_PROFILE)).toBe(false);
  });

  it("is true once any hard list carries an entry", () => {
    expect(hasActiveHardRules(TEST_PROFILE)).toBe(true);
    expect(hasActiveHardRules({ ...EMPTY_PROFILE, avoid_food_ref_ids: ["x"] })).toBe(true);
    expect(hasActiveHardRules({ ...EMPTY_PROFILE, banned_categories: ["simple_sugars"] })).toBe(true);
  });
});

describe("reply mentions", () => {
  it("finds every lexicon food however long the reply, longest match first", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `wordnum${i}`).join(" ");
    expect(lexiconMentions(`${filler} and then grilled salmon with chicken breast.`))
      .toEqual(expect.arrayContaining(["salmon", "chicken breast"]));
    expect(lexiconMentions("Two eggs")).toEqual(["egg"]);
    expect(lexiconMentions("Drink some water on those dates.")).toEqual([]);
  });

  it("keeps the best-effort sweep bounded and free of stopwords", () => {
    const words = Array.from({ length: 40 }, (_, i) => `wordnum${i}`).join(" ");
    expect(candidatePhrases(words, new Set()).length).toBeLessThanOrEqual(6);
    expect(candidatePhrases("You could try some natto with lunch.", new Set())).toContain("natto");
    expect(candidatePhrases("You could try some natto.", new Set())).not.toContain("you");
  });

  it("matches a catalog hit by its head, never by a longer dish name", () => {
    expect(hitNamesPhrase("Salmon, Atlantic, farmed, cooked", "salmon")).toBe(true);
    expect(hitNamesPhrase("Eggs, whole, raw", "egg")).toBe(true);
    expect(hitNamesPhrase("Breakfast burrito", "breakfast")).toBe(false);
  });
});

describe("checkReplyLive — no hard rules", () => {
  it("never calls the catalog search and leaves the reply untouched", async () => {
    const searchFoods = vi.fn();
    const profileRules = vi.fn(async () => null);
    const text = "Salmon would be a great choice for dinner tonight.";
    const result = await live(baseInput({ text }), { searchFoods, profileRules });
    expect(profileRules).toHaveBeenCalledWith("u1");
    expect(searchFoods).not.toHaveBeenCalled();
    expect(result.content).toBe(text);
  });
});

/** Owner ruling 2026-10-02: religious and other profile hard rules fail safe. A rules read that
 *  errors or never answers cannot prove the account has none, so the reply re-asks. */
describe("checkReplyLive — an unreadable profile-rule read", () => {
  const text = "Salmon would be a great choice for dinner tonight.";

  it("re-asks when the rules read fails, even with no legacy rule", async () => {
    const profileRules = vi.fn(async () => { throw new Error("db down"); });
    const result = await live(baseInput({ text }), { searchFoods: vi.fn(), profileRules });
    expect(isReask(result.content)).toBe(true);
  });

  it("re-asks when the rules read never answers inside the scan's budget", async () => {
    const profileRules = vi.fn(() => new Promise<null>(() => {}));
    const result = await live(baseInput({ text }), { searchFoods: vi.fn(), profileRules }, 50);
    expect(isReask(result.content)).toBe(true);
  });
});

describe("checkReplyLive — free-text-only replies (R7)", () => {
  it("re-asks when the prose names a food whose catalog row blocks, matched by its head", async () => {
    const searchFoods = vi.fn(async (_u: string, query: string) => query === "salmon"
      ? [hit({ name: "Salmon, Atlantic, farmed, cooked", allergenTags: ["fish"] })] : []);
    const result = await live(baseInput({ text: "Grilled salmon tonight.", profile: FISH }),
      { searchFoods });
    expect(isReask(result.content)).toBe(true);
    expect(result.textChecks).toEqual([expect.objectContaining({ name: "salmon", verdict: "blocked" })]);
  });

  it("re-asks when a lexicon food has no catalog match at all", async () => {
    const searchFoods = vi.fn(async () => [] as FoodHit[]);
    const result = await live(baseInput({ text: "A bit of arugula on the side.", profile: TEST_PROFILE }),
      { searchFoods });
    expect(isReask(result.content)).toBe(true);
    expect(result.textChecks.map((c) => c.name)).toEqual(["arugula"]);
  });

  it("re-asks when the catalog row has no checked id", async () => {
    const searchFoods = vi.fn(async () => [hit({ name: "Quinoa, cooked", foodRefId: null })]);
    const result = await live(baseInput({ text: "Quinoa works well.", profile: TEST_PROFILE }),
      { searchFoods });
    expect(isReask(result.content)).toBe(true);
  });

  it("checks a food named late in a long reply", async () => {
    const searchFoods = vi.fn(async (_u: string, query: string) => query === "salmon"
      ? [hit({ name: "Salmon, raw", allergenTags: ["fish"] })] : []);
    const text = "Great work staying consistent this week with breakfast lunch snacks timing "
      + "hydration sleep and walking, and for dinner tonight try salmon.";
    const result = await live(baseInput({ text, profile: FISH }), { searchFoods });
    expect(isReask(result.content)).toBe(true);
  });

  it("does not re-ask when the resolved food is allowed", async () => {
    const searchFoods = vi.fn(async (_u: string, query: string) =>
      query === "rice" ? [allowedHit("Rice, white, cooked")] : []);
    const text = "Some plain rice with dinner tonight.";
    const result = await live(baseInput({ text, profile: TEST_PROFILE }), { searchFoods });
    expect(result.content).toBe(text);
    expect(result.textChecks).toEqual([]);
  });

  it("does not treat ordinary prose with no catalog match as a food mention", async () => {
    const searchFoods = vi.fn(async () => [] as FoodHit[]);
    const text = "That sounds like a solid plan for today, let's keep going.";
    const result = await live(baseInput({ text, profile: TEST_PROFILE }), { searchFoods });
    expect(result.content).toBe(text);
  });
});

describe("checkReplyLive — fails closed on its own deadline and errors", () => {
  it("re-asks when a search rejects", async () => {
    const searchFoods = vi.fn(async () => { throw new Error("catalog 503"); });
    const result = await live(baseInput({ text: "Try salmon.", profile: FISH }), { searchFoods });
    expect(isReask(result.content)).toBe(true);
    expect(result.textChecks).toEqual([expect.objectContaining({ reason: "reply_check_incomplete" })]);
  });

  it("re-asks at its own deadline instead of waiting for a slow search", async () => {
    const searchFoods = vi.fn(() => new Promise<FoodHit[]>(() => undefined));
    const started = Date.now();
    const result = await live(baseInput({ text: "Try salmon.", profile: FISH }), { searchFoods }, 50);
    expect(Date.now() - started).toBeLessThan(500);
    expect(isReask(result.content)).toBe(true);
  });

  it("passes a reply with no hard rules even when a search would fail", async () => {
    const searchFoods = vi.fn(async () => { throw new Error("catalog 503"); });
    const text = "Try salmon.";
    expect((await live(baseInput({ text }), { searchFoods })).content).toBe(text);
  });
});

describe("checkReplyLive — mixed replies (blocks + prose)", () => {
  it("combines an already-evidenced blocked food with a separately live-resolved one", async () => {
    const evidence = {
      pizza: { foodRefId: REF(2), allergenTags: ["dairy"], category: null,
        onEatsList: false, onAvoidList: false },
    };
    const searchFoods = vi.fn(async () => [] as FoodHit[]);
    const result = await live(baseInput({
      text: "Pizza tonight, and maybe a little arugula on the side.", evidence, profile: TEST_PROFILE,
    }), { searchFoods });
    expect(isReask(result.content)).toBe(true);
    expect(result.textChecks.map((c) => c.name).sort()).toEqual(["arugula", "pizza"]);
  });

  it("uses a suggestion's searched id instead of searching again", async () => {
    const searchFoods = vi.fn(async () => [] as FoodHit[]);
    const text = "Chicken breast fits your targets well today.";
    const result = await live(baseInput({
      text, profile: TEST_PROFILE,
      named: [{ name: "chicken breast", foodRefId: REF(3) }],
      evidence: { "chicken breast": { foodRefId: REF(3), allergenTags: [], category: [],
        onEatsList: true, onAvoidList: false, checkedAllergens: ["gluten", "dairy", "apple"] } },
    }), { searchFoods });
    expect(searchFoods).not.toHaveBeenCalledWith("u1", "chicken breast", expect.anything());
    expect(result.content).toBe(text);
  });

  it("re-asks when a suggestion's id came only from the model", async () => {
    const searchFoods = vi.fn(async () => [] as FoodHit[]);
    const result = await live(baseInput({
      text: "Here is an idea.", profile: TEST_PROFILE,
      named: [{ name: "chicken breast", foodRefId: REF(3) }],
    }), { searchFoods });
    expect(isReask(result.content)).toBe(true);
    expect(result.textChecks).toEqual([expect.objectContaining({ reason: "unchecked_id" })]);
  });
});

/** 2026-10-17 rerun item 2: only a food held as unchecked, with nothing against it, may be offered. */
describe("startReplyScan — offerEats", () => {
  const scanOf = (input: Input) => startReplyScan(input, { searchFoods: vi.fn(async () => [] as FoodHit[]) },
    Date.now() + 1_000);

  it("marks a model-only card nothing rules out", async () => {
    const result = await scanOf(baseInput({ text: "Here is an idea.", profile: FISH,
      named: [{ name: "watermelon", foodRefId: REF(3) }] }));
    expect(result.failing).toEqual([{ name: "watermelon", reason: "unchecked_id", offerEats: true }]);
  });

  it("never marks a model-only card whose name a rule blocks", async () => {
    const result = await scanOf(baseInput({ text: "Here is an idea.", profile: FISH,
      named: [{ name: "salmon", foodRefId: REF(3) }] }));
    // Policy already blocks the card by its name, so it is checked, not unchecked; never offered.
    expect(result.failing.some((f) => f.offerEats)).toBe(false);
  });

  it("never marks anything when the scan did not finish", async () => {
    const searchFoods = vi.fn(async () => { throw new Error("down"); });
    const result = await startReplyScan(baseInput({ text: "Have some natto and watermelon.",
      profile: FISH, named: [{ name: "watermelon", foodRefId: REF(3) }] }), { searchFoods },
    Date.now() + 1_000);
    expect(result.complete).toBe(false);
    expect(result.failing.some((f) => f.offerEats)).toBe(false);
  });
});

describe("checkReplyLive — cards policy already blocked (§6 block ids first, Phase 7)", () => {
  const DAIRY_REF = REF(5);
  const NO_DAIRY = { ...EMPTY_PROFILE, avoid_allergens: ["dairy"], avoid_food_ref_ids: [DAIRY_REF] };
  const yoghurt = { name: "yoghurt", foodRefId: DAIRY_REF, grams: 200 };
  const noSearch = () => vi.fn(async () => [] as FoodHit[]);

  it("resolves a card through the draft block's catalog id, not as a model-only id", async () => {
    const result = await live(baseInput({
      text: "Here is what I found.", profile: NO_DAIRY, named: [yoghurt],
      blockFoods: [{ name: "yoghurt", foodRefId: DAIRY_REF }],
    }), { searchFoods: noSearch() });
    expect(result.content).toBe("Here is what I found.");
    expect(result.suggestions).toEqual([expect.objectContaining({ name: "yoghurt", verdict: "blocked" })]);
    expect(result.textChecks).toEqual([]);
  });

  it("treats a model id that policy already blocks as checked: the card recommends nothing", async () => {
    const result = await live(baseInput({ text: "Here is what I found.", profile: NO_DAIRY, named: [yoghurt] }),
      { searchFoods: noSearch() });
    expect(result.content).toBe("Here is what I found.");
    expect(result.textChecks).toEqual([]);
  });

  it("keeps the blocked card, with its reason, when the prose names it and the reply re-asks", async () => {
    const result = await live(baseInput({
      text: "Yoghurt is not one for today.", profile: NO_DAIRY, named: [yoghurt],
      blockFoods: [{ name: "yoghurt", foodRefId: DAIRY_REF }],
    }), { searchFoods: noSearch() });
    expect(isReask(result.content)).toBe(true);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ name: "yoghurt", verdict: "blocked" });
    expect(result.suggestions[0].reason).toBeTruthy();
    expect(result.textChecks.map((c) => c.reason)).not.toContain("unchecked_id");
  });

  it("drops every card that is not blocked from a re-ask", async () => {
    const result = await live(baseInput({
      text: "Yoghurt or a little arugula.", profile: NO_DAIRY,
      named: [yoghurt, { name: "rice", foodRefId: null }],
      evidence: { rice: { foodRefId: REF(6), allergenTags: [], category: [], onEatsList: true,
        onAvoidList: false, checkedAllergens: ["dairy"] } },
    }), { searchFoods: noSearch() });
    expect(isReask(result.content)).toBe(true);
    expect(result.suggestions.map((s) => [s.name, s.verdict])).toEqual([["yoghurt", "blocked"]]);
  });
});

describe("checkReplyLive — confirmed profile hard rules (§6 row 5)", () => {
  const rules: ProfileRuleSet = { asOf: new Date(), items: [{
    id: ruleId("halal", "pork"), profileId: "halal", facet: "pork", strength: "never",
    hardBasis: "religious", evidenceStrength: "user_rule", confirmation: "confirmed", expiresAt: null,
  }] };
  const bacon = hit({ name: "Bacon, cooked", foodRefId: REF(4), catalogFoodRevisionId: 44 });

  it("blocks on the food's own name with no legacy rule at all, whatever a cache says (W2c)", async () => {
    const foodEvidence = vi.fn(async () => new Map([[REF(4), { foodName: "Bacon, cooked" }]]));
    const result = await live(baseInput({ text: "Add bacon to breakfast." }), {
      searchFoods: vi.fn(async () => [bacon]), profileRules: async () => rules, foodEvidence,
    });
    expect(isReask(result.content)).toBe(true);
    expect(result.textChecks).toEqual([expect.objectContaining({ name: "bacon", reason: "rule:pork" })]);
    expect(foodEvidence).toHaveBeenCalledWith("u1", [{ foodRefId: REF(4), catalogFoodRevisionId: 44 }]);
  });

  it("keeps the reply when the food's stored evidence rules the facet out; no Jev tag runs", async () => {
    const broccoli = hit({ name: "Broccoli, raw", foodRefId: REF(5), catalogFoodRevisionId: 55 });
    const text = "Add broccoli to dinner.";
    const result = await live(baseInput({ text }), {
      searchFoods: vi.fn(async () => [broccoli]), profileRules: async () => rules,
      foodEvidence: async () => new Map([[REF(5), { foodName: "Broccoli, raw" }]]),
    });
    expect(result.content).toBe(text);
  });

  it("re-asks when the facet stays unknown, and when the evidence read fails", async () => {
    // A sausage may or may not be pork: its name alone decides nothing.
    const mystery = hit({ name: "Sausage, cooked", foodRefId: REF(8), catalogFoodRevisionId: 88 });
    const text = "Add sausage to breakfast.";
    const unknown = await live(baseInput({ text }), {
      searchFoods: vi.fn(async () => [mystery]), profileRules: async () => rules,
      foodEvidence: async () => new Map([[REF(8), { foodName: "Sausage, cooked" }]]),
    });
    expect(isReask(unknown.content)).toBe(true);
    const failed = await live(baseInput({ text }), {
      searchFoods: vi.fn(async () => [mystery]), profileRules: async () => rules,
      foodEvidence: async () => { throw new Error("read failed"); },
    });
    expect(failed.content).not.toBe(text);
  });

  // 2026-10-02 DeepSeek audit (finding #6): a food the user says they ATE is their own record, not
  // advice — "Log one medium banana for my snack" used to have its log_meal action and reply BOTH
  // replaced by the re-ask, just because the prose scan found "banana" with an unknown pork facet.
  // log_meal already marks items of its own via log-policy notices; a food that is one of THIS
  // turn's logged items is exempt from the prose check here, by name or by its grounded foodRefId.
  const banana = hit({ name: "Banana, raw", foodRefId: REF(7), catalogFoodRevisionId: 77 });
  const bananaLogMeal = {
    actionId: "a1", kind: "log_meal" as const, date: "2026-09-20", slot: "snack" as const, flagged: [],
    items: [{ name: "banana", grams: 118, foodRefId: REF(7), catalogFoodRevisionId: 77,
      kcalPer100g: 89, proteinPer100g: 1.1, carbsPer100g: 22.8, fatPer100g: 0.3,
      verdict: "allowed" as const }],
  };

  it("keeps the reply and the log_meal action when the only unresolved food is the one being logged", async () => {
    const result = await live(baseInput({
      text: "Logged one medium banana as a snack.", actions: [bananaLogMeal],
    }), {
      searchFoods: vi.fn(async () => [banana]), profileRules: async () => rules,
      foodEvidence: async () => new Map(),
    });
    expect(result.content).toBe("Logged one medium banana as a snack.");
    expect(result.actions).toEqual([bananaLogMeal]);
  });

  it("keeps a mirror card of the logged food, with no id or with the logged id", async () => {
    for (const card of [{ name: "banana" }, { name: "banana", foodRefId: REF(7) }]) {
      const result = await live(baseInput({ text: "Logged one medium banana as a snack.",
        actions: [bananaLogMeal], named: [card] }), {
        searchFoods: vi.fn(async () => [banana]), profileRules: async () => rules,
        foodEvidence: async () => new Map(),
      });
      expect(result.content).toBe("Logged one medium banana as a snack.");
    }
  });

  // Grok audit round 12: a card named like the log but holding another food's id is advice.
  it("judges a card named like the logged food that carries a different id", async () => {
    const result = await live(baseInput({ text: "Logged one medium banana as a snack.",
      actions: [bananaLogMeal], named: [{ name: "banana", foodRefId: bacon.foodRefId! }] }), {
      searchFoods: vi.fn(async () => [banana]), profileRules: async () => rules,
      foodEvidence: async () => new Map(),
    });
    expect(isReask(result.content)).toBe(true);
  });

  it("control: a SUGGESTED food (not logged) with an unknown facet still re-asks", async () => {
    const result = await live(baseInput({
      text: "You could also try bacon with that.", actions: [bananaLogMeal],
    }), {
      searchFoods: vi.fn(async (_u: string, q: string) => q === "bacon" ? [bacon] : []),
      profileRules: async () => rules, foodEvidence: async () => new Map(),
    });
    expect(isReask(result.content)).toBe(true);
    expect(result.actions).toEqual([]);
  });
});

/**
 * 2026-10-02 DeepSeek audit, round 4. #2: the scan waited for grounding before it started its own
 * catalog searches, so a slow grounding spent the scan's whole budget and a good turn became a
 * re-ask. #3: a rejected sweep search read as "no match", where every other rejected search
 * re-asks (§9 R7).
 */
describe("checkReplyLive — round-4 audit", () => {
  const DAIRY = { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] };
  const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

  it("runs its catalog searches while grounding settles, not after it", async () => {
    const searchFoods = vi.fn(async (_u: string, phrase: string) => later(350, [allowedHit(phrase)]));
    const input = { ...baseInput({ text: "Try rice with lunch.", profile: DAIRY }),
      groundedLogged: later(350, { names: new Set<string>(), refs: new Set<string>() }) };
    const result = await live(input, { searchFoods }, 600);
    expect(searchFoods).toHaveBeenCalled();
    expect(result.content).toBe("Try rice with lunch.");
  });

  it("re-asks when a sweep phrase's search is rejected", async () => {
    const searchFoods = vi.fn(async (_u: string, phrase: string) => {
      if (phrase.includes("zorbleberry")) throw new Error("503");
      return [allowedHit(phrase)];
    });
    const input = baseInput({ text: "You could try zorbleberry with lunch?", profile: DAIRY });
    const result = await live(input, { searchFoods });
    expect(searchFoods.mock.calls.some(([, p]) => String(p).includes("zorbleberry"))).toBe(true);
    expect(isReask(result.content)).toBe(true);
  });

  /** Grok audit round 6 (BLOCK, rejected with this evidence): a phrase is held by a card only
   *  when the card's own name or head names it, never a longer dish ("rice" never holds "rice
   *  pudding"), so a held phrase whose card was logged IS the logged food. Any other phrase is
   *  searched and judged even when it shares a word with the logged card. */
  it("holds a phrase only for the card it names: a longer dish is never swallowed", () => {
    expect(hitNamesPhrase("rice", "rice pudding")).toBe(false);
    expect(hitNamesPhrase("Yogurt bowl", "yogurt")).toBe(false);
    expect(hitNamesPhrase("Rice, white, cooked", "rice")).toBe(true);
  });

  it("searches and judges an advised food that shares a word with the logged card", async () => {
    const searchFoods = vi.fn(async (_u: string, phrase: string) =>
      [hit({ name: phrase, foodRefId: REF(7), allergenTags: ["dairy"] })]);
    const input = { ...baseInput({ text: "Try the yogurt bowls again tomorrow.", profile: DAIRY,
      named: [{ name: "Yogurt bowl", foodRefId: REF(8) }] }),
      groundedLogged: Promise.resolve({ names: new Set(["yogurt bowl"]), refs: new Set([REF(8)]) }) };
    const result = await live(input, { searchFoods });
    expect(searchFoods).toHaveBeenCalled();
    expect(isReask(result.content)).toBe(true);
  });

  it("exempts the logged food itself when its phrase comes back as the logged ref", async () => {
    const searchFoods = vi.fn(async (_u: string, phrase: string) =>
      [hit({ name: phrase, foodRefId: REF(8), allergenTags: ["dairy"] })]);
    const input = { ...baseInput({ text: "Logged your yogurt bowls.", profile: DAIRY,
      named: [{ name: "Yogurt bowl", foodRefId: REF(8) }] }),
      groundedLogged: Promise.resolve({ names: new Set(["yogurt bowl"]), refs: new Set([REF(8)]) }) };
    const result = await live(input, { searchFoods });
    expect(result.content).toBe("Logged your yogurt bowls.");
  });
});
