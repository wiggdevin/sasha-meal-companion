/**
 * The invariants the coach action registry (lib/coach/actions/) relies on, so a new kind that
 * breaks one fails here with its name rather than somewhere downstream.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTION_KINDS, ACTION_SPECS, actionSpecFor } from "@/lib/coach/actions";
import { applyBindingFor } from "@/lib/coach/actions/apply";
import { buildActionSchemas, type SchemaSpec } from "@/lib/coach/actions/schemas";
import { MECHANICAL_INTENTS } from "@/lib/coach/intent";
import { intentQuestions } from "@/lib/coach/intent-questions";

describe("the coach action registry", () => {
  it("registers each kind once, in the provider's kind order", () => {
    expect(new Set(ACTION_KINDS).size).toBe(ACTION_SPECS.length);
    for (const kind of ACTION_KINDS) expect(actionSpecFor(kind)?.kind).toBe(kind);
    expect(actionSpecFor("log_mood")).toBeUndefined();
  });

  it("binds a write and an Undo for every registered kind, and none for an unknown one", () => {
    for (const kind of ACTION_KINDS) {
      expect(typeof applyBindingFor(kind)?.apply, kind).toBe("function");
      expect(typeof applyBindingFor(kind)?.undo, kind).toBe("function");
    }
    expect(applyBindingFor("log_mood")).toBeUndefined();
    expect(applyBindingFor("toString")).toBeUndefined();
  });

  it("gives every prompt block and example its own place", () => {
    const ranks = (parts: (number | undefined)[]) => parts.filter((rank) => rank !== undefined);
    const prompt = ranks(ACTION_SPECS.map((spec) => spec.prompt?.rank));
    const example = ranks(ACTION_SPECS.map((spec) => spec.example?.rank));
    expect(new Set(prompt).size).toBe(prompt.length);
    expect(new Set(example).size).toBe(example.length);
  });

  it("only gives a fast path to kinds the Jev intent pre-pass can name", () => {
    const labels = Object.keys(intentQuestions([]).intent.criteria);
    for (const spec of ACTION_SPECS) {
      if (spec.fastPath || spec.intent) expect(labels, spec.kind).toContain(spec.kind);
      if (spec.fastPath) expect(MECHANICAL_INTENTS).toContain(spec.kind);
    }
  });

  it("refuses two kinds that give one positional field different wire forms", () => {
    const spec = (kind: string, field: z.ZodType): SchemaSpec => ({
      kind, input: z.object({ kind: z.literal(kind) }),
      wire: { named: [], strings: ["note"], fields: { note: field } },
      replay: z.object({ kind: z.literal(kind) }),
    });
    expect(() => buildActionSchemas([spec("a", z.string()), spec("b", z.string().max(9))]))
      .toThrow(/"note" has two different wire forms/);
    expect(() => buildActionSchemas([spec("a", z.string()), spec("b", z.string())])).not.toThrow();
  });
});
