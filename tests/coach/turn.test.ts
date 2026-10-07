import { describe, expect, it } from "vitest";
import { assertSupported, toGeminiSchema } from "@/lib/ai/json-schema";
import { abortMessage, LIST_MARK_CAP_NOTICE, LIST_MARK_CAP_NOTICE_MIXED,
  LIST_MARK_CAP_NOTICE_REMOVE, listMarkCapNotice, planTurn, sanitiseReply,
  TURN_LIMITS, turnStepSchema, turnStepWireSchema } from "@/lib/coach/turn";

const state = (over: Partial<Parameters<typeof planTurn>[0]> = {}) => ({
  toolCallsUsed: 0, startedAt: 1_000, now: 1_000, limits: TURN_LIMITS, ...over,
});

describe("TURN_LIMITS", () => {
  // maxToolCalls was raised 2026-09-14 from 6: an ordinary "what should I eat" turn wants 6-7.
  // wallClockMs went 30 s -> 75 s that day, then back to 30 s on 2026-09-23, counted from the
  // start of the turn, because 75 s outlived the phone's 40 s deadline (tests/coach/latency.test.ts).
  // A change here is still a deliberate change.
  it("is 10 tool calls and 30 seconds — a change here is a deliberate change", () => {
    expect(TURN_LIMITS.maxToolCalls).toBe(10);
    expect(TURN_LIMITS.wallClockMs).toBe(30_000);
  });
});

describe("planTurn", () => {
  it("passes a tool step through and counts its calls", () => {
    const step = planTurn(state(), { kind: "tool", calls: [{ name: "get_day", args: {} }] });
    expect(step).toEqual({ kind: "tool", calls: [{ name: "get_day", args: {} }] });
  });

  it("aborts cleanly when one call past the cap would be made", () => {
    const step = planTurn(state({ toolCallsUsed: TURN_LIMITS.maxToolCalls }),
      { kind: "tool", calls: [{ name: "get_day", args: {} }] });
    expect(step).toEqual({ kind: "abort", reason: "max_tool_calls" });
  });

  it("aborts when a batch would cross the cap, without executing part of it", () => {
    const step = planTurn(state({ toolCallsUsed: TURN_LIMITS.maxToolCalls - 1 }), {
      kind: "tool",
      calls: [{ name: "get_day", args: {} }, { name: "get_targets", args: {} }],
    });
    expect(step).toEqual({ kind: "abort", reason: "max_tool_calls" });
  });

  it("aborts on the wall clock before looking at the model output", () => {
    const step = planTurn(state({ now: 1_000 + TURN_LIMITS.wallClockMs }), { kind: "final", text: "hi" });
    expect(step).toEqual({ kind: "abort", reason: "wall_clock" });
  });

  it("aborts on an empty tool step rather than looping", () => {
    expect(planTurn(state(), { kind: "tool", calls: [] }))
      .toEqual({ kind: "abort", reason: "empty_tool_step" });
  });

  it("trims a final step and keeps its suggestions", () => {
    const step = planTurn(state(), {
      kind: "final", text: "  eat rice  ", suggestions: [{ name: "rice", grams: 150 }],
    });
    expect(step).toEqual({ kind: "final", text: "eat rice", suggestions: [{ name: "rice", grams: 150 }] });
  });

  it("keeps actions on a final step", () => {
    const actions = [{
      kind: "move_slot" as const, date: "2026-09-16", slot: "meal-3" as const, time: "19:30",
    }];
    expect(planTurn(state(), { kind: "final", text: "  I moved dinner.  ", actions }))
      .toEqual({ kind: "final", text: "I moved dinner.", actions });
  });

  it("passes a model abort through with its reason", () => {
    expect(planTurn(state(), { kind: "abort", reason: "cannot answer" }))
      .toEqual({ kind: "abort", reason: "cannot answer" });
  });
});

describe("abortMessage", () => {
  it("is readable, not an exception, for each known reason", () => {
    expect(abortMessage("max_tool_calls")).toContain("pin that one down");
    expect(abortMessage("wall_clock")).toContain("took too long");
    expect(abortMessage("anything else")).toMatch(/[a-z]/);
  });
});

/**
 * Evidence 2026-09-20: "let's add all those to my eats list", after a reply listing six items,
 * added only 3 — the final step's `actions` array is capped at 3 on the wire (turnStepProviderSchema,
 * lib/coach/wire.ts), so Gemini cannot emit a 4th no matter how many the user named. Nothing told
 * the user the rest were dropped.
 */
