import { withSpendRpc } from "@/tests/ai/spend-admin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inputHashFor, ProviderHttpError, SchemaRejection } from "@/lib/ai/adapter";
import { captureOpenRouterReady, geminiPrimaryBudgetMs, runCapture, worthGemini } from "@/lib/ai/capture";
import { CALL_REGISTRY } from "@/lib/ai/call-registry";
import { capturePayload } from "@/lib/ai/gemini-payloads";
import { captureOpenRouterModel } from "@/lib/ai/models";
import { UnusableReply } from "@/lib/ai/call";
import { generateOpenRouter, type OpenRouterArgs } from "@/lib/ai/openrouter";
import { labelNutrientsSchema } from "@/lib/ai/schemas";
import {
  captureOpenRouterPayload, openRouterCapturePurpose,
} from "@/lib/ai/openrouter-payloads";
import { PROMPTS } from "@/lib/ai/prompts";
import { NUTRIENT_CODES } from "@/lib/nutrients/codes";
import { HttpError } from "@/lib/server/auth";
import { proposeDraft } from "@/lib/server/capture";

vi.mock("@/lib/ai/lanes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/lanes")>();
  return { ...actual, OPENROUTER_PINS: { ...actual.OPENROUTER_PINS,
    capture: "test/capture-pin" } };
});

/**
 * Owner request 2026-10-02: text, photo and label capture ask OpenRouter first, and the pinned
 * Gemini pair stays the fallback for a provider failure. Voice stays on Gemini (audio).
 */

const INPUT = { text: "two eggs", slot: "meal-1", localDate: "2026-09-11" };
const IMAGE = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" };
const ITEMS = { items: [{ label: "eggs", grams: 100, qty: 2, unit: "whole", confidence: 0.9 }], notes: [] };

function attestOpenRouter(): void {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_ATTESTED", "1");
}

/** The Gemini transport double: records the model it was asked for. */
function gemini(reply: unknown = { items: [], notes: [] }) {
  return vi.fn(async (_model: string) => ({ text: JSON.stringify(reply), inputTokens: 1, outputTokens: 1 }));
}

function admin() {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, neq: () => chain, in: () => chain,
    gte: async () => ({ data: [], error: null }),
    insert: async () => ({ error: null }),
  });
  return withSpendRpc({ from: () => chain }) as never;
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("capture OpenRouter purposes", () => {
  it("registers each twin with its Gemini purpose's data class, voice included", () => {
    expect(CALL_REGISTRY["textToItems-openrouter"]).toEqual(
      { provider: "openrouter", dataClass: CALL_REGISTRY.textToItems.dataClass, builder: "captureOpenRouterPayload" });
    expect(CALL_REGISTRY["photoToItems-openrouter"].dataClass).toBe(CALL_REGISTRY.photoToItems.dataClass);
    expect(CALL_REGISTRY["labelToNutrients-openrouter"].dataClass)
      .toBe(CALL_REGISTRY.labelToNutrients.dataClass);
    // 2026-10-06 (Gemini project denial): voice now has a twin too, used only as a FALLBACK
    // (ctx.openRouterFallback, lib/ai/capture.ts) — Gemini stays primary for voice, unlike the
    // other three purposes above, which ask OpenRouter first.
    expect(CALL_REGISTRY["voiceToItems-openrouter"].dataClass).toBe(CALL_REGISTRY.voiceToItems.dataClass);
    expect(openRouterCapturePurpose("voiceToItems")).toBe("voiceToItems-openrouter");
    expect(openRouterCapturePurpose("textToItems")).toBe("textToItems-openrouter");
  });

  it("reads the capture model from the lane table", () => {
    expect(captureOpenRouterModel()).toBe("test/capture-pin");
  });

  it("is ready only with both the key and the OpenRouter attestation", () => {
    expect(captureOpenRouterReady()).toBe(false);
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    expect(captureOpenRouterReady()).toBe(false);
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    expect(captureOpenRouterReady()).toBe(true);
  });
});

