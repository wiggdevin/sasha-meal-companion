/**
 * Owner request 2026-10-02: the OpenRouter structured-output transport (lib/ai/openrouter.ts) —
 * request shape, usage→ledger cost, error mapping, and that the key never leaks into a thrown
 * message or a log line. Fake fetch throughout; no live call (scripts/openrouter-live-check.ts
 * is the live check).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderHttpError } from "@/lib/ai/call";
import { isCapacityFailure } from "@/lib/ai/failures";
import { toPlainJsonSchema } from "@/lib/ai/json-schema";
import { coachOpenRouterPayload } from "@/lib/ai/openrouter-payloads";
import { generateOpenRouter, parseLooseObject } from "@/lib/ai/openrouter";
import { spendAdmin } from "./spend-admin";
import { APP_NAME } from "@/lib/brand";

const KEY = "sk-or-v1-test-secret-do-not-leak";
const MODEL = "openai/gpt-5-mini";
const SCHEMA = z.object({ kind: z.literal("final"), text: z.string() });

function attest(): void {
  vi.stubEnv("OPENROUTER_ATTESTED", "1");
  vi.stubEnv("OPENROUTER_API_KEY", KEY);
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

const providerBody = (content: unknown, usage: Record<string, number> = {}) => ({
  choices: [{ message: { content: JSON.stringify(content) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, ...usage },
});

describe("the OpenRouter transport (owner request 2026-10-02)", () => {
  let inserted: Record<string, unknown>[];
  let admin: ReturnType<typeof spendAdmin>;

  beforeEach(() => {
    inserted = [];
    admin = spendAdmin([], inserted);
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("builds an OpenAI-compatible request: schema, attribution headers, usage accounting", async () => {
    attest();
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody({ kind: "final", text: "hi" })));
    const payload = coachOpenRouterPayload(["USER: what should I eat"]);
    const result = await generateOpenRouter({
      payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA,
      maxOutputTokens: 3072,
    });
    expect(result).toEqual({ kind: "final", text: "hi" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["http-referer"]).toBeTruthy();
    expect(headers["x-title"]).toBeTruthy();

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(MODEL);
    expect(body.messages).toEqual([{ role: "user", content: payload.text }]);
    expect(body.usage).toEqual({ include: true });
    expect(body.response_format).toMatchObject({ type: "json_schema" });
    expect(body.response_format.json_schema.schema).toEqual(toPlainJsonSchema(SCHEMA));
    // Health data only reaches providers that neither store nor train on it, and only ones that
    // honour the structured-output parameter (2026-10-02). `zdr` is OpenRouter's own
    // storage-side Zero Data Retention switch — `data_collection: "deny"` alone covers training,
    // not storage; live-tested OK for anthropic/claude-haiku-4.5, google/gemini-2.5-flash and
    // google/gemini-3-flash-preview (2026-10-02 DeepSeek audit, finding #5).
    expect(body.provider).toEqual({ data_collection: "deny", zdr: true, require_parameters: true });
    // The same output ceiling as the Gemini path (Grok audit, 2026-10-02): no cap meant a runaway
    // reply billed without limit.
    expect(body.max_tokens).toBe(3072);
    expect(headers["http-referer"]).toMatch(/^https?:\/\//);
    expect(headers["x-title"]).toBe(APP_NAME);
  });

  // Live 2026-10-02: Claude (the configured fallback) refused the coach schema with 400 "Empty
  // schema ({}) that accepts any JSON value is not supported" — a tool call's free-form `args`.
  it("never sends an empty sub-schema: free-form fields go out as JSON strings", async () => {
    attest();
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody({ kind: "final", text: "hi", args: {} })));
    const schema = z.object({ kind: z.literal("final"), text: z.string(), args: z.unknown() });
    await generateOpenRouter({ payload: coachOpenRouterPayload(["USER: hi"]), userId: "u1",
      admin: admin as never, modelId: MODEL, schema });
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].body));
    const empties: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      if (!Array.isArray(node) && Object.keys(node).length === 0) empties.push(path);
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    };
    walk(body.response_format.json_schema.schema, "$");
    expect(empties).toEqual([]);
    expect(body.response_format.json_schema.schema.properties.args.type).toBe("string");
  });

  // Live 2026-10-02: with `args` sent as a bare `{ type: "object" }`, strict mode let the model
  // write only `{}`, so suggest_options failed "kind: Invalid option" on every call.
  it("decodes a tool call's string args back into the object the tool checks", async () => {
    attest();
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody({ kind: "tool",
      calls: [{ name: "suggest_options", args: "{\"kind\":\"snack\",\"count\":2}" },
        { name: "get_day", args: "" }] })));
    const schema = z.object({ kind: z.literal("tool"),
      calls: z.array(z.object({ name: z.string(), args: z.unknown() })) });
    const out = await generateOpenRouter({ payload: coachOpenRouterPayload(["USER: snacks"]), userId: "u1",
      admin: admin as never, modelId: MODEL, schema });
    expect(out.calls).toEqual([{ name: "suggest_options", args: { kind: "snack", count: 2 } },
      { name: "get_day", args: {} }]);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.response_format.json_schema.schema.properties.calls.items.properties.args.type).toBe("string");
  });

  it("records the real tokens and the provider's own dollar cost on the ai_calls row", async () => {
    attest();
    vi.mocked(fetch).mockResolvedValue(jsonResponse(
      providerBody({ kind: "final", text: "ok" }, { prompt_tokens: 123, completion_tokens: 45, cost: 0.00987 }),
    ));
    const payload = coachOpenRouterPayload(["USER: hi"]);
    await generateOpenRouter({ payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA });

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.provider).toBe("openrouter");
    expect(row.model_id).toBe(MODEL);
    expect(row.input_tokens).toBe(123);
    expect(row.output_tokens).toBe(45);
    expect(row.cost_estimate).toBeCloseTo(0.00987, 6);
    expect(row.status).toBe("ok");
  });

  it("zero cost when the provider does not report usage.cost — never a local price guess", async () => {
    attest();
    vi.mocked(fetch).mockResolvedValue(jsonResponse(providerBody({ kind: "final", text: "ok" })));
    const payload = coachOpenRouterPayload(["USER: hi"]);
    await generateOpenRouter({ payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA });
    expect(inserted[0].cost_estimate).toBe(0);
  });

  it.each([429, 503])("maps a %s to a capacity failure, retried once", async (status) => {
    attest();
    vi.mocked(fetch).mockResolvedValue(new Response("rate limited", { status }));
    const payload = coachOpenRouterPayload(["USER: hi"]);
    const error = await generateOpenRouter({
      payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA,
    }, { sleep: async () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).status).toBe(status);
    expect(isCapacityFailure(error)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2); // one retry (RETRIES = 1)
    expect(inserted[0].status).toBe("provider_error");
  });

  it("a non-retryable 400 is not retried", async () => {
    attest();
    vi.mocked(fetch).mockResolvedValue(new Response("bad schema", { status: 400 }));
    const payload = coachOpenRouterPayload(["USER: hi"]);
    await expect(generateOpenRouter({
      payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA,
    })).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  /**
   * 2026-10-02 Grok audit: RETRIES always spent a second attempt on a capacity failure even when
   * the caller — the coach's PRIMARY OpenRouter model, with a fallback (another OpenRouter model
   * or Gemini) waiting — has somewhere else to go, mirroring the Gemini path's own
   * `abandonOnCapacity` (lib/ai/adapter.ts). The PIN is abandoned on its first capacity failure so
   * the outer loop can switch providers at once; a call with no such flag keeps retrying exactly
   * as before.
   */
  it.each([429, 503])(
    "abandons a %s after one attempt when abandonOnCapacity is set", async (status) => {
      attest();
      vi.mocked(fetch).mockResolvedValue(new Response("rate limited", { status }));
      const payload = coachOpenRouterPayload(["USER: hi"]);
      const error = await generateOpenRouter({
        payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA,
        abandonOnCapacity: true,
      }, { sleep: async () => {} }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * 2026-10-02 Grok audit: a non-2xx response body used to be copied (300 chars) straight into the
   * thrown ProviderHttpError's message, which model-loop.ts's console.error then prints up to 500
   * chars of. An OpenRouter 4xx (e.g. a validation error) can echo back the request it rejected —
   * health data, in the coach's case — so the body must never cross into the message at all, only
   * the status.
   */
  it("never lets a non-2xx response body (which can echo the request) reach the thrown message", async () => {
    attest();
    vi.mocked(fetch).mockResolvedValue(new Response(
      "invalid request: SECRET_PROMPT I have colitis and take humira", { status: 400 },
    ));
    const payload = coachOpenRouterPayload(["USER: hi"]);
    const error = await generateOpenRouter({
      payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as Error).message).not.toContain("SECRET_PROMPT");
    expect((error as ProviderHttpError).status).toBe(400);
    expect(JSON.stringify(inserted)).not.toContain("SECRET_PROMPT");
  });

  it("never leaks the key into a thrown message or the ai_calls row, however the call fails", async () => {
    attest();
    // A real OpenRouter error body never echoes the caller's own bearer token; this proves OUR
    // code does not independently serialise the Authorization header (or process.env) anywhere
    // that reaches the thrown error or the row callModel writes.
    vi.mocked(fetch).mockResolvedValue(new Response("rate limited, slow down", { status: 500 }));
    const payload = coachOpenRouterPayload(["USER: hi"]);
    const error: unknown = await generateOpenRouter({
      payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(KEY);
    expect(JSON.stringify(inserted)).not.toContain(KEY);
  });

  it("refuses with no fetch call when OPENROUTER_API_KEY is unset", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const payload = coachOpenRouterPayload(["USER: hi"]);
    await expect(generateOpenRouter({
      payload, userId: "u1", admin: admin as never, modelId: MODEL, schema: SCHEMA,
    })).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });
});

describe("the OpenRouter attestation gate, mirroring Gemini's (owner request 2026-10-02)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("refuses to build the coach-openrouter payload without OPENROUTER_ATTESTED=1", () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "");
    expect(() => coachOpenRouterPayload(["USER: I have colitis"])).toThrow();
    try { coachOpenRouterPayload(["x"]); }
    catch (error) { expect(error).toMatchObject({ status: 503, code: "nous_unconfirmed" }); }
  });

  it("the key alone is not the attestation", () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    vi.stubEnv("OPENROUTER_ATTESTED", "");
    expect(() => coachOpenRouterPayload(["x"])).toThrow();
  });

  it("builds once OPENROUTER_ATTESTED=1 is set", () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const payload = coachOpenRouterPayload(["USER: hi"]);
    expect(payload.purpose).toBe("coach-openrouter");
    expect(payload.text).toBe("USER: hi");
  });
});

describe("parseLooseObject", () => {
  it("reads plain and double-encoded JSON objects", () => {
    expect(parseLooseObject('{"kind":"recipe"}')).toEqual({ kind: "recipe" });
    expect(parseLooseObject(' {"kind":"recipe"} \n')).toEqual({ kind: "recipe" });
    expect(parseLooseObject(JSON.stringify('{"kind":"snack"}'))).toEqual({ kind: "snack" });
    expect(parseLooseObject("")).toEqual({});
  });
  it("leaves anything else as the original string for the tool schema to refuse", () => {
    for (const raw of ["kind recipe", 'args: {"kind":"meal","count":2} done',
      'Example: {"kind":"snack","count":3}', "null", "[]", "true", "1", '"just text"',
      JSON.stringify("[1,2]"), JSON.stringify(JSON.stringify('{"kind":"snack"}'))]) {
      expect(parseLooseObject(raw)).toBe(raw);
    }
  });
});