describe("listMarkCapNotice", () => {
  const eats = (name: string) => ({ kind: "add_to_eats", name });
  const avoid = (name: string) => ({ kind: "add_to_avoid", name });

  it("notices a final step filled to the cap with nothing but repeatable list marks", () => {
    expect(listMarkCapNotice([eats("a"), eats("b"), eats("c")])).toBe(LIST_MARK_CAP_NOTICE);
  });

  it("says nothing under the cap — there was room for everything the user named", () => {
    expect(listMarkCapNotice([eats("a"), eats("b")])).toBeNull();
    expect(listMarkCapNotice([])).toBeNull();
    expect(listMarkCapNotice(undefined)).toBeNull();
  });

  it("says nothing for three actions mixing a list mark with something else", () => {
    expect(listMarkCapNotice([eats("a"), eats("b"), { kind: "log_meal" }])).toBeNull();
  });

  it("covers every repeatable list-mark kind, not only add_to_eats", () => {
    expect(listMarkCapNotice([avoid("a"), avoid("b"), avoid("c")])).toBe(LIST_MARK_CAP_NOTICE);
  });

  /**
   * 2026-10-02 Grok audit: the one notice always said "say 'add the rest'", nonsensical after
   * three REMOVALS (remove_from_eats / remove_from_avoid) — the user is taking things off a list,
   * not adding to one. A mix of adds and removes gets a neutral wording that commits to neither
   * verb, so it is never wrong either way.
   */
  it("says \"remove the rest\", never \"add the rest\", after three removals", () => {
    const removeEats = (name: string) => ({ kind: "remove_from_eats", name });
    const removeAvoid = (name: string) => ({ kind: "remove_from_avoid", name });
    expect(listMarkCapNotice([removeEats("a"), removeEats("b"), removeAvoid("c")]))
      .toBe(LIST_MARK_CAP_NOTICE_REMOVE);
    expect(LIST_MARK_CAP_NOTICE_REMOVE).toContain("remove the rest");
    expect(LIST_MARK_CAP_NOTICE_REMOVE).not.toMatch(/\badd the rest\b/);
  });

  it("uses the neutral wording for a mix of adds and removes, naming neither verb", () => {
    const removeEats = (name: string) => ({ kind: "remove_from_eats", name });
    expect(listMarkCapNotice([eats("a"), removeEats("b"), eats("c")]))
      .toBe(LIST_MARK_CAP_NOTICE_MIXED);
    expect(LIST_MARK_CAP_NOTICE_MIXED).not.toMatch(/\badd the rest\b|\bremove the rest\b/);
  });

  /**
   * 2026-10-02 DeepSeek audit: the notice fires on exactly 3 list-mark actions whether or not
   * anything was actually dropped — "add eggs, rice and chicken" fills the cap with nothing left
   * over, but the old wording ("...so I added the first 3. Say 'add the rest'...") told the user
   * items were dropped regardless. The notice must never assert a drop that may not have happened.
   */
  it("never asserts that anything was dropped, since 3 list marks may have been everything asked for", () => {
    expect(LIST_MARK_CAP_NOTICE).not.toMatch(/added the first/i);
    expect(LIST_MARK_CAP_NOTICE).not.toMatch(/\bdropped\b/i);
  });
});

describe("sanitiseReply", () => {
  it("keeps the corrected final sentence after leaked formatting self-talk", () => {
    expect(sanitiseReply(
      "Logged 170g steak and 150g eggs for meal-1.─────────────── wait no special formatting extra chars: Logged 170g steak and 150g eggs for meal 1.",
    )).toBe("Logged 170g steak and 150g eggs for meal 1.");
  });

  it.each([
    "How much steak and how many eggs?",
    'I could not find "x" — what should I log it as?',
    "Rice is fine. No format change is needed.",
    "rice — 150 g",
  ])("keeps ordinary food prose intact: %s", (reply) => {
    expect(sanitiseReply(reply)).toBe(reply);
  });

  // Production (2026-09-24): the reply read "Would you like me to build options using
  // compose_meal for each slot" — an internal tool name, meaningless to the user, leaked
  // straight from the registry into the sentence they read.
  it("drops an internal tool name the model names in its own reply", () => {
    expect(sanitiseReply("Would you like me to build options using compose_meal for each slot?"))
      .toBe("Would you like me to build options for each slot?");
  });

  it.each(["search_foods", "draft_log_entry", "suggest_options", "get_day"])(
    "never lets the registry tool name %s reach the user", (name) => {
      expect(sanitiseReply(`I will call ${name} to check that.`)).not.toContain(name);
    },
  );

  // 2026-10-02 DeepSeek audit: "lookup" is also a registry tool name, but unlike the compound
  // names above it is an ordinary English word. Bare, it means lookup, not the tool — only its
  // connector form ("using lookup") is unambiguously the internal name.
  it("keeps the ordinary word \"lookup\" bare, cutting it only in its connector form", () => {
    expect(sanitiseReply("Let me do a quick lookup on that."))
      .toBe("Let me do a quick lookup on that.");
    expect(sanitiseReply("I will do that using lookup.")).not.toContain("lookup");
  });
});

