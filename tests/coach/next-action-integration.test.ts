import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/lib/server/coach-turn";

beforeEach(() => {
  vi.stubEnv("COACH_ENABLED", "1");
  vi.stubEnv("TYPESAFE_API_KEY", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000099", text: "" };

/** Same minimal Supabase double used by the coach turn fixtures: a table-name-keyed recorder with the four
 *  chains runTurn uses. */
function db(tables: Record<string, unknown[]>, writes: { rows: { table: string; row: unknown }[] }) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain,
      in: () => chain, is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      insert: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
      update: (row: unknown) => { writes.rows.push({ table, row }); return chain; },
    });
    return chain;
  };
  return { from: (t: string) => api(t), rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [{ foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a", name: "rice",
    brand: null, kcalPer100g: 130, prefStatus: "eats" as const }],
  getConstraints: async () => ({}),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

const logged = { logEntryExists: async () => true };

function assistantBlocks(writes: { rows: { table: string; row: unknown }[] }) {
  const row = writes.rows.filter((w) => w.table === "coach_messages").at(-1)!
    .row as { tool_calls: { blocks: { kind: string; action?: string }[] } };
  return row.tool_calls.blocks;
}

describe("runTurn — next-action chip (§6, slice 7)", () => {
  it.each([true, false])("proposes check_label for an unresolved suggestion (logged=%s)", async (exists) => {
    // No evidence this turn: the named suggestion carries no foodRefId, so checkItem reads it
    // unverified, and check_label outranks pick_suggestion and log_meal for the same
    // turn. This is the ranker doing its job, not a bug — see the isolated case below.
    const generate = vi.fn().mockResolvedValueOnce({
      kind: "final", text: "Rice would fit well.",
      suggestions: [{ name: "rice", grams: 150 }],
    });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    await runTurn(db({}, writes), db({}, writes), "u1", { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports, logEntryExists: async () => exists,
        now: () => 0, newId: () => "id-1" });
    const blocks = assistantBlocks(writes);
    expect(blocks).toContainEqual(expect.objectContaining({
      kind: "next_action_chip", action: "check_label",
    }));
  });

  it.each([true, false])("chooses the next action for a verified suggestion (logged=%s)", async (exists) => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool",
        calls: [{ name: "search_foods", args: { query: "rice" } }] })
      .mockResolvedValueOnce({
        kind: "final", text: "Rice would fit well.",
        suggestions: [{ name: "rice", grams: 150 }],
      });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const verifiedPorts = {
      ...ports,
      searchFoods: async () => [{
        foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a", name: "rice", brand: null,
        kcalPer100g: 130, prefStatus: "eats" as const, allergenTags: [] as string[],
      }],
    };
    await runTurn(db({}, writes), db({}, writes), "u1", { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports: verifiedPorts, logEntryExists: async () => exists,
        now: () => 0, newId: () => "id-1" });
    const blocks = assistantBlocks(writes);
    expect(blocks).toContainEqual(expect.objectContaining({
      kind: "next_action_chip", action: exists ? "pick_suggestion" : "log_meal",
    }));
  });

  it("adds no chip when nothing in turn state is eligible", async () => {
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "Sounds good." });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    await runTurn(db({}, writes), db({}, writes), "u1", { ...REQ, text: "just checking in" },
      { generate: generate as never, ports, ...logged, now: () => 0, newId: () => "id-1" });
    const blocks = assistantBlocks(writes);
    expect(blocks.some((b) => b.kind === "next_action_chip")).toBe(false);
  });

  it("adds no chip on an abort — a re-ask is not a moment for a generic next step", async () => {
    const generate = vi.fn().mockResolvedValueOnce({ kind: "abort", reason: "max_tool_calls" });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const logEntryExists = vi.fn().mockResolvedValue(false);
    await runTurn(db({}, writes), db({}, writes), "u1", { ...REQ, text: "what should I eat" },
      { generate: generate as never, ports, logEntryExists,
        now: () => 0, newId: () => "id-1" });
    const blocks = assistantBlocks(writes);
    expect(blocks.some((b) => b.kind === "next_action_chip")).toBe(false);
    expect(logEntryExists).not.toHaveBeenCalled();
  });

  it("adds no chip when the tool loop ends on a non-final step", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "final", text: "I logged your meal." })
      .mockResolvedValue({ kind: "tool", calls: [{ name: "get_day",
        args: { date: "2026-10-05" } }] });
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const logEntryExists = vi.fn().mockResolvedValue(false);
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "log my lunch" }, {
        generate: generate as never, ports, logEntryExists,
        classifyIntent: async () => null as never,
        verifyReply: async () => ({ flagged: true, p: null }),
        now: () => 0, newId: () => "id-1",
      });
    expect(generate).toHaveBeenCalledTimes(11);
    expect(result.messages.at(-1)?.content).toMatch(/pin that one down/);
    expect(assistantBlocks(writes)).toEqual([]);
    expect(logEntryExists).not.toHaveBeenCalled();
  });

  it("returns the assistant reply when the log existence read fails", async () => {
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Sounds good." });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const writes = { rows: [] as { table: string; row: unknown }[] };
    const result = await runTurn(db({}, writes), db({}, writes), "u1",
      { ...REQ, text: "just checking in" },
      { generate: generate as never, ports,
        logEntryExists: async () => { throw new Error("private read detail"); },
        now: () => 0, newId: () => "id-1" });
    expect(result.messages.at(-1)?.content).toBe("Sounds good.");
    expect(assistantBlocks(writes)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("coach log entry read failed", { userId: "u1" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it.each([[false, true], [true, false]])(
    "shows the log_meal chip only when the day has no live entry (%s)",
    async (exists, shouldShow) => {
      const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Sounds good." });
      const writes = { rows: [] as { table: string; row: unknown }[] };
      const logEntryExists = vi.fn().mockResolvedValue(exists);
      const client = db({}, writes);
      const result = await runTurn(client, db({}, writes), "u1",
        { ...REQ, text: "just checking in", now: "2026-10-06T05:30:00.000Z",
          tz: "America/Denver" },
        { generate: generate as never, ports, logEntryExists, now: () => 0,
          newId: () => "id-1" });
      const chips = result.messages.at(-1)?.blocks?.filter((b) => b.kind === "next_action_chip")
        ?? [];
      expect(chips.some((chip) => chip.kind === "next_action_chip"
        && chip.action === "log_meal" && chip.label === "Log your next meal"))
        .toBe(shouldShow);
      expect(logEntryExists).toHaveBeenCalledWith(client, "u1", "2026-10-05",
        expect.any(AbortSignal));
    });

  it("aborts an in-flight log read when the reply deadline expires", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const writes = { rows: [] as { table: string; row: unknown }[] };
      const aborted = vi.fn();
      let started!: () => void;
      const readStarted = new Promise<void>((resolve) => { started = resolve; });
      const turn = runTurn(db({}, writes), db({}, writes), "u1",
        { ...REQ, text: "just checking in" }, {
          generate: vi.fn().mockResolvedValue({ kind: "final", text: "Sounds good." }) as never,
          ports, now: () => 0, newId: () => "id-1", replyDeadlineMs: 100,
          logEntryExists: async (_client, _userId, _date, signal) => {
            started();
            return new Promise<boolean>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                aborted(); reject(new Error("request aborted"));
              }, { once: true });
            });
          },
        });
      await readStarted;
      await vi.advanceTimersByTimeAsync(101);
      await turn;
      expect(aborted).toHaveBeenCalledTimes(1);
      expect(assistantBlocks(writes)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
