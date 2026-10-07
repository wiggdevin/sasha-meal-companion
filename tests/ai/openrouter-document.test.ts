/**
 * `documentToPlan` on the OpenRouter transport: the builder refuses without the attestation and
 * reads the file type from its bytes; the request carries a PDF as a native file part (no billed
 * OCR engine) and a photo as an image part. Fake fetch; no live call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentReadSchema } from "@/lib/ai/document";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { documentPlanPayload } from "@/lib/ai/openrouter-payloads";
import { spendAdmin } from "./spend-admin";

const PDF = new TextEncoder().encode("%PDF-1.4 plan");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const reply = { kind: "other", title: null, days: [], ingredients: [], menu: [] };

describe("documentToPlan on OpenRouter", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("refuses to build without OPENROUTER_ATTESTED=1, and refuses bytes of the wrong type", () => {
    expect(() => documentPlanPayload({ kind: "pdf", bytes: PDF })).toThrow();
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    expect(() => documentPlanPayload({ kind: "pdf", bytes: JPEG })).toThrow(/PDF/);
    expect(() => documentPlanPayload({ kind: "image", bytes: PDF })).toThrow(/JPEG or PNG/);
    expect(() => documentPlanPayload({ kind: "text", text: "   " })).toThrow();
  });

  it("sends a PDF as a native file part and a photo as an image part", async () => {
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    vi.mocked(fetch).mockImplementation(async () => ok());
    for (const payload of [documentPlanPayload({ kind: "pdf", bytes: PDF }), documentPlanPayload({ kind: "image", bytes: JPEG })]) {
      const out = await generateOpenRouter({ payload, userId: "u1", admin: spendAdmin([], []) as never,
        modelId: "google/gemini-3-flash-preview", schema: documentReadSchema });
      expect(out).toEqual(reply);
    }
    const [pdfBody, imageBody] = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(pdfBody.messages[0].content[1]).toEqual({ type: "file",
      file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${Buffer.from(PDF).toString("base64")}` } });
    expect(pdfBody.plugins).toEqual([{ id: "file-parser", pdf: { engine: "native" } }]);
    expect(pdfBody.provider).toMatchObject({ data_collection: "deny", zdr: true });
    expect(imageBody.messages[0].content[1].type).toBe("image_url");
    expect(imageBody.plugins).toBeUndefined();
  });
});
