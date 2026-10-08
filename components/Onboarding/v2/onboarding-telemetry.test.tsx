// @vitest-environment jsdom
import { renderHook, act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ events: [] as Record<string, unknown>[], flushes: 0 }));
vi.mock("@/lib/profile/onboarding-events-client", () => ({
  queueOnboardingEvent: (event: Record<string, unknown>) => { sent.events.push(event); },
  flushOnboardingEvents: async () => { sent.flushes += 1; },
}));

import { questionFor, stepForBeat, useOnboardingTelemetry } from "./onboarding-telemetry";
import { OnboardingEvent } from "@/lib/profile/onboarding-events";

afterEach(() => { cleanup(); sent.events = []; sent.flushes = 0; });

const stamp = (event: Record<string, unknown>) => ({ ...event, clientEventId: crypto.randomUUID(),
  at: new Date().toISOString(), flowVersion: "onboarding_v2" });

describe("onboarding telemetry (followups #18)", () => {
  it("maps every v2 beat to an enum step, never a new value", () => {
    expect(["opener", "facts", "week", "safety", "pace", "day", "foods", "reward", "minor"].map(stepForBeat))
      .toEqual(["intro", "facts", "facts", "allergy", "facts", "facts", "foods", "reward", "done"]);
    expect(questionFor("facts", "weightKg")).toBe("weightKg");
    expect(questionFor("week", null)).toBe("activity");
    expect(questionFor("facts", "requestedPaceLbPerWeek")).toBeNull();
  });

  it("sends steps and questions with durations only, and finish() flushes done", async () => {
    let t = 1_000;
    const { result, rerender } = renderHook(({ beat, field }) => useOnboardingTelemetry(beat, field, () => t),
      { initialProps: { beat: "opener", field: null as string | null } });
    t = 2_000; rerender({ beat: "facts", field: "birthYear" });
    t = 2_500; rerender({ beat: "facts", field: "weightKg" });
    t = 3_000; rerender({ beat: "week", field: null });
    t = 3_500; rerender({ beat: "safety", field: null });
    t = 4_000; rerender({ beat: "reward", field: null });
    await act(async () => { await result.current.finish(); });

    expect(sent.events.map((e) => `${e.kind}:${e.step ?? e.question}`)).toEqual([
      "step_entered:intro", "step_left:intro", "step_entered:facts", "question_entered:birthYear",
      "question_left:birthYear", "question_entered:weightKg", "question_left:weightKg",
      "question_entered:activity", "question_left:activity", "step_left:facts", "step_entered:allergy",
      "step_left:allergy", "step_entered:reward", "step_left:reward", "step_entered:done",
    ]);
    expect(sent.flushes).toBeGreaterThan(0);
    // No event carries an answer: each parses under the strict wire schema (no extra keys), and
    // only the enum identifier and a duration ride along.
    for (const event of sent.events) {
      expect(OnboardingEvent.safeParse(stamp(event)).success).toBe(true);
      expect(Object.keys(event).every((key) => ["kind", "step", "question", "durationMs"].includes(key))).toBe(true);
    }
  });

  it("an unmount before finishing reports the step abandoned", () => {
    const { unmount } = renderHook(() => useOnboardingTelemetry("foods", null));
    unmount();
    expect(sent.events.at(-1)).toMatchObject({ kind: "step_abandoned", step: "foods" });
  });
});