describe("turnStepSchema", () => {
  it("accepts the three kinds and rejects a fourth", () => {
    expect(turnStepSchema.safeParse({ kind: "final", text: "x" }).success).toBe(true);
    expect(turnStepSchema.safeParse({ kind: "tool", calls: [{ name: "get_day", args: {} }] }).success)
      .toBe(true);
    expect(turnStepSchema.safeParse({ kind: "abort", reason: "x" }).success).toBe(true);
    expect(turnStepSchema.safeParse({ kind: "write", text: "x" }).success).toBe(false);
  });
});

/**
 * T4: the union is the validation, the flat schema is what leaves the process. A real coach turn
 * used to hand `turnStepSchema` to the adapter, `toGeminiSchema` threw on its `oneOf`, and every
 * Sasha turn answered 503 coach_unavailable without a provider call.
 */
describe("the wire form of a turn step", () => {
  it("lowers to one object Gemini's responseSchema can carry", () => {
    expect(() => assertSupported(turnStepWireSchema)).not.toThrow();
    const json = toGeminiSchema(turnStepWireSchema);
    expect(json).toMatchObject({ type: "object" });
    expect(JSON.stringify(json)).not.toMatch(/oneOf|anyOf|\$ref/);
    // Keywords the live API answered with a 400 in the same session (2026-09-12): a Zod
    // `.positive()` in this schema would have shipped a responseSchema the provider refuses.
    expect(JSON.stringify(json)).not.toMatch(/exclusiveMinimum|exclusiveMaximum|"const"/);
  });

  it("keeps the discriminated union unlowerable — the reason the wire form exists", () => {
    expect(() => assertSupported(turnStepSchema)).toThrow(/oneOf/);
  });

  it("parses each flat variant straight to its union member", () => {
    expect(turnStepWireSchema.safeParse({
      kind: "tool", calls: [{ name: "get_day", args: { date: "2026-09-11" } }],
    })).toEqual({
      success: true,
      data: { kind: "tool", calls: [{ name: "get_day", args: { date: "2026-09-11" } }] },
    });
    expect(turnStepWireSchema.safeParse({
      kind: "final", text: "eat rice", suggestions: [{ name: "rice", grams: 150, foodRefId: null }],
    })).toEqual({
      success: true,
      data: {
        kind: "final", text: "eat rice",
        suggestions: [{ name: "rice", grams: 150, foodRefId: null }],
      },
    });
    expect(turnStepWireSchema.safeParse({ kind: "abort", reason: "cannot answer" }))
      .toEqual({ success: true, data: { kind: "abort", reason: "cannot answer" } });
    const finalWithActions = {
      kind: "final" as const, text: "I logged breakfast.", actions: [{
        kind: "log_meal" as const, date: "2026-09-16", slot: "meal-1" as const,
        items: [{ name: "steak", grams: 170 }],
      }],
    };
    expect(turnStepWireSchema.safeParse(finalWithActions))
      .toEqual({ success: true, data: finalWithActions });
  });

  it("fails its own parse on a flat reply the union would not accept", () => {
    // The point of the transform: the adapter's schema parse — not a caller's second step —
    // is what refuses these, so they land as ai_calls.status = "schema_invalid".
    expect(turnStepWireSchema.safeParse({ kind: "final" }).success).toBe(false);     // no text
    expect(turnStepWireSchema.safeParse({ kind: "abort" }).success).toBe(false);     // no reason
    expect(turnStepWireSchema.safeParse({ kind: "write", text: "x" }).success).toBe(false);
    expect(turnStepWireSchema.safeParse({ kind: "final", text: "x",
      suggestions: [{ name: "rice", foodRefId: "not-a-uuid" }] }).success).toBe(false);
    const invalidAction = turnStepWireSchema.safeParse({
      kind: "final", text: "logged", actions: [{
        kind: "log_meal", date: "2026-09-16", slot: "meal-1",
        items: [{ name: "steak" }],
      }],
    });
    expect(invalidAction.success).toBe(false);
    if (!invalidAction.success) expect(invalidAction.error.issues).toHaveLength(1);
    expect(turnStepWireSchema.safeParse({
      kind: "final", text: "logged", actions: [{
        kind: "set_slot_item", date: "2026-09-16", slot: "meal-1",
        name: "steak", grams: 0,
      }],
    }).success).toBe(false);
  });

  it("still lowers to the flat object when the transform is on top", () => {
    // The transform is invisible to the provider: toGeminiSchema unwraps the pipe and lowers the
    // same single object, with none of the JSON Schema keywords the live API 400s on.
    expect(() => assertSupported(turnStepWireSchema)).not.toThrow();
    expect(toGeminiSchema(turnStepWireSchema)).toMatchObject({
      type: "object", required: ["kind"],
      properties: { kind: { type: "string", enum: ["tool", "final", "abort"] } },
    });
  });
});
