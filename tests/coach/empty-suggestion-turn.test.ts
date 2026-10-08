/**
 * Live 2026-10-02: suggest_options built no snack and said why; the model then answered "I'm sorry,
 * I cannot fulfill that request." With no card and no action the tool's own explanation is the
 * reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000011",
  text: "two high protein snack ideas" };

function db() {
  const api = () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain, in: () => chain,
      is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      insert: () => chain, update: () => chain,
    });
    return chain;
  };
  return { from: () => api(), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [],
  getConstraints: async () => ({}),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};


const NO_SNACK = "I couldn't find a snack option that fits your food rules yet. Try another idea or add foods to your Favored list.";

function emptyWithMessage(message: string) {
  const cards = [] as unknown[];
  Object.defineProperty(cards, "message", { value: message });
  Object.defineProperty(cards, "toJSON", { value: () => ({ cards: [], message }) });
  return cards;
}

async function turn(finalText: string, suggest: () => Promise<unknown>) {
  const generate = vi.fn()
    .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "suggest_options", args: { kind: "snack", count: 2 } }] })
    .mockResolvedValueOnce({ kind: "final", text: finalText });
  const result = await runTurn(db(), db(), "u1", REQ, {
    classifyIntent: vi.fn().mockResolvedValue(null) as never,
    verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
    generate: generate as never,
    ports: { ...ports, suggest: suggest as never },
    now: () => 0,
    newId: () => "id-1",
  });
  return result.messages[1]?.content;
}

describe("an empty suggestion inside a coach turn", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("replies with the tool's own explanation, not the model's refusal", async () => {
    expect(await turn("I'm sorry, I cannot fulfill that request.", async () => emptyWithMessage(NO_SNACK)))
      .toBe(NO_SNACK);
  });

  it("replies with a refusal written for the person, not the model's apology", async () => {
    const REVIEW = "Review your existing food rules before getting recipe suggestions.";
    expect(await turn("I'm sorry, I cannot fulfill that request.", async () => {
      throw new HttpError(409, "rule_review_required", REVIEW);
    })).toBe(REVIEW);
  });

  it("keeps the model's text after an internal tool failure", async () => {
    expect(await turn("I couldn't check that just now.", async () => { throw new Error("db down"); }))
      .toBe("I couldn't check that just now.");
  });

  describe("beside another tool in the same turn (Grok review 2026-10-03)", () => {
    const REVIEW = "Review your existing food rules before getting recipe suggestions.";
    async function mixed(finalText: string) {
      const generate = vi.fn()
        .mockResolvedValueOnce({ kind: "tool", calls: [
          { name: "suggest_options", args: { kind: "recipe", count: 2 } },
          { name: "get_entries", args: { date: "2026-09-11" } },
        ] })
        .mockResolvedValueOnce({ kind: "final", text: finalText })
        .mockResolvedValueOnce({ kind: "final", text: "never asked for" });
      const dayEntries = vi.fn().mockResolvedValue([]);
      const result = await runTurn(db(), db(), "u1", REQ, {
        classifyIntent: vi.fn().mockResolvedValue(null) as never,
        verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
        generate: generate as never,
        ports: { ...ports, dayEntries, suggest: (async () => {
          throw new HttpError(409, "rule_review_required", REVIEW);
        }) as never } as never,
        now: () => 0,
        newId: () => "id-1",
      });
      return { reply: result.messages[1]?.content, calls: generate.mock.calls.length,
        entriesRead: dayEntries.mock.calls.length };
    }

    it("keeps a prose answer built from get_entries when suggest_options was refused", async () => {
      const result = await mixed("You logged nothing yet today.");
      expect(result.entriesRead).toBe(1);
      expect(result.reply).toBe("You logged nothing yet today.");
      expect(result.calls).toBe(2);
    });

    it("still replaces a bare refusal with the tool's own reason, without a retry round", async () => {
      const result = await mixed("I'm sorry, I cannot fulfill that request.");
      expect(result.reply).toBe(REVIEW);
      expect(result.calls).toBe(2);
    });
  });

  it("keeps the model's text when suggest_options gave no explanation", async () => {
    expect(await turn("Nothing fits right now.", async () => [])).toBe("Nothing fits right now.");
  });
});
