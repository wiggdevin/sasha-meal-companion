import { afterEach, describe, expect, it, vi } from "vitest";
import { DEADLINES, DeadlineExceeded, fetchWithDeadline, isDeadline,
  pendingDeadlines, withinBudget } from "@/lib/fetch-with-deadline";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** A server that never answers — the stub AC2 measures every surface against. */
function neverAnswers(): typeof fetch {
  return vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
  })) as unknown as typeof fetch;
}

describe("the deadline table", () => {
  it("is the one in spec §2, to the millisecond", () => {
    expect(DEADLINES).toEqual({
      sign: 5_000, upload: 20_000, propose: 25_000, barcode: 8_000,
      commit: 10_000, coach: 40_000, search: 6_000, prefs: 6_000,
      timings: 10_000, transcribe: 8_000,
      // Coach Undo records, reads and server Undos (lib/coach/undo-client.ts).
      undo: 10_000,
      // A Plan-sheet chip, POST /api/plan/ideas (lib/plan/ideas-client.ts), 2026-10-08.
      ideas: 9_000,
      // Sign-in through the app's IP-limited routes (lib/sign-in-client.ts), W052.
      signIn: 10_000,
      // Self-serve account deletion (lib/account-delete-client.ts), W057: past the route's 60 s.
      accountDelete: 65_000,
      // The advisory check before "Day fully logged" (lib/day-completeness-client.ts), W142.
      nudge: 4_000,
      // The build flow's store search and its deck ordering (UI makeover W8).
      places: 12_000, rank: 5_000,
    });
  });
});

describe("fetchWithDeadline", () => {
  it("passes a fast answer straight through", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithDeadline("barcode", "/api/foods/barcode", { method: "POST" }, { fetchImpl });
    expect(res.status).toBe(200);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/foods/barcode");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("leaves no deadline behind when the call answers", async () => {
    // The timer was cleared but the promise it belonged to was never settled, so every answered
    // call left a pending promise with the race still subscribed to it (Grok pass 16, MEDIUM 3).
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    for (let i = 0; i < 3; i += 1) {
      await fetchWithDeadline("commit", "/api/log/commit", { method: "POST" }, { fetchImpl });
    }
    await Promise.resolve();
    expect(pendingDeadlines()).toBe(0);
  });

  it("bounds the body, not only the headers", async () => {
    // A 200 whose body never arrives holds the caller open exactly as surely as a request that
    // never answers — and the commit path holds the entry with it, past its own budget, while
    // this call believes it succeeded (Grok pass 25, MEDIUM 2).
    vi.useFakeTimers();
    const stalls = vi.fn(async () => new Response(
      new ReadableStream({ start() { /* headers, then nothing */ } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

    const res = await fetchWithDeadline("commit", "/api/log/commit", {}, { fetchImpl: stalls });
    expect(res.status).toBe(200);
    const caught = res.json().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEADLINES.commit + 1_000);

    expect(await caught).toBeInstanceOf(DeadlineExceeded);
  });

  it("hands back the real Response, whose own properties still work", async () => {
    // The wrapper that bounded the body was a Proxy, and a native Response's `ok`, `status` and
    // `headers` are prototype getters that demand the real object as `this`. Through the proxy
    // they threw, every caller's `res.ok` went to its catch, and search on the phone answered
    // nothing at all while the API was answering 200 (device regression on 4920024).
    const answered = new Response(JSON.stringify({ hits: [1, 2] }), {
      status: 201, headers: { "content-type": "application/json", "x-test": "yes" },
    });
    const fetchImpl = vi.fn(async () => answered) as unknown as typeof fetch;

    const res = await fetchWithDeadline("search", "/api/foods/search", {}, { fetchImpl });

    // The very object the browser made. Node's own Response tolerates a proxy's receiver, so
    // nothing but this identity can stand for what Chromium and WebKit refuse.
    expect(res).toBe(answered);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-test")).toBe("yes");
    expect(await res.json()).toEqual({ hits: [1, 2] });
  });

  it("throws a typed deadline error at the budget, not a second later", async () => {
    vi.useFakeTimers();
    const promise = fetchWithDeadline("barcode", "/api/foods/barcode", {}, { fetchImpl: neverAnswers() });
    const caught = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEADLINES.barcode - 1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await caught;
    expect(error).toBeInstanceOf(DeadlineExceeded);
    expect(isDeadline(error)).toBe(true);
    expect((error as DeadlineExceeded).budget).toBe("barcode");
    expect((error as DeadlineExceeded).ms).toBe(DEADLINES.barcode);
  });

  it("gives up on a server that ignores the abort, so the budget is a real promise", async () => {
    vi.useFakeTimers();
    // No abort listener at all: a stubbed 60 s server that never notices being cancelled.
    const deaf = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const caught = fetchWithDeadline("search", "/api/foods/search", {}, { fetchImpl: deaf })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEADLINES.search);
    expect(await caught).toBeInstanceOf(DeadlineExceeded);
  });

  it("aborts the request it gave up on", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl = vi.fn((_i: unknown, init?: RequestInit) => new Promise<Response>(() => {
      init?.signal?.addEventListener("abort", () => { aborted = true; });
    })) as unknown as typeof fetch;
    const caught = fetchWithDeadline("sign", "/api/media/sign", {}, { fetchImpl }).catch(() => null);
    await vi.advanceTimersByTimeAsync(DEADLINES.sign);
    await caught;
    expect(aborted).toBe(true);
  });

  it("clears its timer on a fast answer, so nothing fires afterwards", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    await fetchWithDeadline("commit", "/api/log/commit", {}, { fetchImpl });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a caller's own abort as an AbortError — a superseded keystroke is not a timeout", async () => {
    const ac = new AbortController();
    const fetchImpl = neverAnswers();
    const caught = fetchWithDeadline("search", "/api/foods/search", { signal: ac.signal }, { fetchImpl })
      .catch((e: unknown) => e);
    ac.abort();
    const error = await caught;
    expect(isDeadline(error)).toBe(false);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("refuses a request whose caller has already aborted, without calling fetch", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      fetchWithDeadline("search", "/api/foods/search", { signal: ac.signal }, { fetchImpl })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("unlinks the caller's signal once the call is over, on a platform without AbortSignal.any", async () => {
    // One long-lived controller across many calls — a search box's own — would otherwise collect
    // one listener per keystroke, each holding that call's AbortController alive (Grok pass 3).
    const any = (AbortSignal as { any?: unknown }).any;
    try {
      (AbortSignal as { any?: unknown }).any = undefined;
      const ac = new AbortController();
      const removed = vi.spyOn(ac.signal, "removeEventListener");
      const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
      await fetchWithDeadline("search", "/api/foods/search", { signal: ac.signal }, { fetchImpl });
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      (AbortSignal as { any?: unknown }).any = any;
    }
  });

  it("never hands a keepalive request a signal — WebKit drops that pair", async () => {
    // A keepalive fetch is the browser's to finish, including after the page goes away, and
    // Safari/WebKit refuses or silently drops one that carries an AbortSignal. On a phone-first
    // PWA that means the post never lands at all (Grok pass 4, HIGH 1).
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await fetchWithDeadline("timings", "/api/timings", { method: "POST", keepalive: true }, { fetchImpl });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).keepalive).toBe(true);
    expect((init as RequestInit).signal ?? null).toBeNull();
  });

  it("still holds a keepalive request to its budget, with the race alone", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const caught = fetchWithDeadline("timings", "/api/timings", { keepalive: true }, { fetchImpl })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DEADLINES.timings);
    expect(isDeadline(await caught)).toBe(true);
  });

  it("leaves no unhandled rejection when the loser of the race rejects later", async () => {
    // `Promise.race` does not unsubscribe: the fetch this call abandoned still settles, and a
    // rejection nobody is listening to takes down a Node process and logs an error in the browser
    // (Grok pass 5, MEDIUM 5). Both paths are checked — keepalive, which carries no signal, and
    // the abortable one, whose abort is itself what rejects.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      vi.useFakeTimers();
      for (const init of [{ keepalive: true }, {}]) {
        const fetchImpl = vi.fn(() => new Promise<Response>((_res, rej) => {
          setTimeout(() => rej(new TypeError("Failed to fetch")), DEADLINES.timings + 500);
        })) as unknown as typeof fetch;
        const caught = fetchWithDeadline("timings", "/api/timings", init, { fetchImpl })
          .catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(DEADLINES.timings);
        expect(isDeadline(await caught)).toBe(true);
        await vi.advanceTimersByTimeAsync(600);
      }
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("lets a real transport failure through untouched", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(fetchWithDeadline("coach", "/api/coach", {}, { fetchImpl }))
      .rejects.toBeInstanceOf(TypeError);
  });
});

