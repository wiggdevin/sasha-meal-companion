import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Finding 60: assertPinnedSdk is defined but generateStructured never calls it, so a major
// version drift on the installed @google/genai SDK is recorded (sdk_version on the ai_calls
// row) but never blocked at runtime — only scripts/ai-canary.ts (a manual, off-CI script) and
// this file's own unit tests exercise it. This test mocks the embedded sdk-version.json to a
// drifted major and re-imports the module fresh, so it observes exactly what generateStructured
// itself does with a mismatched installed major — not a copy of the check.

const schema = z.object({ items: z.array(z.object({ name: z.string(), grams: z.number() })) });
const noSleep = async (): Promise<void> => {};

function fakeAdmin(): { client: { from: (t: string) => unknown }; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "ai_calls") calls.push(row);
        return { error: null };
      },
      select: () => {
        const chain = { eq: () => chain, neq: () => chain, gte: async () => ({ data: [], error: null }) };
        return chain;
      },
    }),
  };
  return { client, calls };
}

describe("generateStructured — runtime SDK major pin", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("refuses before any provider call when the installed SDK major drifts from the pin", async () => {
    vi.doMock("@/lib/ai/sdk-version.json", () => ({ default: { version: "3.0.0", major: 3 } }));
    const { generateStructured } = await import("./adapter");
    const { capturePayload } = await import("./gemini-payloads");
    const { client, calls } = fakeAdmin();
    const callGemini = vi.fn(async () => ({
      text: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1,
    }));

    await expect(
      generateStructured(
        { payload: capturePayload("textToItems", { text: "eggs", localDate: "2026-09-23" }),
          userId: "u1", schema,
          admin: client as never },
        { sleep: noSleep, callGemini }
      )
    ).rejects.toThrow("@google/genai major 3 is installed; Phase 0 pins major 2");

    expect(callGemini).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    vi.doUnmock("@/lib/ai/sdk-version.json");
  });
});