describe("captureOpenRouterPayload", () => {
  it("sends the twin's system prompt and data envelope, and no image for text", () => {
    attestOpenRouter();
    const payload = captureOpenRouterPayload("textToItems-openrouter", INPUT);
    expect(payload.purpose).toBe("textToItems-openrouter");
    expect(payload.text.startsWith(PROMPTS.textToItems.system)).toBe(true);
    expect(payload.text).toContain(JSON.stringify({ data: { text: "two eggs" }, slot: "meal-1", localDate: "2026-09-11" }));
    expect(payload.imageDataUrl).toBeUndefined();
  });

  it("sends a photo as an image data URL and never a caller's text", () => {
    attestOpenRouter();
    const payload = captureOpenRouterPayload("labelToNutrients-openrouter",
      { ...INPUT } as never, IMAGE);
    expect(payload.imageDataUrl).toBe("data:image/png;base64,iVBORw==");
    expect(payload.text).not.toContain("two eggs");
    expect(payload.text.startsWith(PROMPTS.labelToNutrients.system)).toBe(true);
  });

  it("refuses the wrong media shape and an unattested OpenRouter", () => {
    attestOpenRouter();
    expect(() => captureOpenRouterPayload("textToItems-openrouter", INPUT, IMAGE as never)).toThrow(/takes no media/);
    expect(() => captureOpenRouterPayload("photoToItems-openrouter", INPUT, undefined as never)).toThrow(/requires media/);
    expect(() => captureOpenRouterPayload("photoToItems-openrouter", INPUT,
      { bytes: new Uint8Array([1]), mimeType: "audio/webm" })).toThrow(/JPEG or PNG/);
    vi.stubEnv("OPENROUTER_ATTESTED", "");
    expect(() => captureOpenRouterPayload("textToItems-openrouter", INPUT)).toThrow();
  });
});