/**
 * The budget is one budget: the headers and the body share it, and what it gives up on it lets
 * go of quietly (Grok pass 26, MEDIUM 4).
 */
describe("what the budget does with what it abandons", () => {
  it("gives the body only what is left of the call's own budget", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(
      new ReadableStream({ start() { /* headers, then nothing */ } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

    const res = await fetchWithDeadline("commit", "/api/log/commit", {}, { fetchImpl });
    // The header timer is done with before she ever sees the response.
    expect(vi.getTimerCount()).toBe(0);
    // She looks at something else for nine seconds, and only then is the body read.
    await vi.advanceTimersByTimeAsync(DEADLINES.commit - 1_000);
    const caught = res.json().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_001);

    expect(await caught).toBeInstanceOf(DeadlineExceeded);
  });

  it("says so when work it gave up on answers later", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    let answer: ((value: string) => void) | null = null;
    const work = new Promise<string>((resolve) => { answer = resolve; });

    const result = withinBudget(work, "commit", "gave up");
    await vi.advanceTimersByTimeAsync(DEADLINES.commit + 1);
    expect(await result).toBe("gave up");

    (answer as unknown as (value: string) => void)("the answer, too late");
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });

  it("leaves no unhandled rejection when a read loses the race", async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown): void => { seen.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const fetchImpl = vi.fn(async () => new Response(
        new ReadableStream({
          start(c) { setTimeout(() => c.error(new Error("too late")), DEADLINES.commit + 500); },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

      const res = await fetchWithDeadline("commit", "/api/log/commit", {}, { fetchImpl });
      const caught = res.json().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(DEADLINES.commit + 1);
      expect(await caught).toBeInstanceOf(DeadlineExceeded);

      // The read this gave up on answers afterwards, and nobody is waiting for it.
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
