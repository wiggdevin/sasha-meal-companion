import { afterEach, describe, expect, it, vi } from "vitest";
import { generateStructured } from "@/lib/ai/adapter";
import { CallRefused, ProviderHttpError, SchemaRejection } from "@/lib/ai/call";
import { AttestationRefused } from "@/lib/ai/attestation";
import { LANES } from "@/lib/ai/lanes";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { providerFallbackWorthTrying } from "@/lib/ai/provider-fallback";
import { HttpError } from "@/lib/server/auth";
import { readDocument } from "@/lib/server/plan-document";
import { inspire } from "@/lib/server/plan-inspire";
import { spendAdmin } from "./spend-admin";

afterEach(() => { vi.unstubAllEnvs(); });

describe("Plan provider fallback ledger", () => {
  it("retries provider and timeout failures, not schema or governance refusals", () => {
    const timeout = Object.assign(new Error("timed out"), { name: "AbortError" });
    for (const error of [new ProviderHttpError(429, "quota"), new ProviderHttpError(500, "error"),
      new ProviderHttpError(503, "unavailable"), timeout, new TypeError("fetch failed")]) {
      expect(providerFallbackWorthTrying(error)).toBe(true);
    }
    for (const error of [new SchemaRejection("bad reply"), new CallRefused("blocked"),
      new AttestationRefused(), new HttpError(429, "spend_cap", "cap"),
      ...[400, 401, 403, 404, 413, 422].map((status) => new ProviderHttpError(status, "safety block")),
      new ProviderHttpError(400, "request timed out")]) {
      expect(providerFallbackWorthTrying(error)).toBe(false);
    }
  });

  it("does not send a rejected Plan request to the Gemini twin", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    const generate = vi.fn().mockRejectedValue(new ProviderHttpError(403, "safety block"));
    const generateGemini = vi.fn();
    await expect(readDocument({} as never, {} as never, "u", { kind: "text", text: "Lunch: eggs",
      localDate: "2026-10-05", slot: "meal-2", slotTime: "12:30", targetKcal: 600 },
    { generate, generateGemini })).rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
    expect(generateGemini).not.toHaveBeenCalled();
  });

  it("records one row for each governed provider call, with no extra retry row", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.stubEnv("OPENROUTER_API_KEY", "test-only");
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
    const rows: Record<string, unknown>[] = [];
    const admin = spendAdmin([], rows) as never;
    const generate = ((args: Parameters<typeof generateOpenRouter>[0]) => generateOpenRouter(args, {
      send: vi.fn(async () => { throw new ProviderHttpError(503, "openrouter 503"); }) as never,
    })) as typeof generateOpenRouter;
    const generateGemini = ((args: Parameters<typeof generateStructured>[0]) => generateStructured(args, {
      callGemini: vi.fn(async () => ({ text: JSON.stringify(args.payload.purpose === "photoToIdeas-gemini"
        ? { kind: "ingredients", title: null, ingredients: ["eggs"], plate: null, menu: [] }
        : { kind: "other", title: null, days: [], ingredients: [], menu: [] }),
        inputTokens: 1, outputTokens: 1 })) as never,
    })) as typeof generateStructured;

    const photo = await inspire(admin, {} as never, "u", { kind: "photo", localDate: "2026-10-05",
      mediaPath: "media/u/photo.jpg" }, { generate, generateGemini,
      fetchObject: async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" }) });
    expect(photo.ingredients).toEqual(["eggs"]);
    const document = await readDocument(admin, {} as never, "u", { kind: "text", text: "Lunch: eggs",
      localDate: "2026-10-05", slot: "meal-2", slotTime: "12:30", targetKcal: 600 },
    { generate, generateGemini });
    expect(document.kind).toBe("other");
    expect(rows.map(({ purpose, provider, model_id, status }) => [purpose, provider, model_id, status])).toEqual([
      ["photoToIdeas", "openrouter", LANES.plan.model, "provider_error"],
      ["photoToIdeas-gemini", "google", LANES.plan.fallback, "ok"],
      ["documentToPlan", "openrouter", LANES.plan.model, "provider_error"],
      ["documentToPlan-gemini", "google", LANES.plan.fallback, "ok"],
    ]);
  });

  it("sends a PDF through the governed Gemini twin with its MIME type and pinned id", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
    const rows: Record<string, unknown>[] = [];
    const admin = spendAdmin([], rows) as never;
    const generate = vi.fn().mockRejectedValue(new ProviderHttpError(503, "openrouter 503"));
    const callGemini = vi.fn(async (_model: string, _parts: unknown[]) => ({
      text: JSON.stringify({ kind: "other", title: null, days: [], ingredients: [], menu: [] }),
      inputTokens: 1, outputTokens: 1,
    }));
    const generateGemini = ((args: Parameters<typeof generateStructured>[0]) => generateStructured(args,
      { callGemini: callGemini as never })) as typeof generateStructured;
    const data = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >>").toString("base64");
    const result = await readDocument(admin, {} as never, "u", { kind: "pdf", data,
      localDate: "2026-10-05", slot: "meal-2", slotTime: "12:30", targetKcal: 600 },
    { generate, generateGemini });
    expect(result.kind).toBe("other");
    expect(callGemini.mock.calls[0][0]).toBe(LANES.plan.fallback);
    expect(callGemini.mock.calls[0][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ inlineData: expect.objectContaining({ mimeType: "application/pdf" }) }),
    ]));
    expect(rows.map(({ purpose, model_id, status }) => [purpose, model_id, status]))
      .toEqual([["documentToPlan-gemini", LANES.plan.fallback, "ok"]]);
  });

  it("starts the photo twin after an OpenRouter timeout", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
    const timeout = Object.assign(new Error("timed out"), { name: "AbortError" });
    const generate = vi.fn().mockRejectedValue(timeout);
    const generateGemini = vi.fn().mockResolvedValue({ kind: "ingredients", title: null,
      ingredients: ["eggs"], plate: null, menu: [] });
    const result = await inspire({} as never, {} as never, "u", { kind: "photo", localDate: "2026-10-05",
      mediaPath: "media/u/photo.jpg" }, { generate, generateGemini,
      fetchObject: async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" }) });
    expect(result.ingredients).toEqual(["eggs"]);
    expect(generateGemini.mock.calls[0][0].route).toEqual({ provider: "google", modelId: LANES.plan.fallback });
  });

  it("keeps Gemini attestation refusal final after an OpenRouter 503", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    const generate = vi.fn().mockRejectedValue(new ProviderHttpError(503, "openrouter 503"));
    const generateGemini = vi.fn();
    await expect(readDocument({} as never, {} as never, "u", { kind: "text", text: "Lunch: eggs",
      localDate: "2026-10-05", slot: "meal-2", slotTime: "12:30", targetKcal: 600 },
    { generate, generateGemini })).rejects.toMatchObject({ status: 503, code: "provider_unavailable" });
    expect(generateGemini).not.toHaveBeenCalled();
  });
});