describe("runCapture with OpenRouter first", () => {
  it("answers from OpenRouter and never calls Gemini", async () => {
    attestOpenRouter();
    const callGemini = gemini();
    const generateOpenRouter = vi.fn(async (_args: OpenRouterArgs<unknown>) => ITEMS);
    const out = await runCapture(capturePayload("textToItems", INPUT), {
      userId: "u1", admin: admin(), inputHash: "\\xabc",
      openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT),
    }, { callGemini, generateOpenRouter: generateOpenRouter as never });
    expect(out).toEqual(ITEMS);
    expect(callGemini).not.toHaveBeenCalled();
    const args = generateOpenRouter.mock.calls[0][0];
    expect(args).toMatchObject({
      modelId: "test/capture-pin", inputHash: "\\xabc", abandonOnCapacity: true,
      maxOutputTokens: PROMPTS.textToItems.maxOutputTokens,
    });
    expect(args.timeoutMs).toBeLessThanOrEqual(8_000);
  });

  it("falls back to the Gemini pin when OpenRouter fails with a provider error", async () => {
    attestOpenRouter();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const callGemini = gemini(ITEMS);
    for (const failure of [new ProviderHttpError(503, "openrouter 503"),
      new ProviderHttpError(401, "openrouter 401"),
      Object.assign(new Error("the provider did not answer within 8000ms"), { name: "AbortError" })]) {
      callGemini.mockClear();
      const out = await runCapture(capturePayload("textToItems", INPUT), {
        userId: "u1", admin: admin(), inputHash: "\\xabc", openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT),
      }, { sleep: async () => {}, callGemini, generateOpenRouter: (async () => { throw failure; }) as never });
      expect(out).toEqual(ITEMS);
      expect(callGemini.mock.calls[0][0]).toBe("gemini-3.8-flash");
    }
  });

  it("does not fall back on a schema refusal or the spend cap", async () => {
    attestOpenRouter();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const callGemini = gemini(ITEMS);
    const ctx = () => ({ userId: "u1", admin: admin(), inputHash: "\\xabc",
      openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT) });
    await expect(runCapture(capturePayload("textToItems", INPUT), ctx(), {
      callGemini, generateOpenRouter: (async () => { throw new SchemaRejection("bad shape"); }) as never,
    })).rejects.toMatchObject({ status: 422, code: "schema_invalid" });
    await expect(runCapture(capturePayload("textToItems", INPUT), ctx(), {
      callGemini, generateOpenRouter: (async () => { throw new HttpError(429, "spend_cap", "cap"); }) as never,
    })).rejects.toMatchObject({ status: 429, code: "spend_cap" });
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("refuses an OpenRouter payload minted for another purpose", async () => {
    attestOpenRouter();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const generateOpenRouter = vi.fn();
    const callGemini = gemini();
    await expect(runCapture(capturePayload("photoToItems", INPUT, IMAGE), {
      userId: "u1", admin: admin(), inputHash: "\\xabc", openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT),
    }, { callGemini, generateOpenRouter: generateOpenRouter as never }))
      .rejects.toMatchObject({ status: 500, code: "internal" });
    expect(generateOpenRouter).not.toHaveBeenCalled();
    expect(callGemini).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("capture refused a mismatched OpenRouter payload",
      { purpose: "photoToItems", openRouterPurpose: "textToItems-openrouter" });
  });

  it("falls back to Gemini only for provider, capacity and timeout failures", async () => {
    const timeout = Object.assign(new Error("the provider did not answer within 8000ms"), { name: "AbortError" });
    expect(worthGemini(new ProviderHttpError(400, "openrouter 400"))).toBe(true);
    expect(worthGemini(timeout)).toBe(true);
    expect(worthGemini(new Error("circuit open for google/gemini-2.5-flash"))).toBe(true);
    expect(worthGemini(new TypeError("fetch failed"))).toBe(true);
    expect(worthGemini(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(worthGemini(new Error("refused: purpose 'x' is not in the call registry"))).toBe(false);
    expect(worthGemini(new Error("something else broke"))).toBe(false);
    expect(worthGemini(new SchemaRejection("bad"))).toBe(false);
    expect(worthGemini(new HttpError(429, "spend_cap", "cap"))).toBe(false);

    attestOpenRouter();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const callGemini = gemini(ITEMS);
    await expect(runCapture(capturePayload("textToItems", INPUT), {
      userId: "u1", admin: admin(), inputHash: "\\xabc", openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT),
    }, { callGemini, generateOpenRouter: (async () => { throw new TypeError("x is not a function"); }) as never }))
      .rejects.toMatchObject({ status: 503 });
    expect(callGemini).not.toHaveBeenCalled();
  });
});

