/**
 * W087 follow-up (docs/evals/2026-10-17-coach-live-pass.md): the coach streak passed 13 of 40
 * turns, and about 14 failures ended on "I couldn't work that one out" with no logged reason.
 *
 * The pass's own ledger shows no reply failed the schema (0 of 118 calls `schema_invalid`), so the
 * generic line came from two places: the model's own `abort` step, and the food-rule re-ask that
 * replaced a good answer (a profile with gluten, dairy and legume rules). These tests hold:
 *   - the reason is logged, with codes and counts only, never the person's words or a food name;
 *   - a schema refusal names the field, the variant rule and the finish reason, never a value;
 *   - a placeholder action the model filled the required array with no longer throws the reply away;
 *   - the model's abort gets one correction round;
 *   - the re-ask says which food it held back and why, and an Eats or Avoid mark the person asked
 *     for is no longer dropped because the reply names its food.
 */
import { withCoachSaveTurn } from "@/tests/helpers/coach-save-turn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseModelJson, schemaIssueSummary } from "@/lib/ai/call";
import type { CoachAction } from "@/lib/coach/actions";
import { isReask, reaskMessage, reaskReasonCode, REASK_INCOMPLETE, REASK_TAIL } from "@/lib/coach/reask";
import { withoutListMarkConfirmations, withoutListMarkMirrors } from "@/lib/coach/list-mark-confirmation";
import { checkReply, loggedFoodIdentities } from "@/lib/coach/reply-check";
import { ABORT_CORRECTION, abortMessage } from "@/lib/coach/turn";
import { turnStepWireSchemaFor } from "@/lib/coach/wire";
import { runTurn } from "@/lib/server/coach-turn";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

const TODAY = "2026-10-17";
const wire = turnStepWireSchemaFor(TODAY);

/** Every key the provider schema requires, empty: the shape a live reply arrives in. */
const EMPTY = { calls: [], actions: [], suggestions: [], text: "", memory: [], reason: "" };
/** One action as the provider sends it: every named key present, most of them empty. */
const PLACEHOLDER_ACTION = {
  kind: "log_meal", date: "", from: "", through: "", weekdays: [], title: "", slot: "meal-1",
  items: [{ name: "", grams: 0 }], item: { name: "", grams: 0 }, name: "", grams: 0, entryId: "",
  numericArgs: [], stringArgs: [],
};

describe("the turn step wire parse (W087 failing shapes)", () => {
  it("keeps a final reply whose actions array holds only an empty log_meal placeholder", () => {
    const parsed = wire.safeParse({ ...EMPTY, kind: "final", text: "Spaghetti bolognese has gluten.",
      actions: [PLACEHOLDER_ACTION] });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ kind: "final", text: "Spaghetti bolognese has gluten." });
  });

  it("keeps a final reply with an empty add_to_eats placeholder beside a real action (F010)", () => {
    const parsed = wire.safeParse({ ...EMPTY, kind: "final", text: "Adding salmon to your Favored list.",
      actions: [{ ...PLACEHOLDER_ACTION, kind: "add_to_eats", slot: "meal-2", date: TODAY },
        { ...PLACEHOLDER_ACTION, kind: "add_to_eats", name: "salmon" }] });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ kind: "final",
      actions: [{ kind: "add_to_eats", name: "salmon" }] });
  });

  it("still refuses an action with content its schema rejects, and names the rule, not the food", () => {
    const parsed = wire.safeParse({ ...EMPTY, kind: "final", text: "Logged it.",
      actions: [{ ...PLACEHOLDER_ACTION, items: [{ name: "smoked tofu", grams: 0 }] }] });
    expect(parsed.success).toBe(false);
    const summary = schemaIssueSummary(parsed.error!);
    expect(summary).toBe("(root):custom(action_0_log_meal_unsupported)");
    expect(summary).not.toContain("tofu");
  });

  it("never drops a skip_slot as a placeholder: its whole action is a date and a slot", () => {
    const parsed = wire.safeParse({ ...EMPTY, kind: "final", text: "Skipped your snack.",
      actions: [{ ...PLACEHOLDER_ACTION, kind: "skip_slot", slot: "snack", date: "not a date" }] });
    expect(parsed.success).toBe(false);
    expect(schemaIssueSummary(parsed.error!)).toBe("(root):custom(action_0_skip_slot_unsupported)");
  });

  it("names a tool step with no named call", () => {
    const parsed = wire.safeParse({ ...EMPTY, kind: "tool", calls: [{ name: "", args: "{}" }] });
    expect(parsed.success).toBe(false);
    expect(schemaIssueSummary(parsed.error!)).toBe("(root):custom(tool_without_named_calls)");
  });
});

