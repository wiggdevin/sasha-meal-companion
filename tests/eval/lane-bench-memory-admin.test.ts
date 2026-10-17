/**
 * The lane bench hands generateStructured an in-memory admin double. generateStructured reserves
 * spend through `admin.rpc("ai_spend_reserve_split")` and fails closed when that is missing, which
 * made every bench call error out before reaching a provider (W147, 2026-10-17). This runs one call
 * through the real boundary with a stubbed provider and proves the double answers the spend RPCs.
 */
import "../helpers/attested-env";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateStructured, type GenerateDeps } from "@/lib/ai/adapter";
import { coachTurnPayload } from "@/lib/ai/gemini-payloads";
import { memoryAdmin } from "@/scripts/eval/lane-bench/memory-admin";

describe("lane-bench memoryAdmin", () => {
  it("lets a call pass the spend reservation and record its ledger row", async () => {
    const rows: Record<string, unknown>[] = [];
    const callGemini = async () => ({ text: '{"value":"2"}', inputTokens: 10, outputTokens: 3 });
    const out = await generateStructured({
      payload: coachTurnPayload(["VALUES: {}"]), userId: "00000000-0000-4000-8000-00000000be0c",
      admin: memoryAdmin(rows), schema: z.object({ value: z.string() }),
      route: { provider: "google", modelId: "gemini-3.6-flash" }, maxOutputTokens: 64,
    }, { callGemini } as unknown as GenerateDeps);
    expect(out).toEqual({ value: "2" });
    expect(rows.length).toBeGreaterThan(0);
  });
});
