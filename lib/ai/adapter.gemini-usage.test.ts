/**
 * r4 new finding: `outputTokens` read only `candidatesTokenCount`, so a call whose Gemini
 * thinking work is billed (`usageMetadata.thoughtsTokenCount`, additive to the total per
 * `node_modules/@google/genai/dist/genai.d.ts`) reported a cost lower than what was actually
 * charged, while `usageKnown` stayed `true` — known, but wrong, rather than correctly unknown.
 */
import { withSpendRpc } from "@/tests/ai/spend-admin";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "./adapter";
import { capturePayload } from "./gemini-payloads";

const sdk = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@google/genai", async (original) => ({
  ...await original<typeof import("@google/genai")>(),
  GoogleGenAI: class { models = { generateContent: sdk.generate }; },
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function memoryAdmin() {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, neq: () => chain, gte: () => chain,
    insert: () => chain,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  });
  return withSpendRpc({ from: () => chain }) as never;
}

it("adds thinking tokens into output tokens, never drops them silently", async () => {
  vi.stubEnv("GEMINI_API_KEY", "synthetic-test-key");
  sdk.generate.mockResolvedValue({ text: '{"ok":true}', usageMetadata: {
    promptTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 25 } });
  const payload = capturePayload("textToItems", { text: "Return ok.", localDate: "2026-09-23" });
  const results: { inputTokens: number; outputTokens: number; usageKnown?: boolean }[] = [];
  await generateStructured({ payload, userId: "synthetic-user",
    schema: z.object({ ok: z.boolean() }), admin: memoryAdmin() },
    { onProviderResult: (_model, { inputTokens, outputTokens, usageKnown }) => {
      results.push({ inputTokens, outputTokens, usageKnown }); } });
  expect(results).toEqual([{ inputTokens: 40, outputTokens: 35, usageKnown: true }]);
});

it("stays usage-known when thinking billed nothing (no thoughtsTokenCount field)", async () => {
  vi.stubEnv("GEMINI_API_KEY", "synthetic-test-key");
  sdk.generate.mockResolvedValue({ text: '{"ok":true}', usageMetadata: {
    promptTokenCount: 40, candidatesTokenCount: 10 } });
  const payload = capturePayload("textToItems", { text: "Return ok.", localDate: "2026-09-23" });
  const results: { inputTokens: number; outputTokens: number; usageKnown?: boolean }[] = [];
  await generateStructured({ payload, userId: "synthetic-user",
    schema: z.object({ ok: z.boolean() }), admin: memoryAdmin() },
    { onProviderResult: (_model, { inputTokens, outputTokens, usageKnown }) => {
      results.push({ inputTokens, outputTokens, usageKnown }); } });
  expect(results).toEqual([{ inputTokens: 40, outputTokens: 10, usageKnown: true }]);
});

/**
 * GPT-6 Sol review round 1, spec finding: 14632dc's thinking-token fix is a real production
 * spend-accounting behaviour change (it raises `ai_calls.cost_estimate` for every Gemini caller),
 * bundled into a slice the spec calls "no behaviour change" — and it was evaluated only through
 * `onProviderResult`'s token counts (the two tests above), never against what the spend cap
 * itself actually enforces. This closes that gap end to end: a real `ai_calls` insert (`aiCallRow`
 * → `estimateCostUsd`), read back by the SAME `assertUnderSpendCap` production calls go through.
 *
 * A stateful admin (not the static-seed `fakeAdmin` in adapter.test.ts) so the second call's
 * spend read genuinely sums the first call's persisted row, the way two calls from the same user
 * on the same warm instance would.
 */
function statefulAdmin() {
  const calls: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    eq: () => chain, neq: () => chain,
    gte: async () => ({
      data: calls.map((c) => ({ cost_estimate: c.cost_estimate, created_at: new Date().toISOString() })),
      error: null,
    }),
  });
  const settled: number[] = [];
  const admin = withSpendRpc({ from: () => ({
    select: () => chain,
    insert: async (row: Record<string, unknown>) => { calls.push(row); return { error: null }; },
  }) }, settled);
  return { calls, settled, admin: admin as never };
}

it("feeds thinking-token cost into the spend cap the same way it feeds cost_estimate " +
  "(GPT-6 Sol review round 1, spec finding on 14632dc)", async () => {
  vi.stubEnv("GEMINI_API_KEY", "synthetic-test-key");
  sdk.generate.mockResolvedValue({ text: '{"ok":true}', usageMetadata: {
    promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 2000 } });
  const payload = capturePayload("textToItems", { text: "Return ok.", localDate: "2026-09-23" });
  const { calls, settled, admin } = statefulAdmin();

  await generateStructured({ payload, userId: "synthetic-user",
    schema: z.object({ ok: z.boolean() }), admin });

  // The written row must count the thinking tokens as output, not just candidatesTokenCount.
  const expectedCost = (100 / 1_000_000) * 0.75 + (2010 / 1_000_000) * 3.75;
  const buggyCost = (100 / 1_000_000) * 0.75 + (10 / 1_000_000) * 3.75;
  expect(calls).toHaveLength(1);
  expect(calls[0].cost_estimate).toBeCloseTo(expectedCost, 6);
  expect(buggyCost).toBeLessThan(expectedCost / 10);

  // Scale S2: the spend caps count what the call's reservation settles to, and it settles to the
  // same thinking-inclusive cost the row records — the cost the undercount used to skip.
  expect(settled).toHaveLength(1);
  expect(settled[0]).toBeCloseTo(expectedCost, 6);
});
