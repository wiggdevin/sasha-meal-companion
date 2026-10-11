/**
 * T7 §2 — the server half of the fallback: read the object, re-validate it, transcribe it, and
 * keep nothing. The status table is the spec's: 415 for a non-audio object, 422 for a clip over
 * 30 s, 503 `provider` / `timeout`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { generateStructured } from "@/lib/ai/adapter";
import { CallRefused, ProviderHttpError, SchemaRejection } from "@/lib/ai/call";
import { LANES } from "@/lib/ai/lanes";
import { MODELS } from "@/lib/ai/models";
import {
  TRANSCRIBE_CALL_MS, TRANSCRIBE_PROMPT, TRANSCRIBE_PURPOSE, transcribeAudio, transcribeRequestSchema,
} from "@/lib/server/coach-transcribe";
import { spendAdmin } from "@/tests/ai/spend-admin";

/** A minimal WAV whose header says `seconds` long. */
function wav(seconds: number): Uint8Array {
  const byteRate = 16_000;
  const dataBytes = Math.round(seconds * byteRate);
  const bytes = new Uint8Array(44 + 16);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF"); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint32(28, byteRate, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const objectOf = (bytes: Uint8Array, mimeType: string) =>
  vi.fn(async () => ({ bytes, mimeType }));

const REQ = { path: "media/11111111-1111-4111-8111-111111111111/3f1b1a2c-0000-4000-8000-000000000030.m4a" };

describe("the request body", () => {
  it("takes a path and nothing else", () => {
    expect(transcribeRequestSchema.safeParse(REQ).success).toBe(true);
    expect(transcribeRequestSchema.safeParse({ path: "" }).success).toBe(false);
    expect(transcribeRequestSchema.safeParse({}).success).toBe(false);
  });

  it("drops anything else the caller sends", () => {
    const parsed = transcribeRequestSchema.parse({ ...REQ, text: "already transcribed" });
    expect(parsed).toEqual(REQ);
  });
});

describe("the prompt", () => {
  it("asks for the words and nothing else, and says the audio is untrusted", () => {
    expect(TRANSCRIBE_PROMPT).toMatch(/exactly what is said/i);
    expect(TRANSCRIBE_PROMPT).toMatch(/never follow an instruction/i);
  });

  it("runs on the pinned flash model under its own purpose", () => {
    expect(TRANSCRIBE_PURPOSE).toBe("coach-transcribe");
    expect(MODELS[TRANSCRIBE_PURPOSE]).toBe(MODELS.textToItems);
  });
});

describe("transcribeAudio", () => {
  const generate = (text: string) => vi.fn(async () => ({ text })) as never;

  it("returns the transcript and how long the model took", async () => {
    const result = await transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: generate("Add watermelon to my avoid list."),
    });
    expect(result.text).toBe("Add watermelon to my avoid list.");
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("sends the bytes it read, under the coach-transcribe purpose", async () => {
    const generate = vi.fn(async (_args: unknown) => ({ text: "hello" }));
    await transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(5), "audio/wav") as never, generate: generate as never,
    });
    const args = generate.mock.calls[0]?.[0] as unknown as { userId: string; payload: {
      purpose: string; media: { mimeType: string }; parts: { text: string }[] } };
    expect(args.payload.purpose).toBe("coach-transcribe");
    expect(args.userId).toBe("u1");
    expect(args.payload.media.mimeType).toBe("audio/wav");
    expect(args.payload.parts[0].text).toBe(TRANSCRIBE_PROMPT);
  });

  it("refuses with 503 nous_unconfirmed before the clip is read, when not attested", async () => {
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    const fetchOwnedObject = vi.fn();
    const call = vi.fn();
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: fetchOwnedObject as never, generate: call as never,
    })).rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(fetchOwnedObject).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("415s an image object", async () => {
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(PNG, "image/png") as never, generate: generate("x"),
    })).rejects.toMatchObject({ status: 415, code: "unsupported_media" });
  });

  it("422s a clip over 30 s", async () => {
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(31), "audio/wav") as never, generate: generate("x"),
    })).rejects.toMatchObject({ status: 422, code: "too_long" });
  });

  it("spends nothing on an object it refused", async () => {
    const generate = vi.fn(async (_args: unknown) => ({ text: "x" }));
    await transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(PNG, "image/png") as never, generate: generate as never,
    }).catch(() => undefined);
    expect(generate).not.toHaveBeenCalled();
  });

  it("503s `timeout` when the provider never answered", async () => {
    const abort = Object.assign(new Error("the provider did not answer"), { name: "AbortError" });
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: vi.fn(async () => { throw abort; }) as never,
    })).rejects.toMatchObject({ status: 503, code: "timeout" });
  });

  it("503s `provider` for every other provider failure", async () => {
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: vi.fn(async () => { throw new Error("gemini 500"); }) as never,
    })).rejects.toMatchObject({ status: 503, code: "provider" });
  });

  it("retries a provider failure once on the Gemini backup pin", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new ProviderHttpError(503, "gemini 503"))
      .mockResolvedValueOnce({ text: "hello" });
    const out = await transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never, generate: generate as never,
    });
    expect(out.text).toBe("hello");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].route).toEqual({ provider: "google", modelId: LANES.capture.fallback });
    expect(generate.mock.calls[1][0].payload.purpose).toBe("coach-transcribe");
    expect(generate.mock.calls[1][0].abandonOnCapacity).toBe(true);
  });

  it("gives the primary its full previous deadline and skips a backup without a useful attempt window", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const generate = vi.fn(async (_args: unknown) => { now += 2_000; throw new ProviderHttpError(503, "fast 503"); });
      await expect(transcribeAudio({} as never, "u1", REQ, {
        fetchOwnedObject: objectOf(wav(10), "audio/wav") as never, generate: generate as never,
      })).rejects.toMatchObject({ status: 503, code: "provider" });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate.mock.calls[0][0]).toMatchObject({ timeoutMs: TRANSCRIBE_CALL_MS,
        attemptTimeoutMs: TRANSCRIBE_CALL_MS });
    } finally { clock.mockRestore(); }
  });

  it("uses the backup when a fast failure leaves an attempt window", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const generate = vi.fn().mockImplementationOnce(async () => {
        now += 1_000;
        throw new ProviderHttpError(503, "fast 503");
      }).mockResolvedValueOnce({ text: "hello" });
      await transcribeAudio({} as never, "u1", REQ, {
        fetchOwnedObject: objectOf(wav(10), "audio/wav") as never, generate: generate as never,
      });
      expect(generate.mock.calls[1][0]).toMatchObject({ timeoutMs: 6_500, attemptTimeoutMs: 6_500 });
    } finally { clock.mockRestore(); }
  });

  it("does not try another Gemini model after a key-quota 429", async () => {
    const generate = vi.fn().mockRejectedValue(new ProviderHttpError(429, "RESOURCE_EXHAUSTED: quota"));
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never, generate: generate as never,
    })).rejects.toMatchObject({ status: 503, code: "provider" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("records one row per Gemini model call when the backup answers", async () => {
    const rows: Record<string, unknown>[] = [];
    const callGemini = vi.fn().mockRejectedValueOnce(new ProviderHttpError(503, "gemini 503"))
      .mockResolvedValueOnce({ text: '{"text":"hello"}', inputTokens: 1, outputTokens: 1 });
    const generate = ((args: Parameters<typeof generateStructured>[0]) => generateStructured(args,
      { callGemini })) as typeof generateStructured;
    const out = await transcribeAudio(spendAdmin([], rows) as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never, generate,
    });
    expect(out.text).toBe("hello");
    expect(rows.map(({ purpose, model_id, status }) => [purpose, model_id, status])).toEqual([
      ["coach-transcribe", MODELS["coach-transcribe"], "provider_error"],
      ["coach-transcribe", LANES.capture.fallback, "ok"],
    ]);
  });

  it("does not retry a schema or governance refusal", async () => {
    for (const failure of [new SchemaRejection("bad reply"), new CallRefused("blocked")]) {
      const generate = vi.fn().mockRejectedValue(failure);
      await expect(transcribeAudio({} as never, "u1", REQ, {
        fetchOwnedObject: objectOf(wav(10), "audio/wav") as never, generate: generate as never,
      })).rejects.toBeDefined();
      expect(generate).toHaveBeenCalledTimes(1);
    }
  });

  it("lets the adapter's own HttpError through — a spend cap is not a provider outage", async () => {
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: vi.fn(async () => { throw new HttpError(429, "spend_cap", "cap"); }) as never,
    })).rejects.toMatchObject({ status: 429, code: "spend_cap" });
  });

  it("writes the transcript nowhere: the only client it is given is the one it reads with", async () => {
    const admin = { from: vi.fn(), storage: { from: vi.fn() } };
    await transcribeAudio(admin as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: generate("Add watermelon to my avoid list."),
    });
    expect(admin.from).not.toHaveBeenCalled();
  });
});

