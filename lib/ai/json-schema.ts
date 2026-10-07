/**
 * Zod → the JSON-Schema subset Gemini's structured output accepts (architecture §4.2: "no oneOf,
 * no $ref, no unbounded additionalProperties"). One conversion for the whole app: lib/ai/adapter.ts
 * calls it for every purpose, and tests/capture/schemas.test.ts runs it over every capture schema
 * at build time, so an unsupported construct fails in CI rather than at the provider.
 *
 * Nullability is the one thing we rewrite rather than refuse. Zod 4 emits `.nullable()` two ways
 * depending on whether the inner schema already carries other keywords: a bare `z.number().nullable()`
 * becomes `type: ["number", "null"]`, while a constrained `z.number().min(0).max(1).nullable()`
 * becomes `anyOf: [{...}, {type:"null"}]`. Gemini's own dialect spells both the same way,
 * `nullable: true`. Every OTHER anyOf or type array is a real union and is refused, because a union
 * would let the model choose a shape and there is no shape we would accept a choice between.
 *
 * Pure. No I/O.
 */

import { z } from "zod";

/**
 * `const`, `exclusiveMinimum` and `exclusiveMaximum` are refused because the live API rejects
 * them with a 400 ("Unknown name ..."), measured 2026-09-12 — a Zod `.literal()` or
 * `.positive()` would otherwise sail through this converter and fail at the provider, which is
 * exactly the class of failure the build-time assertion exists to prevent.
 *
 * Inclusive numeric bounds are valid Gemini keywords, but they consume the model's opaque schema
 * complexity budget. The full coach action set plus these bounds returns generic INVALID_ARGUMENT;
 * the same 29-property schema without them returns 200 (scripts/debug/gemini-schema-probe.ts,
 * 2026-09-19). The application Zod schema validates every bound after generation, so omitting
 * them from constrained decoding loses no trust-boundary check.
 */
const REFUSED = ["oneOf", "allOf", "not", "$ref", "$defs", "definitions", "patternProperties",
  "exclusiveMinimum", "exclusiveMaximum", "const"];

type Node = Record<string, unknown>;

function isNullBranch(node: unknown): boolean {
  return typeof node === "object" && node !== null
    && (node as Node).type === "null" && Object.keys(node as Node).length === 1;
}

/**
 * `anyOf: [X, {type:"null"}]` → `{...X, nullable: true}`, or `type: [T, "null"]` → `{type: T,
 * nullable: true}`. Returns null when the node is neither shape, so the caller falls back to the
 * node unchanged and the REFUSED/anyOf/type checks below can still catch a real union.
 */
function nullableOf(node: Node): Node | null {
  const branches = node.anyOf;
  if (Array.isArray(branches) && branches.length === 2) {
    const nullAt = branches.findIndex(isNullBranch);
    const other = nullAt < 0 ? null : branches[1 - nullAt];
    if (other && typeof other === "object") {
      const rest = { ...node };
      delete rest.anyOf;
      return { ...(other as Node), ...rest, nullable: true };
    }
  }
  const types = node.type;
  if (Array.isArray(types) && types.length === 2 && types.includes("null")) {
    const other = types.find((t) => t !== "null");
    if (typeof other === "string") return { ...node, type: other, nullable: true };
  }
  return null;
}

function walk(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}[${i}]`));
  if (typeof node !== "object" || node === null) return node;
  const collapsed = nullableOf(node as Node) ?? (node as Node);
  for (const key of REFUSED) {
    if (key in collapsed) {
      throw new Error(`unsupported JSON Schema keyword '${key}' at ${path}`);
    }
  }
  if ("anyOf" in collapsed) {
    throw new Error(`unsupported JSON Schema keyword 'anyOf' at ${path}`);
  }
  if (Array.isArray(collapsed.type)) {
    throw new Error(`unsupported JSON Schema keyword 'type' at ${path}`);
  }
  // additionalProperties: false is what a strict object emits and is fine; `true` or a schema is an
  // open map, which Gemini cannot express and which would let the model invent keys.
  if ("additionalProperties" in collapsed && collapsed.additionalProperties !== false) {
    throw new Error(`unsupported JSON Schema keyword 'additionalProperties' at ${path}`);
  }
  const out: Node = {};
  for (const [key, value] of Object.entries(collapsed)) {
    if (key === "additionalProperties" || key === "minimum" || key === "maximum") continue;
    out[key] = key === "properties"
      ? Object.fromEntries(Object.entries(value as Node)
          .map(([name, child]) => [name, walk(child, `${path}.properties.${name}`)]))
      : walk(value, `${path}.${key}`);
  }
  return out;
}

/**
 * A schema that maps its flat wire form onto a stricter type is a ZodPipe (`.transform()`), and
 * `z.toJSONSchema` refuses it outright ("Transforms cannot be represented in JSON Schema"). That
 * refusal is correct for the *type*, but the wire form is all the provider needs: the transform
 * only rewrites the already-parsed reply inside this process. So lowering unwraps to the pipe's
 * input schema and converts that. The provider never sees a constraint the wire form lacks — the
 * transform's own validation runs when the adapter parses the reply, which is where it belongs.
 */
function lowerRoot(schema: z.ZodType): z.ZodType {
  const piped = schema as unknown as { in?: unknown };
  return piped.in instanceof z.ZodType ? piped.in : schema;
}

/**
 * The un-walked JSON Schema a transform's wire form lowers to: `z.toJSONSchema` plus the
 * `$schema` strip, nothing else. lib/ai/openrouter.ts (owner request 2026-10-02) reuses this half
 * of the Gemini path rather than Gemini's own `nullable: true` rewrite and keyword refusals: an
 * arbitrary OpenRouter model's schema support is not this app's to assert, so a standard-shaped
 * `type: [T, "null"]` is left as the provider sent it instead of being collapsed to Gemini's
 * dialect.
 */
export function toPlainJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(lowerRoot(schema), { reused: "inline" }) as Node;
  delete json.$schema;
  return json as Record<string, unknown>;
}

export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  return walk(toPlainJsonSchema(schema), "$") as Record<string, unknown>;
}

export function assertSupported(schema: z.ZodType): void {
  toGeminiSchema(schema);
}
