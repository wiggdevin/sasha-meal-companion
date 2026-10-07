import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { abortMessage } from "@/lib/coach/turn";
import type { FoodHit } from "@/lib/coach/executors";

const policyMock = vi.hoisted(() => ({
  notices: [] as string[],
}));
vi.mock("@/lib/server/coach-role-advice", async (original) => ({
  ...(await original<typeof import("@/lib/server/coach-role-advice")>()),
  applyGroundedActionPolicies: async (_a: unknown, _u: string, actions: unknown[]) => ({
    actions, logNotices: policyMock.notices, recipeRefusals: [],
  }),
}));

const { runTurn } = await import("@/tests/coach/fixtures/run-turn");

beforeEach(() => {
  vi.stubEnv("COACH_ENABLED", "1");
  vi.stubEnv("TYPESAFE_API_KEY", "");
  policyMock.notices = [];
});
afterEach(() => { vi.unstubAllEnvs(); });

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000099", text: "dinner?" };
const FISH = [{ avoid_allergens: ["fish"], avoid_food_ref_ids: [],
  banned_categories: [], custom_rules: [] }];
const REASK = abortMessage("unverified_text_food");

type Writes = { rows: { table: string; row: unknown }[] };
function db(tables: Record<string, unknown[]>, writes: Writes) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain,
      in: () => chain, is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      insert: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
      update: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
    });
    return chain;
  };
  return { from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [] as FoodHit[],
  getConstraints: async () => ({}),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};
const salmon: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-00000000001b",
  name: "Salmon, Atlantic, cooked", brand: null, kcalPer100g: 200, prefStatus: null,
  allergenTags: ["fish"], category: null };

function assistantRow(writes: Writes) {
  return writes.rows.filter((w) => w.table === "coach_messages").at(-1)!.row as {
    content: string; tool_calls: { blocks: { kind: string }[]; composed: unknown[] };
  };
}

