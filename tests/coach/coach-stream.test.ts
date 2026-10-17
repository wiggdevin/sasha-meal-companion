/**
 * OD06 / W091: the streamed coach turn end to end on the wire — the route's stream
 * (lib/server/coach-stream.ts), the phone's reader (lib/coach-client.ts `postTurn` with `onDraft`)
 * and the OpenRouter SSE reader (lib/ai/openrouter.ts `readOpenRouterStream`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoachError, postTurn } from "@/lib/coach-client";
import { acceptsCoachStream, parseStreamEvent } from "@/lib/coach/stream-events";
import { streamTurn } from "@/lib/server/coach-stream";
import { readOpenRouterStream } from "@/lib/ai/openrouter";
import { ProviderHttpError } from "@/lib/ai/call";
import { bindAccount, unbindAccount } from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQ = { threadId: null, messageId: "m", text: "hi" };

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function events(res: Response) {
  return (await res.text()).split("\n").map(parseStreamEvent).filter((e) => e !== null);
}

describe("streamTurn (the route's stream)", () => {
  const toError = async () => ({ status: 503, body: { error: "coach_unavailable", message: "later" } });
  const timedOut = () => ({ status: 503, body: { error: "timeout", message: "late" } });

  it("sends drafts as the turn writes them, then the turn", async () => {
    const res = streamTurn({ deadlineAt: Date.now() + 5_000, toError, timedOut,
      run: async (draft) => { draft("Oats"); draft("Oats and berries"); return { threadId: "t1" }; } });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await events(res)).toEqual([
      { t: "draft", text: "Oats" }, { t: "draft", text: "Oats and berries" },
      { t: "turn", body: { threadId: "t1" } },
    ]);
  });

  it("ends with the error a plain request would answer", async () => {
    const res = streamTurn({ deadlineAt: Date.now() + 5_000, toError, timedOut,
      run: async () => { throw new Error("boom"); } });
    expect(await events(res)).toEqual([
      { t: "error", status: 503, body: { error: "coach_unavailable", message: "later" } }]);
  });

  it("ends with the retryable timeout at the response deadline, and nothing after it", async () => {
    let finish!: (v: unknown) => void;
    const res = streamTurn({ deadlineAt: Date.now() + 20, toError, timedOut,
      run: () => new Promise((resolve) => { finish = resolve; }) });
    const read = events(res);
    await new Promise((resolve) => setTimeout(resolve, 40));
    finish({ threadId: "late" });
    expect(await read).toEqual([{ t: "error", status: 503, body: { error: "timeout", message: "late" } }]);
  });

  it("is asked for by the Accept header only", () => {
    expect(acceptsCoachStream("application/x-ndjson, application/json")).toBe(true);
    expect(acceptsCoachStream("application/json")).toBe(false);
    expect(acceptsCoachStream(null)).toBe(false);
  });
});

describe("postTurn with onDraft (the phone's reader)", () => {
  beforeEach(() => { unbindAccount(); bindAccount(A); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const streamed = (chunks: string[]) => vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("accept")).toContain("application/x-ndjson");
    return new Response(body(chunks), { status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  });

  it("shows each draft and returns the turn, even when a line is split across chunks", async () => {
    vi.stubGlobal("fetch", streamed([
      "{\"t\":\"draft\",\"text\":\"Oa", "ts\"}\n{\"t\":\"draft\",\"text\":\"Oats!\"}\n",
      "{\"t\":\"turn\",\"body\":{\"threadId\":\"t1\",\"messages\":[]}}\n"]));
    const drafts: string[] = [];
    const turn = await postTurn(REQ, { onDraft: (text) => drafts.push(text) });
    expect(drafts).toEqual(["Oats", "Oats!"]);
    expect(turn.threadId).toBe("t1");
  });

  it("raises the streamed error as a CoachError", async () => {
    vi.stubGlobal("fetch", streamed([
      "{\"t\":\"error\",\"status\":429,\"body\":{\"error\":\"rate_limited\",\"message\":\"slow\",\"retryAfterSeconds\":60}}\n"]));
    const error = await postTurn(REQ, { onDraft: () => {} }).catch((e) => e);
    expect(error).toBeInstanceOf(CoachError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfterSeconds: 60 });
  });

  it("treats a stream that ends without its turn as the retryable 503", async () => {
    vi.stubGlobal("fetch", streamed(["{\"t\":\"draft\",\"text\":\"Oats\"}\n"]));
    const error = await postTurn(REQ, { onDraft: () => {} }).catch((e) => e);
    expect(error).toMatchObject({ status: 503, code: "timeout" });
  });

  it("reads a plain JSON answer (an older server, or a check before the turn) as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ threadId: "t2", messages: [] })));
    expect((await postTurn(REQ, { onDraft: () => {} })).threadId).toBe("t2");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "unauthorized", message: "Sign in" }, { status: 401 })));
    expect(await postTurn(REQ, { onDraft: () => {} }).catch((e) => e)).toMatchObject({ status: 401 });
  });

  it("asks for no stream without onDraft", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept")).toBeNull();
      return Response.json({ threadId: "t3", messages: [] });
    });
    vi.stubGlobal("fetch", fetchSpy);
    await postTurn(REQ);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("readOpenRouterStream", () => {
  const sse = (lines: string[]) => new Response(body(lines.map((l) => `${l}\n`)));

  it("joins the deltas, shows the text so far, and reads usage and cost from the last chunk", async () => {
    const seen: string[] = [];
    const result = await readOpenRouterStream(sse([
      ": OPENROUTER PROCESSING", "",
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"kind\\\":\"}}]}", "",
      "data: {\"choices\":[{\"delta\":{\"content\":\"\\\"final\\\"}\"}}]}", "",
      "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"cost\":0.002}}",
      "data: [DONE]",
    ]), (text) => seen.push(text));
    expect(result).toEqual({ text: "{\"kind\":\"final\"}", inputTokens: 10, outputTokens: 4,
      costUsd: 0.002, finishReason: "stop" });
    expect(seen).toEqual(["", "{\"kind\":", "{\"kind\":\"final\"}"]);
  });

  it("throws a provider error sent mid-stream as a ProviderHttpError with its status only", async () => {
    const error = await readOpenRouterStream(sse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\"}}]}",
      "data: {\"error\":{\"code\":503,\"message\":\"echo of the prompt\"}}",
    ]), () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error.status).toBe(503);
    expect(error.message).not.toContain("prompt");
  });

  it("refuses a stream cut off before its usage or [DONE] as a retryable 502, even with whole JSON", async () => {
    for (const lines of [
      ["data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"kind\"}}]}"],
      ["data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"kind\\\":\\\"final\\\"}\"}}]}"],
    ]) {
      const error = await readOpenRouterStream(sse(lines), () => {}).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error.status).toBe(502);
    }
  });
});
