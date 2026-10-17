/**
 * OD06 / W091: a coach turn with a draft sink. The final step's text streams as the model writes
 * it; a tool step streams nothing; the saved reply is the turn's, whatever the draft said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000012",
  text: "what should I have for breakfast" };

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

/** A model double that streams `final` the way a provider would, a few characters at a time. */
function streamingModel(steps: Record<string, unknown>[]) {
  let i = 0;
  return vi.fn(async (args: { onText?: (raw: string) => void }) => {
    const step = steps[i++];
    // Schema order: `kind` first, `text` after the actions (lib/coach/wire.ts).
    const ordered = JSON.stringify({ kind: step.kind, calls: [], actions: [], suggestions: [],
      text: "", memory: [], reason: "", ...step });
    for (let n = 4; n < ordered.length; n += 4) args.onText?.(ordered.slice(0, n));
    args.onText?.(ordered);
    return step;
  });
}

describe("a coach turn with a draft sink", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("streams the final step's text only, and saves the turn's own reply", async () => {
    const drafts: string[] = [];
    const reply = "Greek yogurt with berries fits your morning.";
    const generate = streamingModel([
      { kind: "tool", calls: [{ name: "get_day", args: {} }], text: "not shown" },
      { kind: "final", text: reply },
    ]);
    const result = await runTurn(db(), db(), "u1", REQ, {
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      generate: generate as never,
      ports: ports as never,
      now: () => 0,
      newId: () => "id-1",
      draft: (text) => drafts.push(text),
    });
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.at(-1)).toBe(reply);
    expect(drafts.every((text) => reply.startsWith(text))).toBe(true);
    expect(drafts.some((text) => text.includes("not shown"))).toBe(false);
    expect(result.messages[1]?.content).toBe(reply);
  });

  it("changes nothing without a sink", async () => {
    const generate = streamingModel([{ kind: "final", text: "Oats." }]);
    const result = await runTurn(db(), db(), "u1", REQ, {
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      generate: generate as never, ports: ports as never, now: () => 0, newId: () => "id-1",
    });
    expect(result.messages[1]?.content).toBe("Oats.");
  });
});