describe("runTurn — the live reply check (§6 row 5, §9 R7)", () => {
  it("starts the reply check before coach-verify settles, and re-asks on a hard hit", async () => {
    const events: string[] = [];
    const searchFoods = vi.fn(async () => { events.push("search"); return [salmon]; });
    const verifyReply = vi.fn(async () => {
      events.push("verify:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push("verify:end");
      return { flagged: false };
    });
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "Try grilled salmon." });
    const writes: Writes = { rows: [] };
    await runTurn(db({ constraint_profiles: FISH }, writes), db({}, writes), "u1", REQ, {
      generate: generate as never, ports, now: () => 0, newId: () => "id-1",
      verifyReply: verifyReply as never,
      replyCheck: { searchFoods, profileRules: async () => null },
    });
    expect(events.indexOf("search")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("search")).toBeLessThan(events.indexOf("verify:end"));
    expect(assistantRow(writes).content).toBe(REASK);
  });

  it("still scans the model's prose when a log-policy note is appended to it", async () => {
    policyMock.notices = ["Off-plan: Smoked tofu."];
    const searchFoods = vi.fn(async () => [salmon]);
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "Try grilled salmon." });
    const writes: Writes = { rows: [] };
    await runTurn(db({ constraint_profiles: FISH }, writes), db({}, writes), "u1", REQ, {
      generate: generate as never, ports, now: () => 0, newId: () => "id-1",
      replyCheck: { searchFoods },
    });
    expect(searchFoods).toHaveBeenCalledWith("u1", "salmon", expect.any(Number));
    expect(assistantRow(writes).content).toBe(REASK);
  });

  it("drops food cards from a re-asked reply", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "search_foods", args: { query: "salmon" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "Try grilled salmon.",
        suggestions: [{ name: salmon.name, grams: 120 }] });
    const writes: Writes = { rows: [] };
    await runTurn(db({ constraint_profiles: FISH }, writes), db({}, writes), "u1", REQ, {
      generate: generate as never, ports: { ...ports, searchFoods: async () => [salmon] },
      now: () => 0, newId: () => "id-1",
    });
    const row = assistantRow(writes);
    expect(row.content).toBe(REASK);
    expect(row.tool_calls.blocks.filter((b) => b.kind !== "dietary_profile_proposal")).toEqual([]);
    expect(row.tool_calls.composed).toEqual([]);
  });

  // Live smoke, 2026-10-02: "I had a banana as a snack" was logged by the model, then the reply
  // check re-asked and dropped the log. The scan started before grounding, so the exemption for the
  // turn's own logged foods (finding #6) always saw an empty action list; and the slot word
  // "snack" in the prose was swept up as a food to resolve.
  it("keeps the reply and the log when the prose names the food being logged", async () => {
    const granola: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-00000000001c",
      name: "Granola bar", brand: null, kcalPer100g: 450, prefStatus: null, category: null };
    const snacks: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-00000000001d",
      name: "Snack mix", brand: null, kcalPer100g: 500, prefStatus: null, category: null };
    const search = async (_u: string, query: string) => /snack/i.test(query) ? [snacks] : [granola];
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final",
      text: "Logged 1 granola bar, 40 g, as a snack.",
      suggestions: [{ name: "Granola bar", grams: 40 }],
      actions: [{ kind: "log_meal", date: "2026-09-11", slot: "snack", title: "Granola bar",
        items: [{ name: "Granola bar", grams: 40 }], at: "15:00" }] });
    const writes: Writes = { rows: [] };
    await runTurn(db({ constraint_profiles: FISH }, writes), db({}, writes), "u1",
      { ...REQ, text: "I had a granola bar as a snack" }, {
        generate: generate as never, ports: { ...ports, searchFoods: search }, now: () => 0,
        newId: () => "id-1", replyCheck: { searchFoods: search, profileRules: async () => null },
      });
    const row = assistantRow(writes) as unknown as { content: string; tool_calls: { actions: unknown[] } };
    expect(row.content).not.toBe(REASK);
    expect(row.tool_calls.actions).toHaveLength(1);
  });

  // 2026-10-02 DeepSeek audit (finding #3): the exemption used to be keyed on the model's RAW,
  // pre-grounding log_meal names — read before groundAll() ever ran — so an advised food the model
  // claimed to log but that never actually grounded (no catalog row; log-meal.ts turns it into a
  // clarification) rode the exemption with no real log behind it. The grounding port below finds
  // nothing for "sourdough bread" (ungroundable); the reply-check's own port still finds a real,
  // gluten-tagged catalog row for it, so the prose scan must still catch and re-ask on it.
  const GLUTEN = [{ avoid_allergens: ["gluten"], avoid_food_ref_ids: [],
    banned_categories: [], custom_rules: [] }];

  it("re-asks on an advised food a log_meal claims but never actually grounds", async () => {
    const sourdough: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-00000000001e",
      name: "Sourdough bread", brand: null, kcalPer100g: 270, prefStatus: null,
      allergenTags: ["gluten"], category: null };
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final",
      text: "Try sourdough bread with lunch?",
      actions: [{ kind: "log_meal", date: "2026-09-11", slot: "meal-2", title: "Sourdough bread",
        items: [{ name: "sourdough bread", grams: 60 }], at: "12:00" }] });
    const writes: Writes = { rows: [] };
    await runTurn(db({ constraint_profiles: GLUTEN }, writes), db({}, writes), "u1",
      { ...REQ, text: "what should I have for lunch" }, {
        generate: generate as never,
        // Grounding (the turn's own search) finds nothing at all for it.
        ports: { ...ports, searchFoods: async () => [] },
        now: () => 0, newId: () => "id-1",
        // The reply-check's own search still resolves it, so the prose scan can judge it.
        replyCheck: { searchFoods: async () => [sourdough], profileRules: async () => null },
      });
    const row = assistantRow(writes) as unknown as { content: string; tool_calls: { actions: unknown[] } };
    expect(row.content).toBe(REASK);
    expect(row.tool_calls.actions).toEqual([]);
  });

  it("keeps the reply when the same advised food actually grounds and logs", async () => {
    const sourdough: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-00000000001e",
      name: "Sourdough bread", brand: null, kcalPer100g: 270, prefStatus: null,
      allergenTags: ["gluten"], category: null };
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final",
      text: "Try sourdough bread with lunch?",
      actions: [{ kind: "log_meal", date: "2026-09-11", slot: "meal-2", title: "Sourdough bread",
        items: [{ name: "sourdough bread", grams: 60 }], at: "12:00" }] });
    const writes: Writes = { rows: [] };
    await runTurn(db({ constraint_profiles: GLUTEN }, writes), db({}, writes), "u1",
      { ...REQ, text: "what should I have for lunch" }, {
        generate: generate as never,
        ports: { ...ports, searchFoods: async () => [sourdough] },
        now: () => 0, newId: () => "id-1",
        replyCheck: { searchFoods: async () => [sourdough], profileRules: async () => null },
      });
    const row = assistantRow(writes) as unknown as { content: string; tool_calls: { actions: unknown[] } };
    expect(row.content).not.toBe(REASK);
    expect(row.tool_calls.actions).toHaveLength(1);
  });

  // DeepSeek audit round 10: a clarification REPLACES the reply, so no prose is scanned, yet the
  // turn's shopping add must still meet the account's hard rules.
  describe("a shopping add beside a log that needs a clarification", () => {
    const sourdough: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-00000000001e",
      name: "Sourdough bread", brand: null, kcalPer100g: 270, prefStatus: null,
      allergenTags: ["gluten"], category: null };
    const banana: FoodHit = { foodRefId: "3f1b1a2c-0000-4000-8000-00000000001f",
      name: "Banana, raw", brand: null, kcalPer100g: 89, prefStatus: null, category: null };
    const turnWith = async (item: string | string[], hit: FoodHit | ((q: string) => FoodHit[])) => {
      const names = Array.isArray(item) ? item : [item];
      const generate = vi.fn().mockResolvedValueOnce({ kind: "final",
        text: `Logged your lasagna. Added ${names.join(" and ")} to your list.`,
        actions: [
          { kind: "log_meal", date: "2026-09-11", slot: "meal-2", title: "Lasagna",
            items: [{ name: "mom's lasagna", grams: 300 }], at: "12:00" },
          { kind: "add_to_shopping_list", names },
        ] });
      const search = typeof hit === "function" ? hit : () => [hit];
      const writes: Writes = { rows: [] };
      await runTurn(db({ constraint_profiles: GLUTEN }, writes), db({}, writes), "u1",
        { ...REQ, text: `I had mom's lasagna and add ${item} to my list` }, {
          generate: generate as never,
          // Grounding finds nothing for the lasagna, so the log turns into a clarification.
          ports: { ...ports, searchFoods: async () => [] },
          now: () => 0, newId: () => "id-1",
          replyCheck: { searchFoods: async (_u: string, q: string) => search(q),
            profileRules: async () => null },
        });
      return assistantRow(writes) as unknown as { content: string;
        tool_calls: { actions: { kind: string; names?: string[] }[] } };
    };

    it("does not add an item that breaks a hard rule, and says so", async () => {
      const row = await turnWith("sourdough bread", sourdough);
      expect(row.tool_calls.actions.map((a) => a.kind)).not.toContain("add_to_shopping_list");
      expect(row.content).toContain("I did not add sourdough bread to your shopping list");
    });

    it("adds the items that meet the rules and names only the one it left off (round 11)", async () => {
      const row = await turnWith(["banana", "sourdough bread"],
        (q) => (q === "banana" ? [banana] : [sourdough]));
      const add = row.tool_calls.actions.find((a) => a.kind === "add_to_shopping_list");
      expect(add?.names).toEqual(["banana"]);
      expect(row.content).toContain("I did not add sourdough bread to your shopping list");
      expect(row.content).not.toContain("banana, sourdough");
    });

    it("never calls a dropped add 'ready' (round 11)", async () => {
      const row = await turnWith("sourdough bread", sourdough);
      expect(row.content).not.toMatch(/ready/);
    });

    it("adds nothing when the check cannot finish", async () => {
      const row = await turnWith(["banana", "sourdough bread"], () => {
        throw new Error("catalog down");
      });
      expect(row.tool_calls.actions.map((a) => a.kind)).not.toContain("add_to_shopping_list");
      expect(row.content).toContain("I did not add banana, sourdough bread");
    });

    // Grok audit round 11: with the reply replaced, the cards beside it were never scanned.
    it("shows no card it could not check", async () => {
      const generate = vi.fn().mockResolvedValueOnce({ kind: "final",
        text: "Logged your lasagna. Try a mystery bar or a banana later.",
        suggestions: [{ name: "Mystery bar", foodRefId: "3f1b1a2c-0000-4000-8000-0000000000aa" },
          { name: banana.name }],
        actions: [{ kind: "log_meal", date: "2026-09-11", slot: "meal-2", title: "Lasagna",
          items: [{ name: "mom's lasagna", grams: 300 }], at: "12:00" }] });
      const writes: Writes = { rows: [] };
      await runTurn(db({ constraint_profiles: GLUTEN }, writes), db({}, writes), "u1",
        { ...REQ, text: "I had mom's lasagna" }, {
          generate: generate as never,
          ports: { ...ports, searchFoods: async (_u: string, q: string) =>
            /banana/i.test(q) ? [banana] : [] },
          now: () => 0, newId: () => "id-1",
          replyCheck: { searchFoods: async () => [banana], profileRules: async () => null },
        });
      const row = assistantRow(writes) as unknown as { tool_calls: { suggestions: { name: string }[] } };
      expect(row.tool_calls.suggestions.map((c) => c.name)).not.toContain("Mystery bar");
    });

    it("keeps an item that meets the rules", async () => {
      const row = await turnWith("banana", banana);
      expect(row.tool_calls.actions.map((a) => a.kind)).toContain("add_to_shopping_list");
      expect(row.content).not.toContain("I did not add");
    });
  });
});
