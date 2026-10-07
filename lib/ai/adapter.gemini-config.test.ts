import { withSpendRpc } from "@/tests/ai/spend-admin";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "./adapter";
import { capturePayload, coachTurnPayload } from "./gemini-payloads";

const sdk = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@google/genai", async (original) => ({
  ...await original<typeof import("@google/genai")>(),
  GoogleGenAI: class { models = { generateContent: sdk.generate }; },
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([
  ["textToItems", "gemini-3.8-flash", "LOW"],
  ["coach", "gemini-3.6-flash", "MINIMAL"],
] as const)("passes the actual %s model into the SDK configuration", async (purpose, model, level) => {
  vi.stubEnv("GEMINI_API_KEY", "synthetic-test-key");
  sdk.generate.mockResolvedValue({ text: '{"ok":true}', usageMetadata: {} });
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, neq: () => chain, gte: () => chain,
    insert: () => chain,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  });
  const payload = purpose === "coach" ? coachTurnPayload(["Return ok."])
    : capturePayload(purpose, { text: "Return ok.", localDate: "2026-09-23" });
  await generateStructured({ payload, userId: "synthetic-user",
    schema: z.object({ ok: z.boolean() }), admin: withSpendRpc({ from: () => chain }) as never });
  expect(sdk.generate).toHaveBeenCalledOnce();
  expect(sdk.generate).toHaveBeenCalledWith(expect.objectContaining({
    model, config: expect.objectContaining({ thinkingConfig: { thinkingLevel: level } }),
  }));
});
