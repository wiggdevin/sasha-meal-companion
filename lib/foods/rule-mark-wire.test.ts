import { describe, expect, it } from "vitest";
import { ruleMarkFromWire } from "@/lib/foods/rule-mark-wire";

describe("ruleMarkFromWire", () => {
  it("keeps the two verdicts with a reason, as sent", () => {
    expect(ruleMarkFromWire({ verdict: "blocked", reason: "Peanut sauce has peanut, which your rules exclude." }))
      .toEqual({ verdict: "blocked", reason: "Peanut sauce has peanut, which your rules exclude." });
    expect(ruleMarkFromWire({ verdict: "unknown", reason: "Checking against your updated food rules.", extra: 1 }))
      .toEqual({ verdict: "unknown", reason: "Checking against your updated food rules." });
  });

  it("reads null, absent and malformed marks as no mark", () => {
    for (const value of [null, undefined, "blocked", {}, { verdict: "allowed", reason: "x" },
      { verdict: "blocked" }, { verdict: "unknown", reason: "  " }, { verdict: "blocked", reason: 3 }]) {
      expect(ruleMarkFromWire(value)).toBeNull();
    }
  });
});
