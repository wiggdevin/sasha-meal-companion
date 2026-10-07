import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntentFallbackReason, IntentResult } from "@/lib/coach/intent";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import {
  intentEvent,
  recordCoachIntentEvent,
  type CoachIntentEvent,
} from "@/lib/server/coach-intent-telemetry";

type Row = Record<string, unknown>;
type Write = { table: string; row: unknown };

function db(writes: Write[]) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      lte: () => chain,
      gte: () => chain,
      in: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: (row: unknown) => { writes.push({ table, row }); return chain; },
      update: (row: unknown) => { writes.push({ table, row }); return chain; },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    });
    return chain;
  };
  return { from: (table: string) => api(table), rpc: async () => ({ data: [], error: null }) } as never;
}

function classified<I extends IntentResult["intent"]>(
  intent: I,
  args: Extract<IntentResult, { intent: I }>["args"],
  confidence: number,
  argConfidence: Record<string, number>,
): Extract<IntentResult, { intent: I }> {
  return { intent, args, confidence, argConfidence, raw: {} as never } as unknown as
    Extract<IntentResult, { intent: I }>;
}

async function telemetryRow(
  result: IntentResult | null,
  options: { text?: string; ports?: Record<string, unknown> } = {},
): Promise<Row> {
  const writes: Write[] = [];
  await runTurn(db(writes), db(writes), "user-1", {
    threadId: null,
    messageId: "3f1b1a2c-0000-4000-8000-000000000010",
    text: options.text ?? "please help with this",
    now: "2026-09-19T10:00:00-06:00",
    tz: "America/Denver",
  }, {
    classifyIntent: vi.fn().mockResolvedValue(result) as never,
    generate: vi.fn().mockResolvedValue({ kind: "final", text: "I can help with that." }) as never,
    ...(options.ports ? { ports: options.ports as never } : {}),
    now: () => Date.parse("2026-09-19T16:00:00.000Z"),
    newId: () => "id-1",
  });

  const events = writes.filter((write) => write.table === "coach_intent_events");
  expect(events).toHaveLength(1);
  return events[0].row as Row;
}

function expectFallbackRow(
  row: Row,
  expected: {
    reason: IntentFallbackReason;
    intent: IntentResult["intent"] | null;
    winningConfidence: number | null;
    minArgumentConfidence: number | null;
  },
): void {
  expect(row).toEqual({
    user_id: "user-1",
    intent: expected.intent,
    winning_confidence: expected.winningConfidence,
    min_argument_confidence: expected.minArgumentConfidence,
    fast_path_taken: false,
    fallback_reason: expected.reason,
    latency_ms: expect.any(Number),
  });
}

describe("coach intent telemetry", () => {
  beforeEach(() => vi.stubEnv("COACH_ENABLED", "1"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("records below_threshold with the classifier confidences", async () => {
    const row = await telemetryRow(classified("shift_schedule", {
      minutes: 30, direction: "later", scope: "remaining",
    }, 0.94, { minutes: 1, direction: 0.98, scope: 0.96 }));

    expectFallbackRow(row, {
      reason: "below_threshold",
      intent: "shift_schedule",
      winningConfidence: 0.94,
      minArgumentConfidence: 0.96,
    });
  });

  it("records missing_arg for an incomplete mechanical request", async () => {
    const row = await telemetryRow(classified("shift_schedule", {
      direction: "later", scope: "remaining", missing: ["minutes"],
    }, 0.97, { direction: 0.98, scope: 0.96 }));

    expectFallbackRow(row, {
      reason: "missing_arg",
      intent: "shift_schedule",
      winningConfidence: 0.97,
      minArgumentConfidence: 0.96,
    });
  });

  it("records grounding when a mechanical action cannot resolve its food", async () => {
    const row = await telemetryRow(classified("add_to_eats", {
      name: "moon melon",
    }, 0.97, { name: 1 }), {
      text: "add moon melon to my Eats list",
      ports: { searchFoods: async () => [] },
    });

    expectFallbackRow(row, {
      reason: "grounding",
      intent: "add_to_eats",
      winningConfidence: 0.97,
      minArgumentConfidence: 1,
    });
  });

  it("records jev_down with null classifier fields", async () => {
    const row = await telemetryRow(null);

    expectFallbackRow(row, {
      reason: "jev_down",
      intent: null,
      winningConfidence: null,
      minArgumentConfidence: null,
    });
  });

  it("records clarifying for a non-mechanical winner", async () => {
    const row = await telemetryRow(classified("question", {}, 0.99, {}));

    expectFallbackRow(row, {
      reason: "clarifying",
      intent: "question",
      winningConfidence: 0.99,
      minArgumentConfidence: null,
    });
  });

  it("stores no utterance, food name, or health field in the serialized insert payload", async () => {
    const utterance = "private utterance token";
    const foodName = "private food token";
    const healthField = "private health token";
    const sensitiveResult: IntentResult<"add_to_eats"> = {
      intent: "add_to_eats",
      confidence: 0.97,
      args: { name: foodName },
      argConfidence: { name: 1 },
      raw: { utterance, healthField } as never,
    };
    const writes: Write[] = [];

    await recordCoachIntentEvent(db(writes), "user-1",
      intentEvent(sensitiveResult, false, "grounding", 12));

    const serialized = JSON.stringify(writes.find((write) =>
      write.table === "coach_intent_events")?.row);
    expect(serialized).not.toContain(utterance);
    expect(serialized).not.toContain(foodName);
    expect(serialized).not.toContain(healthField);
  });

  it("marks the fast-path row true and the LLM row false", async () => {
    const fast = await telemetryRow(classified("shift_schedule", {
      minutes: 30, direction: "later", scope: "remaining",
    }, 0.97, { minutes: 1, direction: 0.98, scope: 0.96 }));
    const llm = await telemetryRow(classified("shift_schedule", {
      minutes: 30, direction: "later", scope: "remaining",
    }, 0.94, { minutes: 1, direction: 0.98, scope: 0.96 }));

    expect(fast).toMatchObject({ fast_path_taken: true, fallback_reason: "none" });
    expect(llm).toMatchObject({ fast_path_taken: false, fallback_reason: "below_threshold" });
  });

  it("swallows insert failures and warns at most once per minute", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const insert = vi.fn().mockResolvedValue({ error: { code: "42P01" } });
    const failingClient = { from: () => ({ insert }) } as never;
    const event: CoachIntentEvent = {
      intent: "question",
      winningConfidence: 0.99,
      minArgumentConfidence: null,
      fastPathTaken: false,
      fallbackReason: "clarifying",
      latencyMs: 10,
    };

    await expect(recordCoachIntentEvent(failingClient, "user-1", event)).resolves.toBeUndefined();
    now += 30_000;
    await expect(recordCoachIntentEvent(failingClient, "user-1", event)).resolves.toBeUndefined();
    now += 30_001;
    await expect(recordCoachIntentEvent(failingClient, "user-1", event)).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, "[coach] intent telemetry insert failed: 42P01");
    expect(warn).toHaveBeenNthCalledWith(2, "[coach] intent telemetry insert failed: 42P01");
  });
});
