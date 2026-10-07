/**
 * Phase 18 W5b-2: the live coach turn attaches the taste chip proposal to a delivered model reply as
 * `tool_calls.tasteChips`, read back as the message view's `tasteChips` — only with
 * TASTE_CHIPS_ENABLED, only for text the local safety check sends, and never as a write. A rule the
 * user states takes the turn's proposal slot instead (the dietary profile card), and kept text makes
 * no taste Jev call.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { systemOneMock } = vi.hoisted(() => ({ systemOneMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/typesafe", async (original) => ({
  ...(await original<typeof import("@/lib/ai/typesafe")>()),
  systemOne: (p: { state: { text?: string }; purpose: string }) => systemOneMock(p.state, p.purpose),
}));

const { runTurn } = await import("@/tests/coach/fixtures/run-turn");

type Recorded = { cases: { text: string; response: { answers: unknown } }[] };
const RECORDED = JSON.parse(readFileSync("tests/fixtures/taste-jev-recorded.json", "utf8")) as Recorded;
const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000021", text: "" };

const writes: string[] = [];
function db() {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain, in: () => chain,
      is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      insert: () => { writes.push(table); return chain; }, update: () => { writes.push(table); return chain; },
    });
    return chain;
  };
  return { from: (t: string) => api(t), rpc: async (name: string) => {
    if (name.startsWith("taste_chips")) writes.push(name);
    return { data: [], error: null };
  } } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }), weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }), searchFoods: async () => [],
  getConstraints: async () => ({ avoid_allergens: [] }), recentGut: async () => [], newDraftId: () => "draft-1",
};
let ids = 0;
const deps = () => ({ generate: (() => Promise.resolve({ kind: "final", text: "Noted." })) as never, ports,
  logEntryExists: async () => true, now: () => 0, newId: () => `id-${++ids}` });
const tasteCalls = () => systemOneMock.mock.calls.filter(([, purpose]) => purpose === "profile-taste");

beforeEach(() => {
  vi.stubEnv("COACH_ENABLED", "1");
  vi.stubEnv("TASTE_CHIPS_ENABLED", "1");
  writes.length = 0;
  systemOneMock.mockReset().mockImplementation(async (state: { text?: string }, purpose: string) =>
    purpose === "profile-taste" ? RECORDED.cases.find((c) => c.text === state.text)?.response.answers ?? null : null);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("runTurn — taste chips beside the reply", () => {
  it("proposes the classifier's chips on the assistant message and writes no preference", async () => {
    const client = db();
    const result = await runTurn(client, client, "u1", { ...REQ, text: "I can't stand mushy textures" }, deps());
    const assistant = result.messages.at(-1)!;
    expect(assistant.tasteChips).toMatchObject({ kind: "taste_chips_proposal", v: 1,
      dislikes: [{ key: "t:soft" }], cuisines: [], provenance: { ai: true, source: "jev", purpose: "profile-taste" } });
    expect(tasteCalls()).toHaveLength(1);
    // The taste card replaces the soft "less mushy textures" food-preference card for this sentence.
    expect(assistant.blocks ?? []).toEqual([]);
    const PREFERENCE_WRITES = ["user_settings", "user_food_prefs", "user_dietary_profiles", "taste_chip_receipts",
      "coach_action_undos", "taste_chips_confirm", "taste_chips_undo"];
    expect(writes.filter((w) => PREFERENCE_WRITES.includes(w))).toEqual([]);
  });

  it("is dark without the flag, and kept text never reaches the taste classifier", async () => {
    const client = db();
    vi.stubEnv("TASTE_CHIPS_ENABLED", "");
    const dark = await runTurn(client, client, "u1", { ...REQ, text: "I can't stand mushy textures" }, deps());
    expect(dark.messages.at(-1)!.tasteChips).toBeUndefined();
    vi.stubEnv("TASTE_CHIPS_ENABLED", "1");
    for (const text of ["dairy gives me cramps", "I'm allergic to peanuts", "I keep kosher"]) {
      const kept = await runTurn(client, client, "u1", { ...REQ, text }, deps());
      expect([text, kept.messages.at(-1)!.tasteChips]).toEqual([text, undefined]);
    }
    expect(tasteCalls()).toHaveLength(0);
  });

  it("a like alone proposes no taste card; with Jev down the food-preference card stays", async () => {
    const client = db();
    const result = await runTurn(client, client, "u1", { ...REQ, text: "I love salmon" }, deps());
    expect(result.messages.at(-1)!.tasteChips).toBeUndefined();
    systemOneMock.mockReset().mockResolvedValue(null);
    const down = await runTurn(client, client, "u1", { ...REQ, text: "I can't stand mushy textures" }, deps());
    expect(down.messages.at(-1)!.tasteChips).toBeUndefined();
    expect(down.messages.at(-1)!.blocks?.[0]).toMatchObject({ kind: "dietary_profile_proposal", profileId: "food_preferences" });
  });
});
