import { withSpendRpc } from "@/tests/ai/spend-admin";
import { describe, expect, it, vi } from "vitest";
import { coachTurnPayload } from "@/lib/ai/gemini-payloads";
import { z } from "zod";
import { generateStructured, isCapacityFailure, ProviderHttpError } from "@/lib/ai/adapter";
import { assertSupported, toGeminiSchema, toPlainJsonSchema } from "@/lib/ai/json-schema";
import { coachActionWireSchema, providerActionSchema } from "@/lib/coach/actions";
import { turnStepProviderSchema, turnStepWireSchemaFor } from "@/lib/coach/turn";

const EMPTY = { calls: [], actions: [], suggestions: [], text: "", memory: [], reason: "" };

function assertValidLoweredSchema(node: unknown, path = "$"): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => assertValidLoweredSchema(child, `${path}[${index}]`));
    return;
  }
  if (typeof node !== "object" || node === null) return;

  const record = node as Record<string, unknown>;
  expect(record, `${path} must not spend Gemini's schema budget on numeric bounds`)
    .not.toHaveProperty("minimum");
  expect(record, `${path} must not spend Gemini's schema budget on numeric bounds`)
    .not.toHaveProperty("maximum");
  if (Array.isArray(record.enum)) {
    record.enum.forEach((value, index) => {
      expect(typeof value, `${path}.enum[${index}] must be a string`).toBe("string");
      expect(value, `${path}.enum[${index}] must not be empty`).not.toBe("");
    });
  }
  if (Array.isArray(record.required)) {
    const properties = record.properties;
    expect(properties, `${path}.properties must exist when required does`).toBeTypeOf("object");
    for (const name of record.required) {
      expect(typeof name, `${path}.required entries must be strings`).toBe("string");
      expect(Object.hasOwn(properties as object, String(name)),
        `${path}.required contains missing property ${String(name)}`).toBe(true);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    assertValidLoweredSchema(value, `${path}.${key}`);
  }
}

function propertyCount(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + propertyCount(child), 0);
  if (typeof node !== "object" || node === null) return 0;
  const record = node as Record<string, unknown>;
  const here = typeof record.properties === "object" && record.properties !== null
    ? Object.keys(record.properties).length : 0;
  return here + Object.values(record).reduce<number>(
    (sum, child) => sum + propertyCount(child), 0);
}

function admin(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, neq: () => chain, gte: () => chain, is: () => chain,
    order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (r: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(r),
    insert: (row: unknown) => { rows.push(row); return chain; },
  });
  return withSpendRpc({ from: () => chain, rpc: async () => ({ data: null, error: null }) }) as never;
}

describe("the schema the provider is sent", () => {
  it("requires every key, which is what makes constrained decoding emit them", () => {
    const lowered = toGeminiSchema(turnStepProviderSchema) as Record<string, unknown>;
    expect(lowered.required).toEqual(
      ["kind", "calls", "actions", "suggestions", "text", "memory", "reason"]);
  });

  it("requires every key of an action too — an omitted `items` is how set_slot_meal was lost", () => {
    const lowered = toGeminiSchema(providerActionSchema) as Record<string, unknown>;
    expect(lowered.required).toEqual(["kind", "date", "from", "through", "weekdays", "title",
      "slot", "items", "item", "name", "grams", "entryId", "numericArgs", "stringArgs"]);
    expect(lowered.required).not.toContain("dates");
  });

  it("still lowers to something Gemini accepts", () => {
    expect(() => assertSupported(turnStepProviderSchema)).not.toThrow();
    expect(JSON.stringify(toGeminiSchema(turnStepProviderSchema)))
      .not.toMatch(/oneOf|anyOf|\$ref/);
  });

  it("contains only non-empty string enums and resolves every required property", () => {
    assertValidLoweredSchema(toGeminiSchema(turnStepProviderSchema));
  });

  it("does not exceed the last passing 30-property live bisection point", () => {
    // The live provider rejected 31 properties during the prior bisection. This exact lock proves
    // named note/time/at fields cannot be restored without removing another live action field.
    expect(propertyCount(toGeminiSchema(turnStepProviderSchema))).toBe(30);
  });

  it("is NOT what parses the reply: a partial reply is still read", () => {
    expect(turnStepWireSchemaFor("2026-09-18").safeParse({ kind: "final", text: "ok" }).success)
      .toBe(true);
  });
});

