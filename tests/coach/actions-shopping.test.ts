/**
 * `add_to_shopping_list` (owner ask 2026-10-02, "make shopping super useful"): the spec's own
 * validation, its wire round-trip through the shared `stringArgs` positional codec (it spends no
 * named provider field — tests/coach/provider-schema.test.ts's 30-property budget has no room for
 * one), its grounding (plain strings, no catalog lookup), its card copy, and when the model is told
 * about it at all.
 */
import { describe, expect, it } from "vitest";
import {
  coachActionSchema, coachActionWireSchemaFor, groundActions,
} from "@/lib/coach/actions";
import { actionLine } from "@/lib/coach/history";
import { buildSystemPrompt } from "@/lib/coach/prompt";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const TODAY = "2026-10-02";
const CTX = {
  constraints: { ...TEST_PROFILE, conditions: [], notes: null },
  today: TODAY,
};

describe("add_to_shopping_list: the strict schema", () => {
  it("accepts 1 to 8 item names, each 1 to 160 characters (8: the provider rejected 20)", () => {
    expect(coachActionSchema.safeParse({
      kind: "add_to_shopping_list", names: ["eggs", "oat milk"],
    }).success).toBe(true);
    expect(coachActionSchema.safeParse({
      kind: "add_to_shopping_list", names: Array.from({ length: 8 }, (_, i) => `item ${i}`),
    }).success).toBe(true);
  });

  it("refuses an empty list, a 9th item, a blank name and an over-long name", () => {
    expect(coachActionSchema.safeParse({ kind: "add_to_shopping_list", names: [] }).success)
      .toBe(false);
    expect(coachActionSchema.safeParse({
      kind: "add_to_shopping_list", names: Array.from({ length: 9 }, (_, i) => `item ${i}`),
    }).success).toBe(false);
    expect(coachActionSchema.safeParse({ kind: "add_to_shopping_list", names: [""] }).success)
      .toBe(false);
    expect(coachActionSchema.safeParse({
      kind: "add_to_shopping_list", names: ["x".repeat(161)],
    }).success).toBe(false);
  });
});

describe("add_to_shopping_list: the wire", () => {
  it("round-trips the positional stringArgs list into `names`, in order", () => {
    const parsed = coachActionWireSchemaFor(TODAY).safeParse({
      kind: "add_to_shopping_list", stringArgs: ["eggs", "oat milk"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ kind: "add_to_shopping_list", names: ["eggs", "oat milk"] });
    }
  });

  it("refuses an empty stringArgs list — the required-on-the-wire empty sentinel", () => {
    expect(coachActionWireSchemaFor(TODAY).safeParse({
      kind: "add_to_shopping_list", stringArgs: [],
    }).success).toBe(false);
  });
});

describe("add_to_shopping_list: grounding, history and the card", () => {
  const ports = {
    searchFoods: async () => [],
    newActionId: () => "g1",
  };

  it("passes through with no catalog lookup — a shopping item is a plain string", async () => {
    const result = await groundActions("u1",
      [{ kind: "add_to_shopping_list", names: ["eggs", "oat milk"] }], TEST_PROFILE, ports);
    expect(result.clarifications).toEqual([]);
    expect(result.actions).toEqual([{
      kind: "add_to_shopping_list", names: ["eggs", "oat milk"], actionId: "g1", flagged: [],
    }]);
  });

  it("writes one history line naming every item", () => {
    expect(actionLine({
      kind: "add_to_shopping_list", names: ["eggs", "oat milk"], actionId: "a1", flagged: [],
    })).toBe("[action: add_to_shopping_list eggs, oat milk]");
  });
});

describe("add_to_shopping_list: offered only when Shopping is set up for the account", () => {
  it("is absent from the prompt by default", () => {
    expect(buildSystemPrompt(CTX)).not.toContain("add_to_shopping_list");
  });

  it("is absent when the account is explicitly not enabled", () => {
    expect(buildSystemPrompt({ ...CTX, shoppingEnabled: false })).not.toContain("add_to_shopping_list");
  });

  it("describes the action, with its worked example, once the account has access", () => {
    const prompt = buildSystemPrompt({ ...CTX, shoppingEnabled: true });
    expect(prompt).toContain("add_to_shopping_list");
    expect(prompt).toContain("add eggs and oat milk to my shopping list");
  });

  it("adds exactly this kind's own prompt block and worked example, nothing else", () => {
    const off = buildSystemPrompt(CTX);
    const on = buildSystemPrompt({ ...CTX, shoppingEnabled: true });
    const ADDED = [
      "  add_to_shopping_list { stringArgs: [...names] } — add items to the user's current shopping",
      "    list, one per name (\"eggs\", \"oat milk\"). Only offered when Shopping is set up for this",
      "    account. Never a grams amount, never a dish to cook — just the words they asked to buy.",
      '  User: "add eggs and oat milk to my shopping list"',
      '  Final: { "kind": "final", "text": "Added eggs and oat milk to your list.", '
        + '"actions": [{ "kind": "add_to_shopping_list", "stringArgs": ["eggs", "oat milk"] }] }',
    ];
    const withoutAdded = on.split("\n").filter((line) => !ADDED.includes(line)).join("\n");
    expect(withoutAdded).toBe(off);
  });
});

/** Live 2026-10-02: the model loop parses the adapter's mapped step a second time, and the mapped
 *  action carries `names`, not `stringArgs`; every shopping reply then failed the turn. */
describe("add_to_shopping_list: a mapped step parses again", () => {
  it("accepts the action in its own shape as well as the provider's positional one", async () => {
    const { coachActionWireSchemaFor } = await import("@/lib/coach/actions");
    const wire = coachActionWireSchemaFor("2026-10-02");
    expect(wire.safeParse({ kind: "add_to_shopping_list", stringArgs: ["eggs", "oat milk"] }).success).toBe(true);
    const own = wire.safeParse({ kind: "add_to_shopping_list", names: ["eggs", "oat milk"] });
    expect(own.success && own.data).toMatchObject({ kind: "add_to_shopping_list", names: ["eggs", "oat milk"] });
  });
});