describe("the capture budget after OpenRouter", () => {
  it("keeps room for the same-key fallback when sizing the Gemini primary", () => {
    expect(geminiPrimaryBudgetMs(20_000)).toBe(9_000);
    expect(geminiPrimaryBudgetMs(12_000)).toBe(6_500);
    expect(geminiPrimaryBudgetMs(8_000)).toBeNull();
  });

  it("OpenRouter times out at 8 s, the Gemini primary times out, and the fallback still runs", async () => {
    attestOpenRouter();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Fake timers drive both the deadlines (withDeadline's setTimeout) and Date.now, so each
    // attempt really spends the budget it was handed.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const start = Date.now();
      const seen: { model: string; at: number }[] = [];
      const callGemini = vi.fn((model: string, _p: unknown, _s: unknown, _m?: number, signal?: AbortSignal) => {
        seen.push({ model, at: Date.now() - start });
        if (model === "gemini-3.8-flash") {
          return new Promise<never>((_, reject) => signal?.addEventListener("abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
        }
        return Promise.resolve({ text: JSON.stringify(ITEMS), inputTokens: 1, outputTokens: 1 });
      });
      const openRouterTimesOut = async () => {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        throw Object.assign(new Error("the provider did not answer within 8000ms"), { name: "AbortError" });
      };
      const settled = runCapture(capturePayload("textToItems", INPUT), {
        userId: "u1", admin: admin(), inputHash: "\\xabc", openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT),
      }, { sleep: async () => {}, callGemini: callGemini as never, generateOpenRouter: openRouterTimesOut as never })
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(25_000);
      const result = await settled;
      expect(result).toEqual({ value: ITEMS });
      // The primary may use more than one attempt inside its own budget; the fallback comes last.
      expect(seen[0].model).toBe("gemini-3.8-flash");
      const fallback = seen.at(-1)!;
      expect(fallback.model).toBe("gemini-3.6-flash");
      expect(seen.filter((s) => s.model === "gemini-3.6-flash")).toHaveLength(1);
      // OpenRouter 8 s + primary 6.5 s; the fallback starts with its 4 s minimum still inside 20 s.
      expect(fallback.at).toBeGreaterThanOrEqual(14_500);
      expect(fallback.at).toBeLessThanOrEqual(20_000 - 4_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Only the surface proposeDraft's text path touches. */
function fakeDb() {
  const rpc = vi.fn(async (name: string) =>
    ({ data: name === "ai_calls_today" ? 0 : null, error: null }));
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gte", "order", "limit", "in"]) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    chain.insert = vi.fn(async () => ({ error: null }));
    return chain;
  });
  return { client: { rpc, from } as never, from };
}

/**
 * A database that keeps the ai_calls rows the ledger writes and answers the duplicate probe from
 * them, honouring its filters (eq / in / status), so a second request sees what the first wrote.
 */
function ledgerDb() {
  const rows: Record<string, unknown>[] = [];
  const probes: { purposes?: unknown[] }[] = [];
  const rpc = vi.fn(async (name: string) => ({ data: name === "ai_calls_today" ? 0 : null, error: null }));
  const from = vi.fn((table: string) => {
    const eqs: Record<string, unknown> = {};
    const ins: Record<string, unknown[]> = {};
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "neq", "gte", "order", "limit"]) chain[m] = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => { eqs[col] = val; return chain; });
    chain.in = vi.fn((col: string, vals: unknown[]) => { ins[col] = vals; return chain; });
    // The circuit breaker awaits the chain itself: no failures on record.
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
    chain.maybeSingle = vi.fn(async () => {
      if (table === "media_objects") return { data: { path: "p", user_id: "u1", deleted_at: null }, error: null };
      if (table !== "ai_calls") return { data: null, error: null };
      probes.push({ purposes: ins.purpose });
      const hit = rows.find((r) => Object.entries(eqs).every(([c, v]) => r[c] === v)
        && Object.entries(ins).every(([c, vs]) => vs.includes(r[c])));
      return { data: hit ? { id: "row-1" } : null, error: null };
    });
    chain.insert = vi.fn(async (row: Record<string, unknown>) => {
      if (table === "ai_calls") rows.push(row);
      return { error: null };
    });
    return chain;
  });
  return { client: withSpendRpc({ rpc, from }) as never, rows, probes };
}

describe("the duplicate probe across providers", () => {
  it("a repeat whose first answer came from OpenRouter is a 409 duplicate", async () => {
    vi.stubEnv("CAPTURE_METHODS", "text,voice,label,photo");
    attestOpenRouter();
    const db = ledgerDb();
    const send = vi.fn(async () => ({ text: JSON.stringify({ items: [], notes: [] }), inputTokens: 1, outputTokens: 1, costUsd: 0 }));
    const callGemini = vi.fn();
    const deps = { runCapture: ((payload, ctx) => runCapture(payload, ctx, { callGemini, openRouterDeps: { send } })) as typeof runCapture };
    const req = { method: "text" as const, localDate: "2026-09-11", tz: "America/New_York", text: "two eggs" };

    await proposeDraft(db.client, db.client, "u1", req, deps);
    const okRows = db.rows.filter((r) => r.status === "ok");
    expect(okRows).toHaveLength(1);
    expect(okRows[0]).toMatchObject({ purpose: "textToItems-openrouter", provider: "openrouter" });
    expect(okRows[0].input_hash).toBe(inputHashFor(capturePayload("textToItems",
      { text: "two eggs", slot: undefined, localDate: "2026-09-11" }).parts));

    await expect(proposeDraft(db.client, db.client, "u1", req, deps))
      .rejects.toMatchObject({ status: 409, code: "duplicate_request" });
    expect(db.probes.at(-1)?.purposes).toEqual(["textToItems", "textToItems-openrouter"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(callGemini).not.toHaveBeenCalled();
  });
});

describe("an unreadable label is not a draft to the duplicate probe", () => {
  const NULLS = Object.fromEntries(NUTRIENT_CODES.map((c) => [c, null]));
  const UNREADABLE = JSON.stringify({ labelReadable: false, name: "none", servingGrams: 0, per100g: NULLS });
  const LABEL_REQ = { method: "label" as const, localDate: "2026-10-03", tz: "America/New_York",
    mediaPath: "media/u1/66666666-6666-4666-8666-666666666666.png" };
  const png = () => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
    new DataView(b.buffer).setUint32(16, 64);
    new DataView(b.buffer).setUint32(20, 64);
    return b;
  };
  const fetchOwnedObject = async () => ({ bytes: png(), mimeType: "image/png" });

  it("OpenRouter: recorded schema_invalid, so the same photo again runs instead of 409ing", async () => {
    vi.stubEnv("CAPTURE_METHODS", "label");
    attestOpenRouter();
    const db = ledgerDb();
    const send = vi.fn(async () => ({ text: UNREADABLE, inputTokens: 5, outputTokens: 5, costUsd: 0.0001 }));
    const callGemini = vi.fn();
    const deps = { fetchOwnedObject: fetchOwnedObject as never,
      runCapture: ((payload, ctx) => runCapture(payload, ctx, { callGemini, openRouterDeps: { send } })) as typeof runCapture };
    for (let i = 0; i < 2; i++) {
      await expect(proposeDraft(db.client, db.client, "u1", LABEL_REQ, deps))
        .rejects.toMatchObject({ status: 422, code: "schema_invalid" });
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(callGemini).not.toHaveBeenCalled();
    expect(db.rows.map((r) => r.status)).toEqual(["schema_invalid", "schema_invalid"]);
    // Spend still lands: the answered tokens and cost are on the row.
    expect(db.rows[0]).toMatchObject({ input_tokens: 5, output_tokens: 5, cost_estimate: 0.0001 });
  });

  it("OpenRouter: labelReadable false is exactly one provider call, a 422, and no Gemini fallback", async () => {
    attestOpenRouter();
    const send = vi.fn(async () => ({ text: UNREADABLE, inputTokens: 5, outputTokens: 5, costUsd: 0.0001 }));
    const callGemini = vi.fn();
    const media = { bytes: png(), mimeType: "image/png" };
    const input = { localDate: "2026-10-03" };
    await expect(runCapture(capturePayload("labelToNutrients", input, media), {
      userId: "u1", admin: admin(), inputHash: "\\xabc",
      openRouter: captureOpenRouterPayload("labelToNutrients-openrouter", input, media),
    }, { sleep: async () => {}, callGemini, openRouterDeps: { send } }))
      .rejects.toMatchObject({ status: 422, code: "schema_invalid" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(callGemini).not.toHaveBeenCalled();

    // The lane itself, with retries allowed (no abandonOnCapacity): still one call.
    send.mockClear();
    await expect(generateOpenRouter({
      payload: captureOpenRouterPayload("labelToNutrients-openrouter", input, media),
      userId: "u1", admin: admin(), modelId: "google/gemini-2.5-flash", schema: labelNutrientsSchema,
      refuse: (v) => (v.labelReadable === false ? "no readable nutrition label" : null),
    }, { send, sleep: async () => {} })).rejects.toBeInstanceOf(UnusableReply);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("Gemini: refused once without a retry, and the same photo again runs", async () => {
    vi.stubEnv("CAPTURE_METHODS", "label");
    const db = ledgerDb();
    const callGemini = vi.fn(async () => ({ text: UNREADABLE, inputTokens: 5, outputTokens: 5 }));
    const deps = { fetchOwnedObject: fetchOwnedObject as never,
      runCapture: ((payload, ctx) => runCapture(payload, ctx, { sleep: async () => {}, callGemini })) as typeof runCapture };
    for (let i = 0; i < 2; i++) {
      await expect(proposeDraft(db.client, db.client, "u1", LABEL_REQ, deps))
        .rejects.toMatchObject({ status: 422, code: "schema_invalid" });
    }
    expect(callGemini).toHaveBeenCalledTimes(2);
    expect(db.rows.map((r) => r.status)).toEqual(["schema_invalid", "schema_invalid"]);
  });
});

/**
 * An admin whose ai_calls reads answer the circuit (failures per provider) and the spend cap
 * (today's cost) from fixed numbers, so the REAL generateOpenRouter gates run.
 */
function gatedAdmin(opts: { openRouterFailures?: number; spentUsd?: number }) {
  const from = () => {
    let columns = "";
    const eqs: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    chain.select = (c: string) => { columns = c; return chain; };
    chain.eq = (c: string, v: unknown) => { eqs[c] = v; return chain; };
    for (const m of ["neq", "in", "order", "limit"]) chain[m] = () => chain;
    chain.gte = async () => {
      if (columns === "cost_estimate") return { data: [{ cost_estimate: opts.spentUsd ?? 0 }], error: null };
      const failures = eqs.provider === "openrouter" ? opts.openRouterFailures ?? 0 : 0;
      return { data: Array.from({ length: failures }, () => ({ created_at: new Date().toISOString() })), error: null };
    };
    chain.insert = async () => ({ error: null });
    return chain;
  };
  return withSpendRpc({ from }, [opts.spentUsd ?? 0]) as never;
}

describe("OpenRouter's own gates and the Gemini fallback", () => {
  it("an open OpenRouter circuit falls back to Gemini", async () => {
    attestOpenRouter();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn();
    const callGemini = gemini(ITEMS);
    const out = await runCapture(capturePayload("textToItems", INPUT), {
      userId: "u1", admin: gatedAdmin({ openRouterFailures: 5 }), inputHash: "\\xabc",
      openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT),
    }, { sleep: async () => {}, callGemini, openRouterDeps: { send } });
    expect(out).toEqual(ITEMS);
    expect(send).not.toHaveBeenCalled();
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("capture fell back to gemini",
      expect.objectContaining({ error: expect.objectContaining({ message: expect.stringMatching(/^circuit open/) }) }));
  });

  it("an OpenRouter capacity answer (503) falls back to Gemini after one attempt", async () => {
    attestOpenRouter();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async () => { throw new ProviderHttpError(503, "openrouter 503"); });
    const callGemini = gemini(ITEMS);
    const out = await runCapture(capturePayload("textToItems", INPUT), {
      userId: "u1", admin: gatedAdmin({}), inputHash: "\\xabc",
      openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT),
    }, { sleep: async () => {}, callGemini, openRouterDeps: { send } });
    expect(out).toEqual(ITEMS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(callGemini).toHaveBeenCalledTimes(1);
  });

  it("the spend cap on the OpenRouter call is a 429 with no Gemini call", async () => {
    attestOpenRouter();
    const send = vi.fn();
    const callGemini = gemini(ITEMS);
    await expect(runCapture(capturePayload("textToItems", INPUT), {
      userId: "u1", admin: gatedAdmin({ spentUsd: 1_000 }), inputHash: "\\xabc",
      openRouter: captureOpenRouterPayload("textToItems-openrouter", INPUT),
    }, { sleep: async () => {}, callGemini, openRouterDeps: { send } }))
      .rejects.toMatchObject({ status: 429, code: "spend_cap" });
    expect(send).not.toHaveBeenCalled();
    expect(callGemini).not.toHaveBeenCalled();
  });
});

describe("proposeDraft routing", () => {
  const REQ = { method: "text" as const, localDate: "2026-09-11", tz: "America/New_York", text: "two eggs" };

  it("hands text capture its OpenRouter twin and the Gemini hash when OpenRouter is ready", async () => {
    vi.stubEnv("CAPTURE_METHODS", "text,voice,label,photo");
    attestOpenRouter();
    const db = fakeDb();
    const run = vi.fn(async () => ({ items: [], notes: [] }));
    const draft = await proposeDraft(db.client, db.client, "u1", REQ, { runCapture: run as never });
    // C8: a /api/log/propose draft is always the capture model's read, and says so.
    expect(draft.provenance).toEqual({ ai: true, source: "model", purpose: "textToItems" });
    const ctx = (run.mock.calls[0] as unknown[])[1] as { openRouter?: { purpose: string }; inputHash?: string };
    expect(ctx.openRouter?.purpose).toBe("textToItems-openrouter");
    expect(ctx.inputHash).toMatch(/^\\x[0-9a-f]{64}$/);
  });

  it("keeps text capture on Gemini alone when OpenRouter is not ready", async () => {
    vi.stubEnv("CAPTURE_METHODS", "text,voice,label,photo");
    const db = fakeDb();
    const run = vi.fn(async () => ({ items: [], notes: [] }));
    await proposeDraft(db.client, db.client, "u1", REQ, { runCapture: run as never });
    const ctx = (run.mock.calls[0] as unknown[])[1] as { openRouter?: unknown };
    expect(ctx.openRouter).toBeUndefined();
  });
});

/**
 * 2026-10-06 (Gemini project denial, #gemini-fallback): voice (`voiceToItems`) keeps Gemini
 * PRIMARY — unlike text/photo/label above, which ask OpenRouter first — and only reaches
 * OpenRouter once the Gemini pair is exhausted, via `ctx.openRouterFallback`.
 */
/** A minimal, real WAV header (validateAudio sniffs RIFF/WAVE, not a declared type alone). */
function wavBytes(seconds = 2): Uint8Array {
  const byteRate = 16_000;
  const bytes = new Uint8Array(44 + 16);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF"); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint32(28, byteRate, true);
  ascii(36, "data");
  view.setUint32(40, Math.round(seconds * byteRate), true);
  return bytes;
}
const AUDIO = { bytes: wavBytes(), mimeType: "audio/wav" };

describe("runCapture: voice stays on Gemini, OpenRouter is only the fallback", () => {
  it("never calls OpenRouter when Gemini answers", async () => {
    attestOpenRouter();
    const callGemini = gemini(ITEMS);
    const generateOpenRouter = vi.fn();
    const out = await runCapture(capturePayload("voiceToItems", INPUT, AUDIO), {
      userId: "u1", admin: admin(), inputHash: "\\xabc",
      openRouterFallback: captureOpenRouterPayload("voiceToItems-openrouter", INPUT, AUDIO),
    }, { callGemini, generateOpenRouter: generateOpenRouter as never });
    expect(out).toEqual(ITEMS);
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(callGemini.mock.calls[0][0]).toBe("gemini-3.8-flash");
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });

  it("skips the same-key Gemini backup on a 403 PERMISSION_DENIED and goes straight to OpenRouter", async () => {
    attestOpenRouter();
    const denied = new ProviderHttpError(403,
      "gemini 403: PERMISSION_DENIED: Your project has been denied access. Please contact support.");
    const callGemini = vi.fn(async (_model: string) => { throw denied; });
    const generateOpenRouter = vi.fn(async (_args: OpenRouterArgs<unknown>) => ITEMS);
    const out = await runCapture(capturePayload("voiceToItems", INPUT, AUDIO), {
      userId: "u1", admin: admin(), inputHash: "\\xabc",
      openRouterFallback: captureOpenRouterPayload("voiceToItems-openrouter", INPUT, AUDIO),
    }, { sleep: async () => {}, callGemini, generateOpenRouter: generateOpenRouter as never });
    expect(out).toEqual(ITEMS);
    // Exactly one Gemini model tried: the same-key backup (gemini-3.6-flash) would fail the
    // identical way, so it is never attempted.
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(callGemini.mock.calls[0][0]).toBe("gemini-3.8-flash");
    const args = generateOpenRouter.mock.calls[0][0];
    expect(args.payload.purpose).toBe("voiceToItems-openrouter");
    expect(args.modelId).toBe("google/gemini-2.5-flash");
    expect(args.inputHash).toBe("\\xabc");
  });

  it("skips the same-key Gemini backup on an ordinary provider error too, once OpenRouter is ready", async () => {
    attestOpenRouter();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const callGemini = vi.fn(async (_model: string) => { throw new ProviderHttpError(503, "gemini 503"); });
    const generateOpenRouter = vi.fn(async (_args: OpenRouterArgs<unknown>) => ITEMS);
    const out = await runCapture(capturePayload("voiceToItems", INPUT, AUDIO), {
      userId: "u1", admin: admin(), inputHash: "\\xabc",
      openRouterFallback: captureOpenRouterPayload("voiceToItems-openrouter", INPUT, AUDIO),
    }, { sleep: async () => {}, callGemini, generateOpenRouter: generateOpenRouter as never });
    expect(out).toEqual(ITEMS);
    // 2026-10-06 (Sol review, BLOCK): the same-key backup's own retry budget could leave under
    // MIN_FALLBACK_MS for OpenRouter afterwards on a SLOW failure (a hang, not a fast 403) — so
    // once a purpose has another provider's fallback ready, the same-key backup is skipped for
    // ANY primary failure, not only a 403, and OpenRouter gets nearly the whole remaining budget.
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(callGemini.mock.calls[0][0]).toBe("gemini-3.8-flash");
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(generateOpenRouter.mock.calls[0][0].timeoutMs).toBeGreaterThan(15_000);
  });

  it("surfaces the original Gemini error when OpenRouter is not ready", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = new ProviderHttpError(403,
      "gemini 403: PERMISSION_DENIED: Your project has been denied access. Please contact support.");
    const callGemini = vi.fn(async () => { throw denied; });
    const generateOpenRouter = vi.fn();
    await expect(runCapture(capturePayload("voiceToItems", INPUT, AUDIO), {
      userId: "u1", admin: admin(), inputHash: "\\xabc",
      // OpenRouter not attested (no attestOpenRouter() call): the fallback must never fire.
      openRouterFallback: undefined,
    }, { callGemini, generateOpenRouter: generateOpenRouter as never }))
      .rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });
});

describe("proposeDraft routing for voice", () => {
  const REQ = { method: "voice" as const, localDate: "2026-09-11", tz: "America/New_York",
    mediaPath: "u1/clip.wav" };

  /** fakeDb() answers every table's `maybeSingle` with null, but proposeDraft's voice path first
   *  checks `media_objects` owns the path (lib/server/capture.ts assertLiveMediaObject) — this
   *  layers that one table's row on top of the otherwise-generic fake. */
  function voiceDb() {
    const base = fakeDb();
    const from = vi.fn((table: string) => {
      // fakeDb's own `from` ignores its table argument entirely (same generic chain either way).
      const chain = base.from() as Record<string, unknown>;
      // `chain.select()`/`.eq()` both return THIS SAME object (see fakeDb above), so the
      // override has to mutate it in place — a spread copy would leave those methods still
      // returning the ORIGINAL object, whose `maybeSingle` is still the null-returning one.
      if (table === "media_objects") {
        chain.maybeSingle = vi.fn(async () =>
          ({ data: { user_id: "u1", deleted_at: null }, error: null }));
      }
      return chain;
    });
    return { client: { rpc: (base.client as { rpc: unknown }).rpc, from } as never };
  }

  it("keeps Gemini primary for voice and hands runCapture the OpenRouter twin only as a fallback", async () => {
    vi.stubEnv("CAPTURE_METHODS", "text,voice,label,photo");
    attestOpenRouter();
    const db = voiceDb();
    const run = vi.fn(async () => ({ items: [], notes: [] }));
    await proposeDraft(db.client, db.client, "u1", REQ, {
      runCapture: run as never,
      fetchOwnedObject: vi.fn(async () => ({ bytes: AUDIO.bytes, mimeType: AUDIO.mimeType })) as never,
    });
    const ctx = (run.mock.calls[0] as unknown[])[1] as {
      openRouter?: unknown; openRouterFallback?: { purpose: string }; inputHash?: string };
    expect(ctx.openRouter).toBeUndefined();
    expect(ctx.openRouterFallback?.purpose).toBe("voiceToItems-openrouter");
    expect(ctx.inputHash).toMatch(/^\\x[0-9a-f]{64}$/);
  });
});
