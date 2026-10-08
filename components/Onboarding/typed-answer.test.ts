import { describe, expect, it } from "vitest";
import { readTypedAnswer } from "@/components/Onboarding/typed-answer";

const NOW = new Date("2026-10-07T00:00:00.000Z");

describe("readTypedAnswer (local only, no model call)", () => {
  it("reads a bare answer in the asked question's own US unit, confirmed", () => {
    expect(readTypedAnswer("34", "birthYear", NOW)).toEqual({ status: "ok", facts: { birthYear: 1992, confidence: { birthYear: 1 } } });
    expect(readTypedAnswer("5 10", "heightCm", NOW)).toEqual({ status: "ok", facts: { heightCm: 177.8, confidence: { heightCm: 1 } } });
    expect(readTypedAnswer("165", "weightKg", NOW)).toEqual({ status: "ok", facts: { weightKg: 74.8, confidence: { weightKg: 1 } } });
  });

  it("reads a whole opener sentence through the fast path", () => {
    const answer = readTypedAnswer("I want to lose fat, I'm 34, 5'10 and 170 lb", null, NOW);
    expect(answer.status).toBe("ok");
    if (answer.status !== "ok") return;
    expect(answer.facts.goal).toBe("lose_fat");
    expect(answer.facts.heightCm).toBeCloseTo(177.8, 0);
    expect(answer.facts.weightKg).toBeCloseTo(77.1, 0);
  });

  it("never reads a health or allergy statement", () => {
    expect(readTypedAnswer("I have a peanut allergy", null, NOW).status).toBe("blocked");
    expect(readTypedAnswer("I'm diabetic", "birthYear", NOW).status).toBe("blocked");
  });

  it("says so when it reads nothing", () => {
    expect(readTypedAnswer("hello there", null, NOW)).toEqual({ status: "unread" });
  });
});
