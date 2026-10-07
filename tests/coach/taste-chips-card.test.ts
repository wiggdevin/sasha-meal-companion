/**
 * Phase 18 W5b: the coach taste chip PROPOSAL and its builder. Proposal data only — no action id, no
 * write — dark behind TASTE_CHIPS_ENABLED, never reaching Jev for text the local check keeps. Slice
 * W5b-2 attaches it to delivered replies (tests/coach/run-turn-taste-chips.test.ts) and confirms the
 * user's picks on the server (tests/coach/taste-chips-confirm.test.ts).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/typesafe", async (original) => ({
  ...(await original<typeof import("@/lib/ai/typesafe")>()),
  systemOne: (p: { state: { text?: string }; purpose: string }) => systemOneMock(p.state, p.purpose),
}));

import { hydrateTasteChipsProposal, tasteChipsProposalSchema } from "@/lib/coach/taste-chips-card";
import { mayProposeTaste, tasteChipsCard } from "@/lib/server/coach-taste";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS } from "@/tests/fixtures/taste-safety-corpus";

type Recorded = { cases: { text: string; response: { answers: unknown } }[] };
const RECORDED = JSON.parse(readFileSync("tests/fixtures/taste-jev-recorded.json", "utf8")) as Recorded;

beforeEach(() => {
  vi.stubEnv("TASTE_CHIPS_ENABLED", "1");
  systemOneMock.mockReset().mockImplementation(async (state: { text?: string }) =>
    RECORDED.cases.find((c) => c.text === state.text)?.response.answers ?? null);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("the taste chip proposal", () => {
  it("holds dislikes and cuisines at 0.8 or more, with no action id, and refuses what the parsers refuse", () => {
    const card = hydrateTasteChipsProposal("c1", { dislikes: [{ key: "t:soft", label: "Soft", p: 0.97 }], cuisines: [] });
    expect(card).toEqual({ kind: "taste_chips_proposal", v: 1, id: "c1",
      dislikes: [{ key: "t:soft", label: "Soft", p: 0.97 }], cuisines: [] });
    expect(tasteChipsProposalSchema.safeParse({ ...card, actionId: "a1" }).success).toBe(false);
    for (const bad of [{ dislikes: [{ key: "f:Okra", label: "x", p: 0.9 }], cuisines: [] },
      { dislikes: [], cuisines: [{ key: "martian", label: "x", p: 0.9 }] },
      { dislikes: [{ key: "t:soft", label: "x", p: 0.5 }], cuisines: [] }, { dislikes: [], cuisines: [] }]) {
      expect(hydrateTasteChipsProposal("c", bad)).toBeNull();
    }
  });

  it("the builder proposes from the recorded answers, and nothing for a like alone", async () => {
    expect(await tasteChipsCard("I can't stand mushy textures", "u1", () => "c1"))
      .toMatchObject({ dislikes: [{ key: "t:soft", p: 0.97 }] });
    expect(await tasteChipsCard("I grew up on Tex-Mex", "u1", () => "c2"))
      .toMatchObject({ cuisines: [{ key: "latin_american", p: 0.94 }] });
    expect(await tasteChipsCard("I love salmon", "u1", () => "c3")).toBeNull();
  });

  it("never calls Jev for kept text, and is dark without the flag", async () => {
    for (const c of [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS]) {
      expect([c.text, await tasteChipsCard(c.text, "u1", () => "c")]).toEqual([c.text, null]);
    }
    vi.stubEnv("TASTE_CHIPS_ENABLED", "");
    expect(mayProposeTaste("I can't stand mushy textures")).toBe(false);
    expect(await tasteChipsCard("I can't stand mushy textures", "u1", () => "c")).toBeNull();
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("is not a coach action the model can emit: confirm_taste_chips is no registry kind (W5b-2 confirms on the server)", () => {
    expect(/confirm_taste_chips/.test(readFileSync("lib/coach/actions/index.ts", "utf8"))).toBe(false);
  });
});
