import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertSupported, toGeminiSchema } from "@/lib/ai/json-schema";

describe("toGeminiSchema", () => {
  it("drops $schema and keeps properties and required", () => {
    const out = toGeminiSchema(z.object({ a: z.string(), b: z.number() }));
    expect(out.$schema).toBeUndefined();
    expect(out.type).toBe("object");
    expect(Object.keys(out.properties as object)).toEqual(["a", "b"]);
    expect(out.required).toEqual(["a", "b"]);
  });

  it("collapses nullable and omits numeric bounds from the provider schema", () => {
    const out = toGeminiSchema(z.object({ a: z.number().nullable() }));
    expect((out.properties as Record<string, unknown>).a)
      .toEqual({ type: "number", nullable: true });

    const constrained = toGeminiSchema(z.object({ a: z.number().min(0).max(1).nullable() }));
    expect((constrained.properties as Record<string, unknown>).a)
      .toEqual({ type: "number", nullable: true });
  });

  it("throws on a union it cannot express", () => {
    expect(() => toGeminiSchema(z.object({ a: z.union([z.string(), z.object({ b: z.number() })]) })))
      .toThrow("unsupported JSON Schema keyword 'anyOf' at $.properties.a");
  });

  it("throws on a primitive union, which zod emits as a type array", () => {
    expect(() => toGeminiSchema(z.object({ a: z.union([z.string(), z.number()]) })))
      .toThrow("unsupported JSON Schema keyword 'type' at $.properties.a");
  });

  it("throws on an open additionalProperties", () => {
    expect(() => toGeminiSchema(z.looseObject({ a: z.string() })))
      .toThrow("unsupported JSON Schema keyword 'additionalProperties' at $");
  });

  it("assertSupported throws for the same schema toGeminiSchema refuses", () => {
    expect(() => assertSupported(z.object({ a: z.union([z.string(), z.number()]) }))).toThrow();
    expect(() => assertSupported(z.object({ a: z.string() }))).not.toThrow();
  });
});
