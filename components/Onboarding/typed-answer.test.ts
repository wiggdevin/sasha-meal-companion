import { describe, expect, it, vi } from "vitest";
import { readAnswerList, readAskedAnswer, readTypedAnswer } from "@/components/Onboarding/typed-answer";
import type { extractOnboardingFacts } from "@/lib/onboarding/extract-client";

const NOW = new Date("2026-10-07T00:00:00.000Z");

/** The extract client with its model leg unavailable (offline): local fast path only. */
const offline = (async (text: string, opts?: { callsUsed?: number; now?: Date }) => {
  const actual = await vi.importActual<typeof import("@/lib/onboarding/extract-client")>("@/lib/onboarding/extract-client");
  return actual.extractOnboardingFacts(text, { ...opts, online: false });
}) as typeof extractOnboardingFacts;

describe("readTypedAnswer", () => {
  it("reads a bare answer in the asked question's own US unit, confirmed, with no extract call", async () => {
    const extract = vi.fn();
    expect(await readTypedAnswer("34", "birthYear", { now: NOW, extract: extract as never }))
      .toEqual({ status: "ok", facts: { birthYear: 1992, confidence: { birthYear: 1 } }, callsUsed: 0 });
    expect(readAskedAnswer("5 10", "heightCm", NOW)).toEqual({ heightCm: 177.8, confidence: { heightCm: 1 } });
    expect(readAskedAnswer("165", "weightKg", NOW)).toEqual({ weightKg: 74.8, confidence: { weightKg: 1 } });
    expect(extract).not.toHaveBeenCalled();
  });

  it("reads a whole opener sentence through the extract client", async () => {
    const answer = await readTypedAnswer("I want to lose fat, I'm 34, 5'10 and 170 lb", null, { now: NOW, extract: offline });
    expect(answer.status).toBe("ok");
    if (answer.status !== "ok") return;
    expect(answer.facts.goal).toBe("lose_fat");
    expect(answer.facts.heightCm).toBeCloseTo(177.8, 0);
    expect(answer.facts.weightKg).toBeCloseTo(77.1, 0);
  });

  it("reads a list of short answers with the same parsers as the fact editors", async () => {
    const answer = await readTypedAnswer("lose fat, 34, 5 10, 170 lb", null, { now: NOW, extract: offline });
    expect(answer.status).toBe("ok");
    if (answer.status !== "ok") return;
    expect(answer.facts).toMatchObject({ goal: "lose_fat", birthYear: 1992, heightCm: 177.8, weightKg: 77.1 });
    expect(answer.facts.confidence).toMatchObject({ birthYear: 1, heightCm: 1, weightKg: 1 });
    expect(readAnswerList("34, 6'0\", 165", NOW)).toEqual({
      birthYear: 1992, heightCm: 182.9, weightKg: 74.8, confidence: { birthYear: 1, heightCm: 1, weightKg: 1 },
    });
    // A lone single digit in a list is never guessed to be a height.
    expect(readAnswerList("lose fat, 6", NOW)).toBeNull();
  });

  it("reads every spoken height form while height is asked", () => {
    for (const typed of ["6 foot", "6'", "5'10", "5' 10\"", "5ft 10in", "5 foot 10", "5-10", "70 in", "70\""]) {
      expect(readAskedAnswer(typed, "heightCm", NOW)?.heightCm, typed).toBeGreaterThan(170);
    }
    expect(readAskedAnswer("10 foot", "heightCm", NOW)).toBeNull();
    expect(readAskedAnswer("170lbs", "weightKg", NOW)).toEqual({ weightKg: 77.1, confidence: { weightKg: 1 } });
    expect(readAskedAnswer("70", "birthYear", NOW)).toEqual({ birthYear: 1956, confidence: { birthYear: 1 } });
  });

  it("never reads a health or allergy statement, and never calls the extract client for one", async () => {
    const extract = vi.fn();
    expect((await readTypedAnswer("I have a peanut allergy", null, { extract: extract as never })).status).toBe("blocked");
    expect((await readTypedAnswer("I'm diabetic", "birthYear", { extract: extract as never })).status).toBe("blocked");
    expect(extract).not.toHaveBeenCalled();
  });

  it("says so when nothing was read", async () => {
    expect((await readTypedAnswer("hello there", null, { now: NOW, extract: offline })).status).toBe("unread");
  });
});
