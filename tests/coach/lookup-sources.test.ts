/**
 * Phase 13 §3.3 "Source links are shown" (slice 6, review r1 sol FIX): a successful `lookup`
 * with sources puts its links in the reply the user reads, whatever the model's own final text
 * says — the tool transcript alone is not a guarantee.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendLookupSources } from "@/lib/coach/lookup-sources";
import type { LookupToolResult } from "@/lib/coach/lookup-types";
import { runTurn } from "@/tests/coach/fixtures/run-turn";

const request = {
  threadId: null,
  messageId: "3f1b1a2c-0000-4000-8000-000000000020",
  text: "Are Wheat Thins vegan?",
  now: "2026-09-19T10:00:00-06:00",
  tz: "America/Denver",
};

function database(writes: { table: string; row: Record<string, unknown> }[]) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, neq: () => chain, lte: () => chain, lt: () => chain,
      in: () => chain, is: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      insert: (row: Record<string, unknown>) => { writes.push({ table, row }); return chain; },
      update: () => chain,
    });
    return chain;
  };
  return { from, rpc: async () => ({ data: [], error: null }) } as never;
}

const found: LookupToolResult = {
  ok: true, subject: "Wheat Thins", resolvedName: "Wheat Thins, Original", foodRefId: "food-1",
  brand: "Nabisco", answer: "Wheat Thins Original list no animal ingredients.",
  sources: [{ uri: "https://example.com/wheat-thins", title: "Example" }],
  webSearchQueries: 1, evidence: { level: "no_evidence", labelComplete: false },
};

describe("appendLookupSources", () => {
  it("adds each source link once, after the reply", () => {
    const out = appendLookupSources("They look vegan.", [
      { uri: "https://a.example/x", title: "A" }, { uri: "https://a.example/x", title: "A" },
      { uri: "https://b.example/y", title: null },
    ]);
    expect(out).toBe("They look vegan.\n\nSources: A (https://a.example/x); https://b.example/y");
  });

  it("leaves the reply alone when there are no sources", () => {
    expect(appendLookupSources("They look vegan.", [])).toBe("They look vegan.");
  });
});

describe("a lookup turn", () => {
  beforeEach(() => vi.stubEnv("COACH_ENABLED", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("shows the lookup's source links even when the model's reply omits them", async () => {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const client = database(writes);
    const generate = vi.fn()
      .mockResolvedValueOnce({ kind: "tool", calls: [{ name: "lookup", args: { subject: "Wheat Thins" } }] })
      .mockResolvedValueOnce({ kind: "final", text: "They list no animal ingredients." });
    const result = await runTurn(client, client, "user-1", request, {
      generate: generate as never,
      classifyIntent: vi.fn().mockResolvedValue(null) as never,
      verifyReply: vi.fn().mockResolvedValue({ flagged: false, p: null }) as never,
      newId: (() => { let n = 0; return () => `generated-${++n}`; })(),
      ports: { lookup: vi.fn(async () => found) } as never,
    });
    const reply = result.messages.at(-1)?.content ?? "";
    expect(reply).toContain("They list no animal ingredients.");
    expect(reply).toContain("https://example.com/wheat-thins");
  });
});
