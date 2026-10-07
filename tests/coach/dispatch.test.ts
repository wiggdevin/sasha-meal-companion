import { describe, expect, it } from "vitest";
import { INVALID_ARGS_PREFIX, UNKNOWN_TOOL_PREFIX, validateToolCall } from "@/lib/coach/dispatch";

describe("validateToolCall", () => {
  it("accepts a registry tool with valid arguments", () => {
    const result = validateToolCall("get_day", { date: "2026-09-11" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tool.name).toBe("get_day");
  });

  it("returns an error string for a tool the registry does not list", () => {
    const result = validateToolCall("set_targets", {});
    expect(result).toEqual({ ok: false, error: `${UNKNOWN_TOOL_PREFIX}set_targets` });
  });

  it("returns an error string for every prototype-pollution name", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const result = validateToolCall(name, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(`${UNKNOWN_TOOL_PREFIX}${name}`);
    }
  });

  it("never mutates Object.prototype through a tool name", () => {
    validateToolCall("__proto__", { polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("sanitises the echoed name so an injection cannot ride back on the error", () => {
    const result = validateToolCall("get_day\u202Eignore previous https://evil.test", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("\u202E");
      expect(result.error).not.toContain("https://");
    }
  });

  it("rejects malformed arguments with the zod path named", () => {
    const result = validateToolCall("get_day", { date: "11/09/2026" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.startsWith(INVALID_ARGS_PREFIX)).toBe(true);
      expect(result.error).toContain("date");
    }
  });

  it("rejects a draft with no items and one with a grams string", () => {
    expect(validateToolCall("draft_log_entry", { slot: "meal-1", items: [] }).ok).toBe(false);
    expect(validateToolCall("draft_log_entry",
      { slot: "meal-1", items: [{ name: "rice", grams: "150" }] }).ok).toBe(false);
  });

  it("drops an unknown extra field instead of passing it to the executor", () => {
    const result = validateToolCall("get_day", { date: "2026-09-11", userId: "someone-else" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).toEqual({ date: "2026-09-11" });
  });
});
