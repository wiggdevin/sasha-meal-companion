/**
 * 2026-10-06 (Gemini project denial, #gemini-fallback): the `input_audio` content part voice
 * capture and the coach's transcribe fallback send over OpenRouter. Fake fetch; no live call —
 * the real provider shape was checked once, live, against the actual OpenRouter API (not in CI).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateOpenRouter } from "@/lib/ai/openrouter";
import { captureOpenRouterPayload, transcribeOpenRouterPayload } from "@/lib/ai/openrouter-payloads";
import { CAPTURE_SCHEMAS } from "@/lib/ai/schemas";
import { spendAdmin } from "./spend-admin";
import { z } from "zod";

const reply = { items: [], notes: [] };

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
}

describe("audio content parts on OpenRouter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("sends the recorder's audio/mp4 clip as input_audio with format m4a, not 'mp4'", async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse(reply));
    const media = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mp4" };
    const payload = captureOpenRouterPayload("voiceToItems-openrouter",
      { slot: "meal-1", localDate: "2026-09-11" }, media);
    const out = await generateOpenRouter({
      payload, userId: "u1", admin: spendAdmin([], []) as never,
      modelId: "google/gemini-2.5-flash", schema: CAPTURE_SCHEMAS.voiceToItems,
    });
    expect(out).toEqual(reply);
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    const part = body.messages[0].content[1];
    expect(part.type).toBe("input_audio");
    // Note: the recorder's audio/mp4 clip is an MP4-container AAC track with no video, which is
    // exactly what the ".m4a" extension — and OpenRouter's audio format token — names.
    expect(part.input_audio.format).toBe("m4a");
    expect(part.input_audio.data).toBe(Buffer.from(media.bytes).toString("base64"));
  });

  it("sends a WAV clip as input_audio with format wav", async () => {
    vi.mocked(fetch).mockImplementation(async () => okResponse({ text: "hello" }));
    const media = { bytes: new Uint8Array([4, 5, 6]), mimeType: "audio/wav" };
    const payload = transcribeOpenRouterPayload(media);
    const out = await generateOpenRouter({
      payload, userId: "u1", admin: spendAdmin([], []) as never,
      modelId: "google/gemini-2.5-flash", schema: z.object({ text: z.string() }),
    });
    expect(out).toEqual({ text: "hello" });
    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body));
    const part = body.messages[0].content[1];
    expect(part.type).toBe("input_audio");
    expect(part.input_audio.format).toBe("wav");
  });

  it("refuses to build a voiceToItems-openrouter payload for a non-audio mime type", () => {
    expect(() => captureOpenRouterPayload("voiceToItems-openrouter",
      { slot: "meal-1", localDate: "2026-09-11" },
      { bytes: new Uint8Array([1]), mimeType: "image/png" })).toThrow(/takes/);
  });
});