describe("schema failure messages carry no model text", () => {
  it("summarises issues as path and code, eight at most", () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({ path: ["calls", i, "name"], code: "too_big" }));
    expect(schemaIssueSummary({ issues })).toBe(
      `${Array.from({ length: 8 }, (_, i) => `calls.${i}.name:too_big`).join("; ")} (+2 more)`);
  });

  it("reports where a reply stopped being JSON, never the reply itself", () => {
    const reply = "{\"kind\":\"final\",\"text\":\"Your colitis means";
    let message = "";
    try { parseModelJson(reply); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(new RegExp(`^model output is not valid JSON: ${reply.length} chars`));
    expect(message).not.toContain("colitis");
    expect(message).not.toContain("kind");
  });
});

describe("reaskMessage", () => {
  it("names each held-back food with the rule it breaks", () => {
    expect(reaskMessage([{ name: "ice cream", reason: "allergen:dairy" },
      { name: "honey", reason: "category:simple_sugars" }])).toBe(
      "Ice cream has dairy, which your rules exclude. Honey is in a category your rules exclude"
      + ` (simple sugars). ${REASK_TAIL}`);
  });

  it("says which foods it could not check, once each", () => {
    expect(reaskMessage([{ name: "watermelon", reason: null }, { name: "Watermelon", reason: null },
      { name: "salmon", reason: "unchecked_id" }])).toBe(
      `I couldn’t check watermelon and salmon against your food rules yet, so I left them out. ${REASK_TAIL}`);
  });

  it("falls back to the plain lines when there is no food to name", () => {
    expect(reaskMessage([{ name: "reply", reason: "reply_check_incomplete" }])).toBe(REASK_INCOMPLETE);
    expect(reaskMessage([{ name: "tofu", reason: null }, { name: "reply", reason: "reply_check_incomplete" }]))
      .toBe("I couldn’t check tofu against your food rules yet, so I left it out. I couldn’t finish"
        + ` checking the rest of that answer either. ${REASK_TAIL}`);
    expect(reaskMessage([])).toBe(abortMessage("unverified_text_food"));
  });

  it("is recognised by isReask in every form", () => {
    for (const text of [reaskMessage([{ name: "tofu", reason: "category:legumes" }]), REASK_INCOMPLETE,
      abortMessage("unverified_text_food")]) expect(isReask(text)).toBe(true);
    expect(isReask("Tofu is a great protein.")).toBe(false);
  });

  it("logs a policy code, never a custom rule's own words", () => {
    expect(reaskReasonCode("allergen:dairy")).toBe("allergen:dairy");
    expect(reaskReasonCode("rule:custom_ingredient:my aunt's chutney")).toBe("rule:custom_ingredient");
    expect(reaskReasonCode(null)).toBe("unverified");
    expect(reaskReasonCode("Greek yogurt")).toBe("other");
  });
});

describe("an Eats or Avoid mark is not advice (F001, F010, F022)", () => {
  const yogurt = "3f1b1a2c-0000-4000-8000-0000000000a1";
  const evidence = { "greek yogurt": { foodRefId: yogurt, allergenTags: ["dairy"], category: [],
    onEatsList: false, onAvoidList: false } };
  const mark = (kind: "add_to_eats" | "add_to_avoid" | "remove_from_avoid") => ({
    kind, actionId: "a1", flagged: [], name: "Greek yogurt, plain", foodRefId: yogurt,
    catalogFoodRevisionId: 1, kcalPer100g: 59, proteinPer100g: 10, carbsPer100g: 4, fatPer100g: 0,
    verdict: "blocked", alsoFoodRefIds: ["3f1b1a2c-0000-4000-8000-0000000000a2"],
  }) as unknown as CoachAction;
  const check = (text: string, actions: CoachAction[]) =>
    checkReply({ text, named: [], draft: null, actions, evidence, profile: TEST_PROFILE });

  it("never exempts the marked food by name or id", () => {
    expect(loggedFoodIdentities([mark("add_to_eats")])).toEqual({ names: new Set(), refs: new Set() });
  });

  it.each([
    ["add_to_eats", "Adding Greek yogurt to your Favored list."],
    ["add_to_eats", "Done, I've added Greek yogurt to your Eats."],
    ["add_to_avoid", "Greek yogurt is now on your Avoid list."],
    ["remove_from_avoid", "I took Greek yogurt off your Avoid list."],
  ] as const)("keeps the %s confirmation and its mark: %s", (kind, text) => {
    const action = mark(kind);
    const result = check(text, [action]);
    expect(result.content).toBe(text);
    expect(result.actions).toEqual([action]);
  });

  it("still re-asks when the same reply also recommends the marked food", () => {
    for (const text of ["Added Greek yogurt to your Favored list. Have Greek yogurt with honey for breakfast.",
      "Added Greek yogurt to your Favored list, it's a great snack."]) {
      const result = check(text, [mark("add_to_eats")]);
      expect(result.content).toBe(`Greek yogurt has dairy, which your rules exclude. ${REASK_TAIL}`);
      expect(result.actions).toEqual([]);
    }
  });

  it("does not let a mark's head name clear a longer food", () => {
    const bread = { kind: "add_to_eats", name: "Bread, wheat" };
    expect(withoutListMarkConfirmations("Added garlic bread to your Favored list.", [bread]))
      .toBe("Added garlic bread to your Favored list.");
    expect(withoutListMarkConfirmations("Added bread to your Favored list.", [bread])).toBe("");
  });

  it("never strips a sentence through a model-written name that is a clause", () => {
    for (const name of ["rice, then try shrimp", "rice then try the shrimp tacos", "2 eggs"]) {
      const text = `Added ${name} to your Favored list.`;
      expect(withoutListMarkConfirmations(text, [{ kind: "add_to_eats", name }])).toBe(
        text);
    }
  });

  it("control: the same reply with no mark still re-asks, naming the rule", () => {
    const result = check("Adding Greek yogurt to your Favored list.", []);
    expect(isReask(result.content)).toBe(true);
    expect(result.replaced).toEqual({ by: "text_check", reasons: ["allergen:dairy"], incomplete: false });
  });

  it("drops only the card that mirrors the mark", () => {
    expect(withoutListMarkMirrors([{ name: "Greek yogurt" }, { name: "honey" }],
      [{ kind: "add_to_eats", name: "Greek yogurt, plain" }])).toEqual([{ name: "honey" }]);
  });
});

