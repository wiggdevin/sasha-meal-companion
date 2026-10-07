/**
 * T7 §2 on the phone: record, sign, upload, post — through the SAME sign/upload helper the FAB
 * voice path uses (`lib/capture-client.ts`), so the object lifecycle and the 24 h deletion are
 * the capture bucket's, not a second copy of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEADLINES } from "@/lib/fetch-with-deadline";
import { SLOW_COPY } from "@/lib/coach/dictation";
import {
  TRANSCRIBE_URL, UPLOAD_FAILED_COPY, transcribeClip,
} from "@/lib/coach-transcribe-client";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const PATH = "media/u1/3f1b1a2c-0000-4000-8000-000000000030.m4a";
const clip = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });

type Call = { url: string; init: RequestInit };

/** A stack of answers, one per call, with the requests it saw. */
function stubFetch(answers: (Response | Error | "never")[]): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const impl = vi.fn((url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const answer = answers[calls.length - 1];
    if (answer === "never") return new Promise<Response>(() => {});
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer as Response);
  });
  return Object.assign(impl as unknown as typeof fetch, { calls });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const signed = () => json({ path: PATH, uploadUrl: "https://storage.test/put", expiresInSeconds: 60 });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("transcribeClip", () => {
  it("signs, uploads and posts the path — three calls, in that order", async () => {
    const fetchImpl = stubFetch([signed(), new Response(null, { status: 200 }),
      json({ text: "Add watermelon to my avoid list.", ms: 1100 })]);
    const outcome = await transcribeClip(clip(), { fetchImpl });
    expect(outcome).toEqual({ ok: true, text: "Add watermelon to my avoid list.", ms: 1100 });
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([
      "/api/media/sign", "https://storage.test/put", TRANSCRIBE_URL,
    ]);
    expect(fetchImpl.calls[0].init.method).toBe("POST");
    expect(fetchImpl.calls[1].init.method).toBe("PUT");
  });

  it("posts the server's own path and nothing else", async () => {
    const fetchImpl = stubFetch([signed(), new Response(null, { status: 200 }),
      json({ text: "hi", ms: 10 })]);
    await transcribeClip(clip(), { fetchImpl });
    expect(JSON.parse(String(fetchImpl.calls[2].init.body))).toEqual({ path: PATH });
  });

  it("declares the clip as audio when it signs", async () => {
    const fetchImpl = stubFetch([signed(), new Response(null, { status: 200 }),
      json({ text: "hi", ms: 10 })]);
    await transcribeClip(clip(), { fetchImpl });
    expect(JSON.parse(String(fetchImpl.calls[0].init.body))).toMatchObject({
      kind: "audio", contentType: "audio/mp4",
    });
  });

  it("shows the slow line and never the transcript when the 8 s budget runs out", async () => {
    const fetchImpl = stubFetch([signed(), new Response(null, { status: 200 }), "never"]);
    const outcome = transcribeClip(clip(), { fetchImpl });
    await vi.advanceTimersByTimeAsync(DEADLINES.transcribe + 10);
    expect(await outcome).toEqual({ ok: false, message: SLOW_COPY });
  });

  it("aborts the work it gave up on, so the server stops spending", async () => {
    const fetchImpl = stubFetch([signed(), new Response(null, { status: 200 }), "never"]);
    const outcome = transcribeClip(clip(), { fetchImpl });
    await vi.advanceTimersByTimeAsync(DEADLINES.transcribe + 10);
    expect(await outcome).toEqual({ ok: false, message: SLOW_COPY });
    const post = fetchImpl.calls[2].init.signal as AbortSignal;
    expect(post.aborted).toBe(true);
  });

  it("aborts the upload too when the upload is what is hanging", async () => {
    // The upload's own budget is 20 s, well past the 8 s she is told about, so this is the hop
    // that proves the one deadline reaches every call under it.
    const fetchImpl = stubFetch([signed(), "never"]);
    const outcome = transcribeClip(clip(), { fetchImpl });
    await vi.advanceTimersByTimeAsync(DEADLINES.transcribe + 10);
    expect(await outcome).toEqual({ ok: false, message: SLOW_COPY });
    expect((fetchImpl.calls[1].init.signal as AbortSignal).aborted).toBe(true);
  });

  it("keeps the upload's own line when the upload is what failed", async () => {
    const fetchImpl = stubFetch([signed(), new Response(null, { status: 500 })]);
    expect(await transcribeClip(clip(), { fetchImpl }))
      .toEqual({ ok: false, message: UPLOAD_FAILED_COPY });
  });

  it("maps a refused transcribe onto one line, never the server's own words", async () => {
    const fetchImpl = stubFetch([signed(), new Response(null, { status: 200 }),
      json({ error: "unsupported_media", message: "declared audio/mp4 but the bytes are image/png" }, 415)]);
    const outcome = await transcribeClip(clip(), { fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.message).not.toContain("image/png");
  });
});