describe("empty means absent", () => {
  const parse = (over: Record<string, unknown>) =>
    turnStepWireSchemaFor("2026-09-18").safeParse({ ...EMPTY, ...over });

  it("reads a final that fills every required key, including a `reason` it did not need", () => {
    const parsed = parse({ kind: "final", text: "Watermelon is on your avoid list now.",
      actions: [{ kind: "add_to_avoid", name: "watermelon" }],
      suggestions: [{ name: "watermelon", foodRefId: null, grams: null }],
      memory: ["disliked_food|watermelon"], reason: "because she asked" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind === "final" && parsed.data.actions)
      .toEqual([{ kind: "add_to_avoid", name: "watermelon" }]);
  });

  it("drops a blank-named placeholder the model put in an array it had nothing for", () => {
    const parsed = parse({ kind: "final", text: "Here you go.",
      suggestions: [{ name: "", foodRefId: null, grams: null }] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind === "final" && parsed.data.suggestions)
      .toBeUndefined();
  });

  it("reads an abort whose reason is real and a final whose reason is empty", () => {
    expect(parse({ kind: "abort", reason: "cannot answer" }).success).toBe(true);
    expect(parse({ kind: "abort", reason: "" }).success).toBe(false);
  });

  it("strips an action's empty and zero fields before the strict shape sees them", () => {
    const parsed = coachActionWireSchema.safeParse({
      kind: "add_to_avoid", name: "watermelon", date: "", slot: "meal-2",
      items: [{ name: "", grams: 0 }], item: { name: "", grams: 0 },
      grams: 0, note: "", time: "", at: "", entryId: "",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ kind: "add_to_avoid", name: "watermelon" });
  });

  it.each([
    ["scope", { kind: "shift_schedule", date: "2026-09-18", minutes: 30,
      scope: "remaining" }],
    ["sex", { kind: "update_profile", sex: "female" }],
    ["activityLevel", { kind: "update_profile", activityLevel: "moderate" }],
    ["goal", { kind: "update_profile", goal: "recomp" }],
    ["dayType", { kind: "set_targets", dayType: "training", kcal: 2300 }],
  ] as const)("round-trips %s and treats its empty string as absent", (field, action) => {
    const present = coachActionWireSchema.safeParse(action);
    expect(present.success).toBe(true);
    expect(present.success && present.data).toEqual(action);

    expect(coachActionWireSchema.safeParse({ ...action, [field]: "unsupported" }).success)
      .toBe(false);

    const absent = coachActionWireSchema.safeParse({
      kind: "add_to_avoid", name: "watermelon", [field]: "",
    });
    expect(absent.success).toBe(true);
    expect(absent.success && absent.data).toEqual({ kind: "add_to_avoid", name: "watermelon" });
  });

  it.each([
    [
      { kind: "shift_schedule", date: "2026-09-18", numericArgs: [30],
        stringArgs: ["remaining"] },
      { kind: "shift_schedule", date: "2026-09-18", minutes: 30, scope: "remaining" },
    ],
    [{ kind: "log_water", numericArgs: [480], stringArgs: [] },
      { kind: "log_water", ml: 480 }],
    [{ kind: "log_weight", numericArgs: [58.1], stringArgs: [] },
      { kind: "log_weight", kg: 58.1 }],
    [
      { kind: "update_profile", numericArgs: [165, 0, 1992, 0, 0, 3, 4, 5],
        stringArgs: ["female", "", "recomp"] },
      { kind: "update_profile", heightCm: 165, birthYear: 1992, sex: "female", goal: "recomp",
        trainingWeekdays: [0, 3, 4, 5] },
    ],
    [{ kind: "set_targets", numericArgs: [2300, 125], stringArgs: ["training"] },
      { kind: "set_targets", dayType: "training", kcal: 2300, proteinG: 125 }],
  ] as const)("expands compact provider args %# into the strict named action", (wire, action) => {
    const parsed = coachActionWireSchema.safeParse(wire);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(action);
  });

  it("keeps a log note without mistaking it for a clock time", () => {
    const parsed = coachActionWireSchema.safeParse({
      kind: "log_meal", date: "2026-09-18", slot: "snack",
      title: "Soup", items: [{ name: "soup", grams: 300 }],
      stringArgs: ["", "Felt comfortable"],
    });
    expect(parsed.success && parsed.data).toMatchObject({ note: "Felt comfortable" });
    expect(parsed.success && parsed.data).not.toHaveProperty("at");
  });

  it("keeps a log note longer than the old 64-character compact limit", () => {
    const note = "Comfortable after eating; no cramping, urgency, bloating, or unusual symptoms today.";
    const parsed = coachActionWireSchema.safeParse({
      kind: "log_meal", date: "2026-09-18", slot: "snack",
      title: "Soup", items: [{ name: "soup", grams: 300 }], stringArgs: ["", note],
    });
    expect(note.length).toBeGreaterThan(64);
    expect(parsed.success && parsed.data).toMatchObject({ note });
  });

  it("keeps a log clock time without inventing a note", () => {
    const parsed = coachActionWireSchema.safeParse({
      kind: "log_meal", date: "2026-09-18", slot: "snack",
      title: "Soup", items: [{ name: "soup", grams: 300 }], stringArgs: ["15:30", ""],
    });
    expect(parsed.success && parsed.data).toMatchObject({ at: "15:30" });
    expect(parsed.success && parsed.data).not.toHaveProperty("note");
  });
});

describe("a model with no capacity", () => {
  it.each([
    [new ProviderHttpError(503, "gemini 503: overloaded"), true],
    [new ProviderHttpError(429, "gemini 429: quota"), true],
    [new ProviderHttpError(400, "gemini 400: bad schema"), false],
    [new Error("model output failed the schema"), false],
    [new Error("UNAVAILABLE: the model is overloaded"), true],
  ])("classifies %#", (error, expected) => {
    expect(isCapacityFailure(error)).toBe(expected);
  });

  it("is abandoned after ONE attempt when the caller has somewhere else to go", async () => {
    const rows: unknown[] = [];
    const callGemini = vi.fn(async () => {
      throw new ProviderHttpError(503, "gemini 503: model overloaded");
    });
    await expect(generateStructured({
      payload: coachTurnPayload(["hi"]), userId: "u1", admin: admin(rows),
      schema: z.object({ ok: z.boolean() }), abandonOnCapacity: true,
    } as never, { callGemini: callGemini as never, sleep: async () => {} })).rejects.toThrow();
    expect(callGemini).toHaveBeenCalledTimes(1);
  });

  it("still burns its whole retry budget for a caller that has nowhere else", async () => {
    const rows: unknown[] = [];
    const callGemini = vi.fn(async () => {
      throw new ProviderHttpError(503, "gemini 503: model overloaded");
    });
    await expect(generateStructured({
      payload: coachTurnPayload(["hi"]), userId: "u1", admin: admin(rows),
      schema: z.object({ ok: z.boolean() }),
    } as never, { callGemini: callGemini as never, sleep: async () => {} })).rejects.toThrow();
    expect(callGemini).toHaveBeenCalledTimes(3);
  });
});

// Live smoke, 2026-10-02: an OpenRouter model answered an abort whose reason ran past 200
// characters, and the whole turn failed the schema ("Sasha is unavailable right now"). A long
// reason is trimmed to its limit, never a reason to fail the reply.
describe("over-long free-text fields", () => {
  it("trims a long abort reason instead of rejecting the step", async () => {
    const { turnStepWireSchema, EMPTY_WIRE_STEP } = await import("@/lib/coach/wire");
    const abort = turnStepWireSchema.parse({ ...EMPTY_WIRE_STEP, kind: "abort", reason: "x".repeat(320) });
    expect(abort).toEqual({ kind: "abort", reason: "x".repeat(200) });
  });
});

/** Live 2026-10-02: `maxItems: 20` on one array made Google reject the whole coach schema
 *  (OpenRouter 400 INVALID_ARGUMENT); 8 was accepted, and main's largest bound (11) is live. */
describe("array bounds the provider accepts", () => {
  it("bounds every array in the coach provider schema at 11 items or fewer", () => {
    const bounds: number[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.maxItems === "number") bounds.push(record.maxItems);
      for (const value of Object.values(record)) walk(value);
    };
    walk(toPlainJsonSchema(turnStepProviderSchema));
    expect(bounds.length).toBeGreaterThan(0);
    expect(Math.max(...bounds)).toBeLessThanOrEqual(11);
  });
});
