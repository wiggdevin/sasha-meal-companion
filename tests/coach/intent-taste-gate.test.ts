/**
 * Phase 18 W5b (D9, Sol r1 BLOCK 2b): the coach intent pre-pass never sends a rule, symptom or
 * unsure taste statement to Jev — 0 calls on the whole keep-local corpus — while the app's own
 * commands still reach it. The main coach reply (Gemini) is the existing consented chat path and is
 * outside D9's Jev scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));
vi.mock("@/lib/ai/typesafe", async (original) => ({
  ...(await original<typeof import("@/lib/ai/typesafe")>()),
  systemOne: (p: { purpose: string }) => systemOneMock(p.purpose),
}));

import { classifyIntent } from "@/lib/coach/intent";
import { mayReachJev } from "@/lib/profile/taste-safety";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS, REDTEAM_CORPUS } from "@/tests/fixtures/taste-safety-corpus";

/** One message per command form of the grammar (lib/profile/coach-commands.ts). */
const COMMANDS = ["16 oz water", "drank 500 ml", "add cheese to my avoid list", "I weigh 128 lb", "avoid cake",
  "move my meals 30 minutes later", "make me 5 suggestions from my eats list", "a chicken wrap that fits my macros",
  "what should I eat for lunch?", "set kcal to 2300", "I am 34", "show my weight trend", "log 2 eggs and toast",
  "set my breakfast to oatmeal with blueberries every weekday for the next two weeks", "how am I doing this week"];

const ctx = { now: "2026-10-06T10:00:00-06:00", userId: "u1" };

beforeEach(() => { vi.stubEnv("TYPESAFE_API_KEY", "test-key"); systemOneMock.mockReset().mockResolvedValue(null); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the coach intent pre-pass and the taste safety check", () => {
  it("makes 0 Jev calls for every keep-local sentence", async () => {
    const corpus = [...ACCEPTANCE_LOCAL.map((c) => c.text), ...HEALTH_CORPUS.map((c) => c.text), ...REDTEAM_CORPUS];
    expect(corpus.length).toBeGreaterThan(600);
    for (const text of corpus) await classifyIntent(text, ctx);
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("never lets a command carry any corpus sentence, rules, symptom or unsure, before or after it (Sol r3)", () => {
    const corpus = [...ACCEPTANCE_LOCAL.map((c) => c.text), ...HEALTH_CORPUS.map((c) => c.text), ...REDTEAM_CORPUS];
    const leaks: string[] = [];
    for (const sentence of corpus) {
      for (const command of COMMANDS) {
        for (const text of [`${command} ${sentence}`, `${sentence} ${command}`, `${command}. ${sentence}`,
          `${sentence}. ${command}`, `${command}, ${sentence}`, `${command} because ${sentence}`]) {
          if (mayReachJev(text)) leaks.push(text);
        }
      }
    }
    expect(corpus.length).toBeGreaterThan(600);
    expect(leaks).toEqual([]);
    for (const text of ["Add cheese to my avoid list because my face goes red", "Add cheese to my avoid list. I can't handle dairy"]) {
      expect([text, mayReachJev(text)]).toEqual([text, false]);
    }
  });

  it("16 oz water, drank 500 ml and add cheese to my avoid list still reach the intent pass", () => {
    for (const text of ["16 oz water", "drank 500 ml", "add cheese to my avoid list"]) expect(mayReachJev(text)).toBe(true);
  });

  it("still classifies the app's own commands", async () => {
    for (const text of COMMANDS) await classifyIntent(text, ctx);
    expect(systemOneMock).toHaveBeenCalledTimes(COMMANDS.length);
  });
});