describe("runTurn — the model's abort and the fallback log", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000099", text: "" };
  const SENTENCE = "plan a full day of meals for tomorrow with rough macros";

  function db() {
    const api = () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain,
        in: () => chain, is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
        insert: () => chain, update: () => chain,
      });
      return chain;
    };
    return withCoachSaveTurn({ from: () => api(), rpc: async () => ({ data: [], error: null }) }) as never;
  }
  const ports = {
    dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }),
    weekTotals: async () => [],
    activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
    latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
    searchFoods: async () => [],
    getConstraints: async () => ({}),
    recentGut: async () => [],
    newDraftId: () => "draft-1",
  };
  const run = (generate: ReturnType<typeof vi.fn>) => runTurn(db(), db(), "u1",
    { ...REQ, text: SENTENCE },
    { generate: generate as never, ports, now: () => 0, newId: () => "id-1",
      classifyIntent: async () => null as never, verifyReply: async () => ({ flagged: false, p: 0 }) });
  const promptOf = (generate: ReturnType<typeof vi.fn>, call: number) =>
    generate.mock.calls[call][0].payload.parts[0].text as string;

  it("sends the model's abort back once, and delivers the answer it gives then", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "abort", reason: "I can't plan a whole day" })
      .mockResolvedValueOnce({ kind: "final", text: "Here is a day: eggs and toast, then a chicken bowl." });
    const result = await run(generate);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(promptOf(generate, 1)).toContain(ABORT_CORRECTION);
    expect(result.messages.at(-1)?.content).toBe("Here is a day: eggs and toast, then a chicken bowl.");
  });

  it("ends on a second abort, and logs the cause with no words from the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reason = "the user wants a full plan for tomorrow";
    const generate = vi.fn().mockResolvedValue({ kind: "abort", reason });
    const result = await run(generate);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.messages.at(-1)?.content).toBe(abortMessage(reason));
    const line = warn.mock.calls.find(([label]) => label === "coach turn fallback");
    expect(line?.[1]).toMatchObject({ cause: "model_abort", abortCorrected: true,
      modelReasonChars: reason.length, toolCalls: 0 });
    const logged = JSON.stringify(line);
    for (const word of ["plan", "tomorrow", "macros"]) expect(logged).not.toContain(word);
  });

  it("does not resend a turn the clock stopped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const generate = vi.fn().mockResolvedValue({ kind: "abort", reason: "wall_clock" });
    const result = await run(generate);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.messages.at(-1)?.content).toBe(abortMessage("wall_clock"));
    expect(warn.mock.calls.find(([label]) => label === "coach turn fallback")?.[1])
      .toMatchObject({ cause: "wall_clock", abortCorrected: false });
  });

  it("names the failing tool and argument paths on a fallback, never a value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "search_foods", args: { query: 42 } }] })
      .mockResolvedValue({ kind: "abort", reason: "stuck" });
    await run(generate);
    const line = warn.mock.calls.find(([label]) => label === "coach turn fallback");
    expect(line?.[1]).toMatchObject({ failedToolCalls: 1,
      failedTools: [{ tool: "search_foods", kind: "invalid_args",
        args: [{ path: "query", code: "invalid_type" }] }] });
    expect(JSON.stringify(line)).not.toContain("42");
  });

  it("logs an unknown tool as (unknown), not the name the model sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "grandma_lasagna_lookup", args: {} }] })
      .mockResolvedValue({ kind: "abort", reason: "stuck" });
    await run(generate);
    const line = warn.mock.calls.find(([label]) => label === "coach turn fallback");
    expect(line?.[1]).toMatchObject({ failedTools: [{ tool: "(unknown)", kind: "unknown_tool" }] });
    expect(JSON.stringify(line)).not.toContain("lasagna");
  });

  it("logs nothing when the model's reply is delivered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Eggs and toast would work." });
    await run(generate);
    expect(warn.mock.calls.some(([label]) => label === "coach turn fallback")).toBe(false);
  });
});