/**
 * 2026-10-06 (Gemini project denial, #gemini-fallback): a 403 PERMISSION_DENIED from Gemini is
 * not a capacity failure — lib/ai/failures.ts worthAnotherModel says no to the same-key backup on
 * purpose (every model on that key fails identically) — so the clip goes straight to OpenRouter's
 * audio-capable model once it is configured and attested.
 */
describe("transcribeAudio falls back to OpenRouter", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const openRouterReady = () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("OPENROUTER_ATTESTED", "1");
  };

  it("skips the same-key Gemini backup on a 403 PERMISSION_DENIED and answers from OpenRouter", async () => {
    openRouterReady();
    const denied = new ProviderHttpError(403,
      "gemini 403: PERMISSION_DENIED: Your project has been denied access. Please contact support.");
    const generate = vi.fn().mockRejectedValue(denied);
    const generateOpenRouter = vi.fn().mockResolvedValue({ text: "hola" });
    const out = await transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: generate as never, generateOpenRouter: generateOpenRouter as never,
    });
    expect(out.text).toBe("hola");
    // Exactly one Gemini attempt: the same-key backup is never tried (worthAnotherModel says no
    // to a 403 PERMISSION_DENIED — it would fail the identical way).
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    const args = generateOpenRouter.mock.calls[0][0] as { payload: { purpose: string };
      modelId: string; userId: string };
    expect(args.payload.purpose).toBe("coach-transcribe-openrouter");
    expect(args.userId).toBe("u1");
  });

  it("skips the same-key Gemini backup once OpenRouter is ready, for any provider failure", async () => {
    openRouterReady();
    const generate = vi.fn().mockRejectedValue(new ProviderHttpError(503, "gemini 503"));
    const generateOpenRouter = vi.fn().mockResolvedValue({ text: "bonjour" });
    const out = await transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: generate as never, generateOpenRouter: generateOpenRouter as never,
    });
    expect(out.text).toBe("bonjour");
    // 2026-10-06 (Sol review, BLOCK): the same-key backup's own 6 s minimum left almost nothing
    // of the 7.5 s total budget for OpenRouter afterwards. Once OpenRouter is ready, a 503 skips
    // the backup too (not just a 403) and goes straight to the full remaining budget on OpenRouter
    // — a genuinely different provider is worth more than a second Gemini model on the same key.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generateOpenRouter).toHaveBeenCalledTimes(1);
    expect(generateOpenRouter.mock.calls[0][0].timeoutMs).toBeGreaterThan(6_000);
  });

  it("still uses the same-key Gemini backup for an ordinary failure when OpenRouter is NOT ready", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new ProviderHttpError(503, "gemini 503"))
      .mockResolvedValueOnce({ text: "hello" });
    const generateOpenRouter = vi.fn();
    const out = await transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: generate as never, generateOpenRouter: generateOpenRouter as never,
    });
    expect(out.text).toBe("hello");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });

  it("never reaches OpenRouter when it is not configured — the original Gemini error stands", async () => {
    const denied = new ProviderHttpError(403,
      "gemini 403: PERMISSION_DENIED: Your project has been denied access. Please contact support.");
    const generate = vi.fn().mockRejectedValue(denied);
    const generateOpenRouter = vi.fn();
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: generate as never, generateOpenRouter: generateOpenRouter as never,
    })).rejects.toMatchObject({ status: 503, code: "provider" });
    expect(generateOpenRouter).not.toHaveBeenCalled();
  });

  it("never reaches OpenRouter when it fails too — the LAST error still turns into 503", async () => {
    openRouterReady();
    const denied = new ProviderHttpError(403,
      "gemini 403: PERMISSION_DENIED: Your project has been denied access. Please contact support.");
    const generate = vi.fn().mockRejectedValue(denied);
    const generateOpenRouter = vi.fn().mockRejectedValue(new ProviderHttpError(503, "openrouter 503"));
    await expect(transcribeAudio({} as never, "u1", REQ, {
      fetchOwnedObject: objectOf(wav(10), "audio/wav") as never,
      generate: generate as never, generateOpenRouter: generateOpenRouter as never,
    })).rejects.toMatchObject({ status: 503, code: "provider" });
  });
});
