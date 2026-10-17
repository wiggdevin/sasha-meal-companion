import { describe, expect, it } from "vitest";
import { buildToolSpec } from "@/lib/coach/prompt";
import { COACH_REGISTRY } from "@/lib/coach/registry";

const ALLOWED = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "description",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
  "minItems", "maxItems", "format", "pattern", "anyOf", "oneOf", "default",
]);

function keywords(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => keywords(n, out));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && value && typeof value === "object") {
        Object.values(value).forEach((v) => keywords(v, out));
      } else {
        out.add(key);
        keywords(value, out);
      }
    }
  }
  return out;
}

describe("coach tool input schemas", () => {
  it("use only keywords on the allowlist (covers .positive(), which emits exclusiveMinimum)", () => {
    for (const spec of buildToolSpec(COACH_REGISTRY)) {
      for (const key of keywords(spec.inputSchema)) {
        expect(ALLOWED.has(key), `${spec.name}: ${key}`).toBe(true);
      }
    }
  });
});
