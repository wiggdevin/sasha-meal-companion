import { describe, expect, it } from "vitest";
import {
  assertPinnedSdk, GEMINI_COACH, GEMINI_FLASH, installedGenai, MODELS, PINNED_GENAI_MAJOR,
} from "./adapter";
import { LANES } from "./lanes";

describe("MODELS", () => {
  it("pins every purpose to a literal id with no 'latest' alias", () => {
    expect(MODELS).toEqual({
      voiceToItems: GEMINI_FLASH,
      photoToItems: GEMINI_FLASH,
      labelToNutrients: GEMINI_FLASH,
      textToItems: GEMINI_FLASH,
      coach: GEMINI_COACH,
      weeklyReview: GEMINI_COACH,
      "coach-transcribe": GEMINI_FLASH,
      lookup: GEMINI_FLASH,
      // The Plan sheet's Gemini twins, used only after an OpenRouter provider failure (C5).
      "photoToIdeas-gemini": LANES.plan.fallback,
      "documentToPlan-gemini": LANES.plan.fallback,
      "onboarding-extract": GEMINI_FLASH,
    });
    for (const id of Object.values(MODELS)) {
      expect(id).not.toMatch(/latest/);
      expect(id).not.toMatch(/^\$\{|process\.env/);
    }
  });
});

describe("assertPinnedSdk", () => {
  it("passes when the installed major matches the pin", () => {
    expect(() =>
      assertPinnedSdk(() => ({ version: `${PINNED_GENAI_MAJOR}.9.9`, major: PINNED_GENAI_MAJOR }))
    ).not.toThrow();
  });

  it("throws and names both versions when the major drifts", () => {
    expect(() => assertPinnedSdk(() => ({ version: "3.0.0", major: 3 }))).toThrow(
      "@google/genai major 3 is installed; Phase 0 pins major 2"
    );
  });

  it("returns the build-verified version embedded for runtime calls", () => {
    const installed = installedGenai();
    expect(installed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(installed.major).toBe(PINNED_GENAI_MAJOR);
  });
});

import { beforeEach, vi } from "vitest";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { generateStructured, inputHashFor, ProviderHttpError } from "./adapter";
import { generateGrounded } from "./gemini-grounded";
import { capturePayload, coachTurnPayload, lookupPayload } from "./gemini-payloads";
import { estimateCostUsd } from "./models";
import { withSpendRpc } from "@/tests/ai/spend-admin";
import type { Media } from "./payloads";

/** A builder-made payload (Phase 13 §9 R3): the adapter accepts nothing else. */
function P(purpose: "textToItems" | "photoToItems" | "coach", parts: { text: string }[], media?: Media) {
  if (purpose === "coach") return coachTurnPayload(parts.map((part) => part.text));
  const text = parts.map((part) => part.text).join("\n");
  return capturePayload(purpose, { ...(text ? { text } : {}), localDate: "2026-09-23" }, media);
}

type AiCall = Record<string, unknown>;

/**
 * `spend` seeds pre-existing ai_calls rows the spend-cap read sums for today. The circuit
 * breaker's own read (`select("created_at").eq("provider", …).in("status", [provider failures]).gte(…)`) is
 * answered from `calls` instead — the rows this fake DB has actually recorded — so a test that
 * drives several failed generateStructured() calls through one fakeAdmin() sees the same durable
 * history a real serverless instance would read back after a cold start.
 */
function fakeAdmin(spend: number[] = []): {
  client: { from: (t: string) => unknown }; calls: AiCall[];
} {
  const calls: AiCall[] = [];
  const client = withSpendRpc({
    from: (table: string) => ({
      insert: async (row: AiCall) => {
        if (table === "ai_calls") calls.push(row);
        return { error: null };
      },
      select: (cols: string) => {
        if (cols === "cost_estimate") {
          const chain = {
            eq: () => chain,
            gte: async () => ({ data: spend.map((cost_estimate) => ({ cost_estimate })), error: null }),
          };
          return chain;
        }
        const filters: { provider?: string; statusNeq?: string; statusIn?: string[] } = {};
        const chain = {
          eq: (col: string, val: string) => {
            if (col === "provider") filters.provider = val;
            return chain;
          },
          neq: (col: string, val: string) => {
            if (col === "status") filters.statusNeq = val;
            return chain;
          },
          in: (col: string, vals: string[]) => {
            if (col === "status") filters.statusIn = vals;
            return chain;
          },
          gte: async () => ({
            data: calls
              .filter((c) =>
                (filters.provider === undefined || c.provider === filters.provider) &&
                (filters.statusNeq === undefined || c.status !== filters.statusNeq) &&
                (filters.statusIn === undefined || filters.statusIn.includes(c.status as string)))
              .map(() => ({ created_at: new Date().toISOString() })),
            error: null,
          }),
        };
        return chain;
      },
    }),
  }, spend);
  return { client, calls };
}

const schema = z.object({ items: z.array(z.object({ name: z.string(), grams: z.number() })) });
const noSleep = async (): Promise<void> => {};
/** Every provider dep now returns token counts alongside the raw text. */
const okResult = (body: unknown, inputTokens = 5, outputTokens = 8) =>
  async () => ({ text: JSON.stringify(body), inputTokens, outputTokens });

describe("generateStructured", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("validates the model's JSON and writes one ok ai_calls row", async () => {
    const { client, calls } = fakeAdmin();
    const out = await generateStructured(
      { payload: P("textToItems", [{ text: "two eggs" }]), userId: "u1", schema,
        admin: client as never },
      { sleep: noSleep, callGemini: okResult({ items: [{ name: "Egg", grams: 100 }] }, 12, 20) }
    );
    expect(out).toEqual({ items: [{ name: "Egg", grams: 100 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      user_id: "u1", purpose: "textToItems", provider: "google",
      model_id: "gemini-3.8-flash", status: "ok", input_tokens: 12, output_tokens: 20,
    });
    expect(calls[0].sdk_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof calls[0].latency_ms).toBe("number");
  });

  it("retries twice, then succeeds, and writes one row for the successful call", async () => {
    const { client, calls } = fakeAdmin();
    const callGemini = vi.fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce({ text: JSON.stringify({ items: [] }), inputTokens: 3, outputTokens: 1 });
    const out = await generateStructured(
      { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
      { sleep: noSleep, callGemini }
    );
    expect(out).toEqual({ items: [] });
    expect(callGemini).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => c.status)).toEqual(["ok"]);
  });

  it("writes an error ai_calls row when every attempt fails", async () => {
    const { client, calls } = fakeAdmin();
    await expect(
      generateStructured(
        { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
        { sleep: noSleep, callGemini: async () => { throw new Error("boom"); } }
      )
    ).rejects.toThrow("boom");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "error", error: "boom", input_tokens: 0, output_tokens: 0, cost_estimate: 0,
    });
  });

  it("rejects output the schema does not accept", async () => {
    const { client, calls } = fakeAdmin();
    await expect(
      generateStructured(
        { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
        { sleep: noSleep, callGemini: okResult({ items: [{ name: 1 }] }) }
      )
    ).rejects.toThrow(/schema/i);
    expect(calls[0].status).toBe("schema_invalid");
  });

  it("records a reply cut off mid-JSON as a schema failure, not a generic error", async () => {
    // Production 2026-09-15: "Unterminated string in JSON at position 1317" was logged as `error`,
    // indistinguishable from a network fault. A truncated reply is the wrong shape, not a failed call.
    const { client, calls } = fakeAdmin();
    const cutOff = async () => ({ text: '{"items":[{"name":"Egg", "gra', inputTokens: 10, outputTokens: 1200 });
    await expect(
      generateStructured(
        { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
        { sleep: noSleep, callGemini: cutOff }
      )
    ).rejects.toThrow(/not valid JSON/i);
    expect(calls[0].status).toBe("schema_invalid");
  });

  it("charges the spend ledger for every billed attempt the schema rejected", async () => {
    const { client, calls } = fakeAdmin();
    await expect(
      generateStructured(
        { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
        { sleep: noSleep, callGemini: okResult({ items: [{ name: 1 }] }, 500, 800) }
      )
    ).rejects.toThrow(/schema/i);
    expect(calls).toHaveLength(1);
    // Three attempts, each answered and billed, each rejected by the schema.
    expect(calls[0]).toMatchObject({ status: "schema_invalid", input_tokens: 1500, output_tokens: 2400 });
    expect(calls[0].cost_estimate).toBeCloseTo(3 * estimateCostUsd(calls[0].model_id as string, 500, 800), 10);
  });

  it("adds a rejected attempt's tokens to the row of the attempt that then succeeds", async () => {
    const { client, calls } = fakeAdmin();
    let n = 0;
    const callGemini = async () => (n++ === 0
      ? { text: JSON.stringify({ items: [{ name: 1 }] }), inputTokens: 100, outputTokens: 10 }
      : { text: JSON.stringify({ items: [{ name: "egg", grams: 50 }] }), inputTokens: 100, outputTokens: 20 });
    await generateStructured(
      { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
      { sleep: noSleep, callGemini },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "ok", input_tokens: 200, output_tokens: 30 });
  });

  it("opens the circuit after five failures in ten minutes", async () => {
    const { client } = fakeAdmin();
    const boom = {
      sleep: noSleep,
      callGemini: async (): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
        throw new Error("x");
      },
    };
    const args = { payload: P("textToItems", []), userId: "u1", schema,
      admin: client as never };
    for (let i = 0; i < 5; i++) await expect(generateStructured(args, boom)).rejects.toThrow("x");
    await expect(generateStructured(args, boom)).rejects.toThrow(
      "circuit open for google gemini-3.8-flash: 5 failures in the last 10 minutes"
    );
  });

  it("refuses before it calls a provider once today's spend reaches a custom cap", async () => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "0.50");
    const { client, calls } = fakeAdmin([0.4, 0.12]);
    const callGemini = vi.fn();
    await expect(
      generateStructured(
        { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
        { sleep: noSleep, callGemini }
      )
    ).rejects.toMatchObject({ status: 429, code: "spend_cap" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  // Finding 94, now across instances (scale S2): each call reserves its maximum estimated cost
  // in one database transaction before any provider I/O, so two concurrent calls from the same
  // user cannot both clear a cap their combined holds would break. The fake answers the
  // reservation RPCs with the SQL's rule (tests/ai/spend-admin.ts).
  it("does not let two concurrent calls from the same user both clear a cap their combined cost would break", async () => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "2");
    const oneCall = (admin: unknown) => generateStructured(
      { payload: P("textToItems", [{ text: "two eggs" }]), userId: "u1", schema, admin: admin as never },
      { sleep: noSleep, callGemini: okResult({ items: [] }, 100_000, 50_000) }
    );
    // Learn this call's hold, then leave room for one and a half of them: one fits, two do not.
    const probe = fakeAdmin().client as unknown as { rpc: (fn: string, args: Record<string, unknown>) => unknown };
    const rpc = vi.spyOn(probe, "rpc");
    await oneCall(probe);
    const hold = Number((rpc.mock.calls.find(([fn]) => fn === "ai_spend_reserve")?.[1] ?? {}).p_amount_usd);
    expect(hold).toBeGreaterThan(0);
    const { client, calls } = fakeAdmin([2 - 1.5 * hold]);

    const results = await Promise.allSettled([oneCall(client), oneCall(client)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 429, code: "spend_cap" });
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe("ok");
  });

  it("refuses at the default $2 cap with no env override, from a mocked admin returning a sum of 2.0", async () => {
    const { client, calls } = fakeAdmin([2.0]);
    const callGemini = vi.fn();
    const rejection = await generateStructured(
      { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
      { sleep: noSleep, callGemini }
    ).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(HttpError);
    expect(rejection).toMatchObject({ status: 429, code: "spend_cap" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("writes a cost_estimate computed from token counts that the next call's cap check can add up", async () => {
    const { client, calls } = fakeAdmin();
    await generateStructured(
      { payload: P("textToItems", [{ text: "two eggs" }]), userId: "u1", schema,
        admin: client as never },
      { sleep: noSleep, callGemini: okResult({ items: [] }, 100_000, 50_000) }
    );
    // gemini-3.8-flash standard paid tier: $0.75/$3.75 per 1M tokens (input/output).
    expect(calls[0].cost_estimate).toBeCloseTo(100_000 / 1_000_000 * 0.75 + 50_000 / 1_000_000 * 3.75, 6);
  });

  // A coach purpose with no route override is only the default table's answer; the coach turn
  // always passes its model in (it may fall back once, T6 §5).
  it("honours a caller's route override over the per-purpose table", async () => {
    const { client, calls } = fakeAdmin();
    const callGemini = vi.fn(okResult({ items: [] }, 30, 15));
    await generateStructured(
      { payload: P("coach", [{ text: "how did the week go?" }]), userId: "u1", schema,
        admin: client as never, route: { provider: "google", modelId: "gemini-3.8-flash" } },
      { sleep: noSleep, callGemini }
    );
    expect(callGemini).toHaveBeenCalled();
    expect(calls[0]).toMatchObject({
      provider: "google", model_id: "gemini-3.8-flash", input_tokens: 30, output_tokens: 15,
    });
  });

  it("logs, but does not throw or hide, an ai_calls insert failure on an otherwise-successful call", async () => {
    const { client: baseClient } = fakeAdmin();
    const client = withSpendRpc({
      from: (table: string) => {
        const base = baseClient.from(table) as { insert: unknown; select?: unknown };
        return { ...base, insert: async () => ({ error: { message: "db unreachable" } }) };
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await generateStructured(
      { payload: P("textToItems", [{ text: "two eggs" }]), userId: "u1", schema,
        admin: client as never },
      { sleep: noSleep, callGemini: okResult({ items: [{ name: "Egg", grams: 100 }] }) }
    );
    expect(out).toEqual({ items: [{ name: "Egg", grams: 100 }] });
    expect(errorSpy).toHaveBeenCalledWith(
      "ai_calls insert failed",
      expect.objectContaining({ user_id: "u1", error: { message: "db unreachable" } })
    );
    errorSpy.mockRestore();
  });
});

describe("generateStructured with media", () => {
  beforeEach(() => { vi.unstubAllEnvs(); });

  it("sends bytes under 4 MB inline and uploads nothing", async () => {
    const { client } = fakeAdmin();
    const uploadMedia = vi.fn();
    let seen: unknown[] = [];
    await generateStructured(
      { payload: P("photoToItems", [{ text: "plate" }],
        { bytes: new Uint8Array(16), mimeType: "image/jpeg" }), userId: "u1", schema,
        admin: client as never },
      { sleep: noSleep, uploadMedia,
        callGemini: async (_m, parts) => {
          seen = parts;
          return { text: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1 };
        } }
    );
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({ inlineData: { mimeType: "image/jpeg", data: expect.any(String) } });
  });

  it("uploads bytes at or over 4 MB and deletes the provider file even when the call fails", async () => {
    const { client } = fakeAdmin();
    const uploadMedia = vi.fn().mockResolvedValue({ uri: "files/abc", name: "files/abc" });
    const deleteMedia = vi.fn().mockResolvedValue(undefined);
    await expect(generateStructured(
      { payload: P("photoToItems", [],
        { bytes: new Uint8Array(4 * 1024 * 1024), mimeType: "image/jpeg" }), userId: "u1", schema,
        admin: client as never },
      { sleep: noSleep, uploadMedia, deleteMedia,
        callGemini: async () => { throw new Error("boom"); } }
    )).rejects.toThrow("boom");
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(deleteMedia).toHaveBeenCalledWith("files/abc");
  });

  it("hashes the media bytes, not the upload uri, so two uploads of one file collide", () => {
    const media = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
    expect(inputHashFor([{ text: "a" }], media)).toBe(inputHashFor([{ text: "a" }], media));
    expect(inputHashFor([{ text: "a" }], media)).not.toBe(inputHashFor([{ text: "a" }]));
  });

  it("writes timeout for an AbortError and provider_error for a provider status", async () => {
    const { client, calls } = fakeAdmin();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(generateStructured(
      { payload: P("textToItems", []), userId: "u1", schema, admin: client as never },
      { sleep: noSleep, callGemini: async () => { throw abort; } }
    )).rejects.toThrow("aborted");
    expect(calls[0].status).toBe("timeout");

    const second = fakeAdmin();
    await expect(generateStructured(
      { payload: P("textToItems", []), userId: "u1", schema, admin: second.client as never },
      { sleep: noSleep, callGemini: async () => { throw new ProviderHttpError(503, "gemini 503"); } }
    )).rejects.toThrow("gemini 503");
    expect(second.calls[0].status).toBe("provider_error");
  });
});

/**
 * 2026-09-14. Devin: the coach "takes way too long". Measured against the running app, one
 * question took 44 s and the ai_calls table held two rows at 60,027 ms and 61,263 ms.
 *
 * `timeoutMs` bounded each ATTEMPT, and RETRIES = 2 means three of them, so one logical call could
 * spend 3 x 20 s plus backoff — 61 s — inside a turn budget of 75 s. The caller's comment says
 * "never let one attempt eat the whole turn"; the intent was always that the number it passes is
 * what the call costs, not what each attempt costs.
 */
describe("the per-call deadline covers the retries, not each attempt", () => {
  const hang = () => new Promise<never>(() => {});

  it("gives up inside the budget instead of spending it once per attempt", async () => {
    const { client } = fakeAdmin();
    const started = Date.now();
    await expect(
      generateStructured(
        { payload: P("textToItems", [{ text: "x" }]), userId: "u1", schema,
          admin: client as never, timeoutMs: 150 },
        { sleep: noSleep, callGemini: hang }
      )
    ).rejects.toThrow();
    // Three attempts at 150 ms each would be 450 ms. The budget is 150 ms for the whole call.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("still retries a fast failure — the budget bounds time, it does not ban retrying", async () => {
    const { client } = fakeAdmin();
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("boom");
      return { text: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1 };
    };
    const out = await generateStructured(
      { payload: P("textToItems", [{ text: "x" }]), userId: "u1", schema,
        admin: client as never, timeoutMs: 5_000 },
      { sleep: noSleep, callGemini: flaky }
    );
    expect(out).toEqual({ items: [] });
    expect(attempts).toBe(3);
  });

  it("records the failure once the budget is spent", async () => {
    const { client, calls } = fakeAdmin();
    await expect(
      generateStructured(
        { payload: P("textToItems", [{ text: "x" }]), userId: "u1", schema,
          admin: client as never, timeoutMs: 120 },
        { sleep: noSleep, callGemini: hang }
      )
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe("timeout");
  });
});

/**
 * 2026-09-14, measured on the live provider with thinking at MINIMAL. The latencies are bimodal:
 *
 *   ok 1179 ms | ok 1428 ms | ok 1469 ms | ok 2932 ms | timeout 20006 ms | timeout 20006 ms
 *
 * A healthy call answers in one to three seconds. A bad one does not answer at all — it hangs
 * until something cuts it. So the answer to a stall is to try again promptly, not to keep waiting:
 * an attempt is bounded by ATTEMPT_TIMEOUT_MS, and the retries all have to fit the call's budget.
 */
describe("a stalled attempt is cut short so the retry still fits", () => {
  const hang = () => new Promise<never>(() => {});

  it("retries a hang rather than spending the whole budget on one attempt", async () => {
    const { client } = fakeAdmin();
    let attempts = 0;
    const stallThenAnswer = async (..._args: unknown[]) => {
      attempts += 1;
      if (attempts === 1) return hang();
      return { text: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1 };
    };
    const out = await generateStructured(
      { payload: P("textToItems", [{ text: "x" }]), userId: "u1", schema,
        admin: client as never, timeoutMs: 5_000, attemptTimeoutMs: 120 },
      { sleep: noSleep, callGemini: stallThenAnswer as never }
    );
    expect(out).toEqual({ items: [] });
    expect(attempts).toBe(2);
  });

  it("still stops at the call budget when every attempt hangs", async () => {
    const { client } = fakeAdmin();
    const started = Date.now();
    await expect(
      generateStructured(
        { payload: P("textToItems", [{ text: "x" }]), userId: "u1", schema,
          admin: client as never, timeoutMs: 300, attemptTimeoutMs: 120 },
        { sleep: noSleep, callGemini: hang }
      )
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(600);
  });
});

/**
 * Phase 13 §3.3, §9 R8 (slice 6): the `lookup` lane's own transport. One call, no retry loop —
 * a stalled search is worth a clean refusal inside the lane's own budget, not a second attempt.
 */
describe("generateGrounded", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  const groundedResult = (
    text: string, webSearchQueries: readonly string[] = [], inputTokens = 10, outputTokens = 20,
  ) => async () => ({
    text, groundingMetadata: { webSearchQueries: [...webSearchQueries] }, inputTokens, outputTokens,
  });

  it("prices a grounded call at tokens plus webSearchQueries.length x $0.014 (§8 item 3)", async () => {
    const { client, calls } = fakeAdmin();
    const out = await generateGrounded(
      { payload: lookupPayload("Wheat Thins"), userId: "u1", admin: client as never, timeoutMs: 8_000 },
      { callGeminiGrounded: groundedResult("A wheat cracker.", ["wheat thins allergens"], 12, 30) }
    );
    expect(out.text).toBe("A wheat cracker.");
    expect(out.webSearchQueries).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      user_id: "u1", purpose: "lookup", provider: "google", model_id: GEMINI_FLASH, status: "ok",
      input_tokens: 12, output_tokens: 30,
    });
    expect(calls[0].cost_estimate).toBeCloseTo(estimateCostUsd(GEMINI_FLASH, 12, 30) + 0.014, 10);
  });

  it("spends zero grounding cost when the call runs no search", async () => {
    const { client, calls } = fakeAdmin();
    await generateGrounded(
      { payload: lookupPayload("Wheat Thins"), userId: "u1", admin: client as never, timeoutMs: 8_000 },
      { callGeminiGrounded: groundedResult("A wheat cracker.", []) }
    );
    expect(calls[0].cost_estimate).toBeCloseTo(estimateCostUsd(GEMINI_FLASH, 10, 20), 10);
  });

  it("bounds a stalled grounded call to its own budget instead of hanging", async () => {
    const { client } = fakeAdmin();
    const hang = () => new Promise<never>(() => {});
    const started = Date.now();
    await expect(
      generateGrounded(
        { payload: lookupPayload("Wheat Thins"), userId: "u1", admin: client as never, timeoutMs: 150 },
        { callGeminiGrounded: hang }
      )
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("writes a zero-cost timeout row when the grounded call never answers", async () => {
    const { client, calls } = fakeAdmin();
    const hang = () => new Promise<never>(() => {});
    await expect(
      generateGrounded(
        { payload: lookupPayload("Wheat Thins"), userId: "u1", admin: client as never, timeoutMs: 120 },
        { callGeminiGrounded: hang }
      )
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "timeout", cost_estimate: 0 });
  });

  it("stops at the turn's own abort, well inside its 8 s budget, and still writes its row (review r1, sol BLOCK)", async () => {
    const { client, calls } = fakeAdmin();
    const turn = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const hang = (_m: string, _p: unknown, signal?: AbortSignal) => {
      providerSignal = signal;
      return new Promise<never>(() => {});
    };
    setTimeout(() => turn.abort(), 30);
    const started = Date.now();
    await expect(generateGrounded(
      { payload: lookupPayload("Wheat Thins"), userId: "u1", admin: client as never,
        timeoutMs: 8_000, signal: turn.signal },
      { callGeminiGrounded: hang },
    )).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(400);
    expect(providerSignal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "timeout", cost_estimate: 0 });
  });

  it("never starts the provider call once the turn has already stopped waiting", async () => {
    const { client, calls } = fakeAdmin();
    const turn = new AbortController();
    turn.abort();
    const callGeminiGrounded = vi.fn();
    await expect(generateGrounded(
      { payload: lookupPayload("Wheat Thins"), userId: "u1", admin: client as never,
        timeoutMs: 8_000, signal: turn.signal },
      { callGeminiGrounded },
    )).rejects.toThrow();
    expect(callGeminiGrounded).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses before it calls the provider once today's spend cap is reached", async () => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "0.50");
    const { client, calls } = fakeAdmin([0.4, 0.12]);
    const callGeminiGrounded = vi.fn();
    await expect(
      generateGrounded(
        { payload: lookupPayload("Wheat Thins"), userId: "u1", admin: client as never, timeoutMs: 8_000 },
        { callGeminiGrounded }
      )
    ).rejects.toMatchObject({ status: 429, code: "spend_cap" });
    expect(callGeminiGrounded).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
