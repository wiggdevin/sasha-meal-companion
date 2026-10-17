import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachAction } from "@/lib/coach/actions";

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));

vi.mock("@/lib/ai/typesafe", () => ({
  noul: (instructions: string, criteria?: Record<string, string>) => ({
    type: "noul", instructions, ...(criteria ? { criteria } : {}),
  }),
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    systemOneMock(p.state, p.questions, { ...o, purpose: p.purpose }),
}));

import { verifyReply } from "@/lib/coach/verify";

const action: CoachAction = {
  kind: "shift_schedule",
  actionId: "action-1",
  flagged: [],
  date: "2026-09-19",
  minutes: 30,
  scope: "remaining",
};

function answer(p: number) {
  return { claims_unlisted_action: { type: "noul", noul: p } };
}

describe("coach reply verification", () => {
  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    systemOneMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the deterministic check, with no Jev call, while JEV_HEALTH_GATE is 1 (OD12)", async () => {
    vi.stubEnv("JEV_HEALTH_GATE", "1");
    await expect(verifyReply({
      reply: "Logged your lunch — 620 kcal.", actions: [], toolResults: [],
    }, { userId: "u1" })).resolves.toEqual({ flagged: true, p: null });
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("flags a claimed log with no covering action", async () => {
    systemOneMock.mockResolvedValue(answer(0.94));

    await expect(verifyReply({
      reply: "Logged your lunch — 620 kcal.", actions: [], toolResults: [],
    }, { userId: "u1" })).resolves.toEqual({ flagged: true, p: 0.94 });

    const [state, questions, options] = systemOneMock.mock.calls[0];
    expect(state).toEqual({
      reply: "Logged your lunch — 620 kcal.", actions: [],
      tools_ran: { access: "read_only", names: [] },
    });
    expect(questions.claims_unlisted_action.criteria).toEqual({
      true: expect.stringContaining("no listed action"),
      false: expect.stringContaining("covered by a listed action"),
    });
    expect(options).toEqual({ purpose: "coach-verify", userId: "u1" });
  });

  it("flags a write claim that has only a read-only tool behind it", async () => {
    systemOneMock.mockResolvedValue(answer(0.9));

    await expect(verifyReply({
      reply: "Logged your lunch", actions: [], toolResults: ["compose_meal"],
    }, { userId: "u1" })).resolves.toEqual({ flagged: true, p: 0.9 });

    const [state, questions] = systemOneMock.mock.calls[0];
    expect(state).toEqual({
      reply: "Logged your lunch", actions: [],
      tools_ran: { access: "read_only", names: ["compose_meal"] },
    });
    expect(questions.claims_unlisted_action.instructions).toContain(
      "`tools_ran` is read-only and never covers a write claim");
  });

  it("passes a benign statement about remaining calories", async () => {
    systemOneMock.mockResolvedValue(answer(0.03));

    await expect(verifyReply({
      reply: "You have 640 kcal left today.", actions: [], toolResults: [],
    }, { userId: "u1" })).resolves.toEqual({ flagged: false, p: 0.03 });
  });

  it("falls back to the existing heuristic when Jev is unavailable", async () => {
    systemOneMock.mockResolvedValue(null);

    await expect(verifyReply({
      reply: "Logged your lunch — 620 kcal.", actions: [], toolResults: [],
    }, { userId: "u1" })).resolves.toEqual({ flagged: true, p: null });
    await expect(verifyReply({
      reply: "You have 640 kcal left today.", actions: [], toolResults: [],
    }, { userId: "u1" })).resolves.toEqual({ flagged: false, p: null });
  });

  it("passes a claim covered by a listed action", async () => {
    systemOneMock.mockResolvedValue(answer(0.04));

    const result = await verifyReply({
      reply: "Moved your remaining meals 30 minutes later.",
      actions: [action],
      toolResults: [{ name: "get_plan", ok: true }],
    }, { userId: "u1" });

    expect(result).toEqual({ flagged: false, p: 0.04 });
    expect(systemOneMock.mock.calls[0][0]).toMatchObject({
      actions: [{ kind: "shift_schedule",
        summary: "[action: shift_schedule 2026-09-19 30 min remaining]" }],
      tools_ran: { access: "read_only", names: ["get_plan"] },
    });
  });
});

describe("chart claims without a block", () => {
  it("flags a reply that points at a chart or breakdown when no block came with it", async () => {
    const { claimsChart } = await import("@/lib/coach/verify");
    expect(claimsChart("Here's the breakdown below.", 0)).toBe(true);
    expect(claimsChart("See the chart for your week.", 0)).toBe(true);
    expect(claimsChart("Here's the breakdown below.", 1)).toBe(false);
    expect(claimsChart("You ate 1,800 kcal today.", 0)).toBe(false);
  });
});
