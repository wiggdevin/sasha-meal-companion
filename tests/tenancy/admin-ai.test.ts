/**
 * Spec 3.5 (Phase 9 slice 3), the AI layer: the adapter and the TypeSafe (Jev) wrapper both write
 * `ai_calls` and read spend through the admin client, and the circuit reads recent failures. Each
 * runs for real against the database with the provider stubbed (no network call), while user B
 * holds canary AI rows that put B over the daily spend cap. A's call must succeed, write exactly
 * one row under A, and leave every row of B's unchanged; the same call for B is the control that
 * shows B's rows really are over the cap.
 *
 * The circuit breaker is provider-wide by design (a provider outage is shared by all accounts), so
 * B's failures can open it for A. The case below states that and checks the only thing that may
 * cross: a count. No text of B's failures reaches A.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, type TestUser,
} from "../helpers/supabase";
import { generateStructured } from "@/lib/ai/adapter";
import { assertCircuitClosed } from "@/lib/ai/circuit";
import { generateGrounded } from "@/lib/ai/gemini-grounded";
import { capturePayload, lookupPayload } from "@/lib/ai/gemini-payloads";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { coachOpenRouterPayload } from "@/lib/ai/openrouter-payloads";
import { verifyPayload } from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";
import { accountSnapshot, purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

const CANARY = `canary-${crypto.randomUUID()}`;
const schema = z.object({ answer: z.string() });

async function aiRows(userId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await adminClient().from("ai_calls").select("*").eq("user_id", userId);
  if (error) throw new Error(`read ai_calls: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("the AI layer writes and counts only its caller's calls",
  () => {
    let a: TestUser;
    let b: TestUser;

    beforeAll(async () => {
      assertLocalTargets();
      [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
      await purge([a.id, b.id]);
      const { error } = await adminClient().from("ai_calls").insert({ user_id: b.id,
        purpose: "textToItems", provider: "tenancy", model_id: CANARY, sdk_version: "1",
        status: "ok", cost_estimate: 999, error: CANARY });
      if (error) throw new Error(error.message);
    });

    beforeEach(() => {
      vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "5");
      // B's $999 canary also lands in the global day total (scale S2); lift the ceiling so these
      // cases prove the per-user cap and ledger only.
      vi.stubEnv("AI_GLOBAL_DAILY_SPEND_CAP_USD", "1000000");
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await purge([a.id, b.id]);
    });

    it("adapter: A's call is written under A, and B's spend never blocks it", async () => {
      const provider = async () => ({ text: JSON.stringify({ answer: "ok" }), inputTokens: 1,
        outputTokens: 1 });
      const call = (userId: string) => generateStructured({
        payload: capturePayload("textToItems", { text: "tenancy", localDate: "2026-09-23" }), userId,
        admin: adminClient(), schema },
      { callGemini: provider });

      await expect(call(b.id)).rejects.toMatchObject({ status: 429 });   // control
      const before = accountSnapshot(b.id);
      const aBefore = (await aiRows(a.id)).length;
      await expect(call(a.id)).resolves.toEqual({ answer: "ok" });
      const aAfter = await aiRows(a.id);
      expect(aAfter).toHaveLength(aBefore + 1);
      expect(JSON.stringify(aAfter)).not.toContain(CANARY);
      expect(accountSnapshot(b.id)).toEqual(before);
    });

    it("OpenRouter: A's call is written under A, and B's spend never blocks it", async () => {
      // Owner request 2026-10-02: lib/ai/openrouter.ts is registered here, not a new file — same
      // admin-client parameter shape as the adapter above, same governed callModel path.
      vi.stubEnv("OPENROUTER_ATTESTED", "1");
      // CI has no key in its environment, and the key check runs before the injected transport.
      vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      const provider = async () => ({ text: JSON.stringify({ answer: "ok" }), inputTokens: 1,
        outputTokens: 1, costUsd: 0 });
      const call = (userId: string) => generateOpenRouter({
        payload: coachOpenRouterPayload(["tenancy"]), userId, admin: adminClient(),
        modelId: "test/tenancy-model", schema },
      { send: provider });

      await expect(call(b.id)).rejects.toMatchObject({ status: 429 });   // control
      const before = accountSnapshot(b.id);
      const aBefore = (await aiRows(a.id)).length;
      await expect(call(a.id)).resolves.toEqual({ answer: "ok" });
      const aAfter = await aiRows(a.id);
      expect(aAfter).toHaveLength(aBefore + 1);
      expect(JSON.stringify(aAfter)).not.toContain(CANARY);
      expect(accountSnapshot(b.id)).toEqual(before);
    });

    it("grounded lookup: A's call is written under A, and B's spend never blocks it", async () => {
      const provider = async () => ({ text: "A wheat cracker.",
        groundingMetadata: { webSearchQueries: ["wheat thins"] }, inputTokens: 1, outputTokens: 1 });
      const call = (userId: string) => generateGrounded({
        payload: lookupPayload("Wheat Thins"), userId, admin: adminClient(), timeoutMs: 8_000 },
      { callGeminiGrounded: provider });

      await expect(call(b.id)).rejects.toMatchObject({ status: 429 });   // control
      const before = accountSnapshot(b.id);
      const aBefore = (await aiRows(a.id)).length;
      await expect(call(a.id)).resolves.toMatchObject({ text: "A wheat cracker." });
      const aAfter = await aiRows(a.id);
      expect(aAfter).toHaveLength(aBefore + 1);
      expect(JSON.stringify(aAfter)).not.toContain(CANARY);
      expect(accountSnapshot(b.id)).toEqual(before);
    });

    it("TypeSafe: A's call is written under A, and B's spend never blocks it", async () => {
      vi.stubEnv("TYPESAFE_API_KEY", "tenancy-key");
      const real = globalThis.fetch;
      vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith("https://api.typesafe.ai/")) return real(input, init);
        return new Response(JSON.stringify({ model: "jev", usage: { input_tokens: 1,
          output_tokens: 1 }, answers: { claims_unlisted_action: { type: "noul", noul: 0.9 } } }),
        { status: 200 });
      }) as typeof fetch);
      const ask = (userId: string) => systemOne(verifyPayload({
        reply: `tenancy-${crypto.randomUUID()}`, actions: [], toolNames: [] }), { userId });

      expect(await ask(b.id)).toBeNull();   // control: B is over the cap, so no call is made
      const before = accountSnapshot(b.id);
      const aBefore = (await aiRows(a.id)).length;
      expect(await ask(a.id)).toMatchObject({ claims_unlisted_action: { noul: 0.9 } });
      const aAfter = await aiRows(a.id);
      expect(aAfter).toHaveLength(aBefore + 1);
      expect(JSON.stringify(aAfter)).not.toContain(CANARY);
      expect(accountSnapshot(b.id)).toEqual(before);
    });

    it("circuit: B's failures may open it (provider-wide by design), but no text of B's crosses",
      async () => {
        const provider = `tenancy-${crypto.randomUUID()}`;
        const failures = Array.from({ length: 5 }, () => ({ user_id: b.id,
          purpose: "textToItems", provider, model_id: "m", sdk_version: "1",
          status: "provider_error", error: CANARY }));
        const { error } = await adminClient().from("ai_calls").insert(failures);
        expect(error).toBeNull();
        const outcome = await assertCircuitClosed(adminClient(), provider)
          .then(() => "closed", (e: unknown) => String(e));
        expect(outcome).toContain("circuit open");
        expect(outcome).not.toContain(CANARY);
      });
  });
