import { describe, expect, it } from "vitest";
import { parseCustomRules } from "./custom-rules";

describe("stored custom food rules", () => {
  it("accepts only complete literal rule items", () => {
    const rule = { id: crypto.randomUUID(), kind: "ingredient", text: "garlic" };
    expect(parseCustomRules([rule])).toEqual([rule]);
    for (const malformed of [null, {}, { ...rule, text: null },
      { ...rule, kind: "claim" }, { ...rule, id: "bad" }, { ...rule, extra: true }]) {
      expect(() => parseCustomRules([malformed])).toThrow("Invalid stored");
    }
  });
});
