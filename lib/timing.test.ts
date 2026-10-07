import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { DEADLINES } from "@/lib/fetch-with-deadline";
import {
  beginRun, buffered, discardRun, flushTimings, FLUSH_DELAY_MS, mark, markMs, MAX_BATCH,
  MAX_BATCH_BYTES, measure, percentile, resetTimings, summarize, TIMING_PATHS, TIMING_STEPS,
  TIMINGS_URL,
} from "@/lib/timing";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const RUN = "9f1d2f7a-0c6e-4a1e-9d3b-1c2f5d8a7b10";

/** performance.now() is the clock lib/timing.ts reads; a scripted one makes every ms exact. */
function clock(...values: number[]) {
  const spy = vi.spyOn(performance, "now");
  for (const v of values) spy.mockReturnValueOnce(v);
  return spy;
}

afterEach(() => {
  resetTimings();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the vocabulary", () => {
  it("names the nine paths of spec §1, in the spec's order", () => {
    expect(TIMING_PATHS).toEqual(["barcode", "label", "photo", "voice", "text", "search-log",
      "meal-log", "coach-turn", "coach-action"]);
  });

  it("names the capture hops and the coach hops as steps", () => {
    expect(TIMING_STEPS).toEqual(["decode", "lookup", "sign", "upload", "propose", "model",
      "ground", "confirm-shown", "commit", "card-visible",
      "dictation", "attach", "sent", "first-text", "reply-done", "action-applied", "action-failed",
      "action-undone"]);
  });
});

describe("mark and measure", () => {
  it("turns one mark per hop into one row per step, in mark order", () => {
    clock(0, 120, 400, 900);
    mark("barcode", "decode");
    mark("barcode", "lookup");
    mark("barcode", "commit");
    const rows = measure("barcode", RUN);
    expect(rows.map((r) => [r.step, r.ms])).toEqual([
      ["decode", 120], ["lookup", 280], ["commit", 500],
    ]);
    expect(rows.every((r) => r.run_id === RUN && r.path === "barcode")).toBe(true);
  });

  it("stamps each row with an instant and a device, and buffers them for the post", () => {
    clock(0, 50);
    mark("search-log", "commit");
    const [row] = measure("search-log", RUN);
    expect(Date.parse(row.at)).not.toBeNaN();
    expect(typeof row.device).toBe("string");
    expect(buffered()).toHaveLength(1);
  });

  it("carries the server's own model and ground ms into the same run", () => {
    clock(0, 300);
    mark("photo", "propose");
    const rows = measure("photo", RUN, { model: 1800, ground: 240 });
    expect(rows.map((r) => [r.step, r.ms])).toEqual([
      ["propose", 300], ["model", 1800], ["ground", 240],
    ]);
  });

  it("closes the run, so a second measure of the same path emits nothing", () => {
    clock(0, 10);
    mark("text", "propose");
    expect(measure("text", RUN)).toHaveLength(1);
    expect(measure("text", RUN)).toEqual([]);
  });

  it("keeps two paths apart while both are open", () => {
    clock(0, 5, 20, 30, 40);
    mark("barcode", "decode");
    mark("coach-turn", "sent");
    mark("barcode", "lookup");
    expect(measure("coach-turn", RUN).map((r) => r.step)).toEqual(["sent"]);
    expect(measure("barcode", RUN).map((r) => r.step)).toEqual(["decode", "lookup"]);
  });

  it("re-marking a retried step re-times it rather than adding a second row", () => {
    clock(0, 100, 250);
    mark("voice", "upload");
    mark("voice", "upload");
    const rows = measure("voice", RUN);
    expect(rows).toHaveLength(1);
    expect(rows[0].ms).toBe(150);
  });

  it("never emits a negative duration when the clock goes backwards", () => {
    clock(500, 100);
    mark("meal-log", "commit");
    expect(measure("meal-log", RUN)[0].ms).toBe(0);
  });
});

describe("the batched poster", () => {
  it("posts the buffered rows to /api/timings and empties the buffer", async () => {
    clock(0, 40);
    mark("search-log", "commit");
    measure("search-log", RUN);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await flushTimings({ fetchImpl });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(TIMINGS_URL);
    expect(JSON.parse(String((init as RequestInit).body)).rows[0]).toMatchObject({
      run_id: RUN, path: "search-log", step: "commit", ms: 40,
    });
    expect(buffered()).toHaveLength(0);
  });

  it("does nothing at all with an empty buffer", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await flushTimings({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows a failed post — telemetry never breaks the screen she is on", async () => {
    clock(0, 40);
    mark("search-log", "commit");
    measure("search-log", RUN);
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(flushTimings({ fetchImpl })).resolves.toBeUndefined();
    expect(buffered()).toHaveLength(0);
  });

  it("flushes on a timer after a run instead of one post per step", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    clock(0, 40, 90);
    mark("search-log", "commit");
    mark("search-log", "card-visible");
    measure("search-log", RUN, undefined, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).rows)
      .toHaveLength(2);
  });

  it("posts at once rather than buffering past the batch ceiling", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    vi.spyOn(performance, "now").mockReturnValue(0);
    for (let i = 0; i < MAX_BATCH; i += 1) {
      mark("barcode", "lookup");
      measure("barcode", RUN, undefined, { fetchImpl });
    }
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(buffered()).toHaveLength(0);
  });
});

/**
 * Grok 4.6 MEDIUM 12: `open` was keyed by path, so two runs of one path — she scans a second
 * barcode while the first is still resolving — shared one bag of marks, and whichever closed
 * first took both runs' steps under one run id.
 */
/**
 * Grok pass 2, HIGH 4: fifty rows carrying a 120-character `device` serialize past the route's
 * 8 KB limit, so the whole batch came back 413 — and `flushTimings` never looked at the status,
 * so it neither knew nor said.
 */
const LONG_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/18.2 Mobile";

describe("the batch fits what the route accepts", () => {
  /**
   * The widest rows the client can produce: longest path and step, and a `device` at the full
   * 120 characters it is capped to. One under MAX_BATCH, so nothing auto-flushes underneath us.
   */
  function widestRows() {
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("navigator", { userAgent: LONG_UA });
    for (let i = 0; i < MAX_BATCH - 1; i += 1) {
      mark("coach-action", "action-applied");
      measure("coach-action", "9f1d2f7a-0c6e-4a1e-9d3b-1c2f5d8a7b10");
    }
  }

  it("never posts a body past the route's limit, however wide the rows", async () => {
    const posted: string[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      posted.push(String(init?.body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    widestRows();
    // The very thing that used to break: one post of everything would be over 8 KB.
    expect(new TextEncoder().encode(JSON.stringify({ rows: buffered() })).length)
      .toBeGreaterThan(MAX_BATCH_BYTES);
    await flushTimings({ fetchImpl });
    expect(posted.length).toBeGreaterThan(1);
    for (const body of posted) {
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  /**
   * Panel round 7, item 1: fifty maximum-shaped rows reached the route as twenty-six. A flush
   * already running — `measure` forces one the moment the buffer is full — took the whole buffer,
   * posted its first body and was still awaiting the rest when the caller's own flush found
   * nothing left and returned. Everything past that first body was counted as sent and was not.
   */
  it("delivers all fifty rows even when a forced flush is already running", async () => {
    let delivered = 0;
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      delivered += (JSON.parse(String(init?.body)) as { rows: unknown[] }).rows.length;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("navigator", { userAgent: LONG_UA });
    for (let i = 0; i < MAX_BATCH; i += 1) {
      mark("coach-action", "action-applied");
      // The last of these trips the forced flush inside `measure`, with this same fetch.
      measure("coach-action", "9f1d2f7a-0c6e-4a1e-9d3b-1c2f5d8a7b10", undefined, { fetchImpl });
    }
    await flushTimings({ fetchImpl });
    expect(delivered).toBe(MAX_BATCH);
    expect(buffered()).toHaveLength(0);
  });

  it("sends every row it took, across as many posts as that needs", async () => {
    let sent = 0;
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      sent += (JSON.parse(String(init?.body)) as { rows: unknown[] }).rows.length;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    widestRows();
    const queued = buffered().length;
    await flushTimings({ fetchImpl });
    expect(sent).toBe(queued);
    expect(buffered()).toHaveLength(0);
  });

  it("stays under what the route accepts", () => {
    expect(MAX_BATCH_BYTES).toBeLessThanOrEqual(8 * 1024);
  });
});

/**
 * Grok pass 3, MEDIUM 5: `post` was a bare keepalive fetch with no deadline, so one hung POST
 * pinned the chain and every later flush queued behind it while the buffer grew. And chaining
 * with `.then` meant a rejected flush skipped the next one's callback entirely.
 */
describe("the flush chain cannot be pinned or broken", () => {
  it("does not hold the next flush past the timings deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const hung = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const answers = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    mark("barcode", "lookup");
    measure("barcode", RUN);
    const first = flushTimings({ fetchImpl: hung });
    await vi.advanceTimersByTimeAsync(0);
    expect(hung).toHaveBeenCalledTimes(1);

    // Buffered while the first post hangs, so this flush has rows of its own to send.
    mark("search-log", "commit");
    measure("search-log", RUN);
    const second = flushTimings({ fetchImpl: answers });
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEADLINES.timings + 100);
    await first;
    await second;
    expect(answers).toHaveBeenCalledTimes(1);
  });

  it("posts keepalive, and so must send no signal at all", async () => {
    clock(0, 10);
    mark("barcode", "lookup");
    measure("barcode", RUN);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await flushTimings({ fetchImpl });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).keepalive).toBe(true);
    expect((init as RequestInit).signal ?? null).toBeNull();
  });

  it("still posts after a flush whose fetch rejected", async () => {
    clock(0, 10, 20, 30);
    mark("barcode", "lookup");
    measure("barcode", RUN);
    const broken = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await flushTimings({ fetchImpl: broken });

    mark("search-log", "commit");
    measure("search-log", RUN);
    const answers = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await flushTimings({ fetchImpl: answers });
    expect(answers).toHaveBeenCalledTimes(1);
  });

  it("says so when there is no fetch to post with, rather than losing the rows in silence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clock(0, 10);
    mark("barcode", "lookup");
    measure("barcode", RUN);
    vi.stubGlobal("fetch", undefined);
    await flushTimings();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/no fetch|dropped/i);
  });
});

describe("a row too big to split", () => {
  it("cannot be produced: every field this module writes is bounded", async () => {
    // The drop branch in `batches` is defensive. Nothing `mark`/`measure` can build reaches the
    // limit — the device string is capped, and everything else is fixed-shape — so the flush
    // never has cause to lose a measurement, whatever the browser reports as its user agent.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("navigator", { userAgent: "x".repeat(10_000) });
    mark("barcode", "lookup");
    measure("barcode", RUN);
    const [row] = buffered();
    expect(new TextEncoder().encode(JSON.stringify({ rows: [row] })).length)
      .toBeLessThan(MAX_BATCH_BYTES);
    await flushTimings({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("a post the route refuses", () => {
  it("says so once and drops the rows rather than retrying them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clock(0, 40);
    mark("search-log", "commit");
    measure("search-log", RUN);
    const fetchImpl = vi.fn(async () => new Response("too big", { status: 413 })) as unknown as typeof fetch;
    await flushTimings({ fetchImpl });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/413/);
    expect(buffered()).toHaveLength(0);
    await flushTimings({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("says nothing at all when the route takes them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clock(0, 40);
    mark("search-log", "commit");
    measure("search-log", RUN);
    await flushTimings({ fetchImpl: vi.fn(async () => new Response(null, { status: 202 })) as unknown as typeof fetch });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("two runs of one path at once", () => {
  it("keeps their steps and their ids apart", () => {
    clock(0, 10, 100, 140, 200, 260);
    const first = beginRun("barcode");
    mark("barcode", "decode", first);
    const second = beginRun("barcode");
    mark("barcode", "decode", second);
    mark("barcode", "lookup", first);
    mark("barcode", "lookup", second);

    const a = measure("barcode", first);
    const b = measure("barcode", second);
    expect(a.map((r) => r.step)).toEqual(["decode", "lookup"]);
    expect(b.map((r) => r.step)).toEqual(["decode", "lookup"]);
    expect(a[0].run_id).not.toBe(b[0].run_id);
    expect(new Set(buffered().map((r) => r.run_id)).size).toBe(2);
  });

  it("keeps a handed-back handle usable for the rest of its own run", () => {
    clock(0, 50, 120);
    const run = mark("barcode", "decode");
    mark("barcode", "lookup", run);
    expect(measure("barcode", run).map((r) => [r.step, r.ms]))
      .toEqual([["decode", 50], ["lookup", 70]]);
  });

  it("keeps the bare mark/measure pair working for one run at a time", () => {
    clock(0, 30, 90);
    mark("search-log", "commit");
    mark("search-log", "card-visible");
    const rows = measure("search-log", RUN);
    expect(rows.map((r) => r.step)).toEqual(["commit", "card-visible"]);
    expect(rows.every((r) => r.run_id === RUN)).toBe(true);
  });

  it("files a known duration against the run it was given", () => {
    clock(0, 10, 20, 30);
    const first = beginRun("photo");
    const second = beginRun("photo");
    mark("photo", "propose", first);
    markMs("photo", "model", 1800, first);
    markMs("photo", "model", 90, second);
    expect(measure("photo", first).find((r) => r.step === "model")?.ms).toBe(1800);
    expect(measure("photo", second).find((r) => r.step === "model")?.ms).toBe(90);
  });
});

/** Grok pass 2, LOW 18: a run nobody will close must not leave its marks for the next one. */
describe("discardRun", () => {
  it("buffers nothing and leaves the path clean for the next run", () => {
    clock(0, 10, 100, 140);
    mark("photo", "sign");
    mark("photo", "upload");
    discardRun("photo");
    expect(buffered()).toHaveLength(0);

    mark("photo", "sign");
    expect(measure("photo", RUN).map((r) => r.step)).toEqual(["sign"]);
  });

  it("forgets a named run without touching the one still open", () => {
    clock(0, 10, 20, 30, 40);
    const abandoned = beginRun("label");
    mark("label", "upload", abandoned);
    const live = beginRun("label");
    mark("label", "upload", live);
    discardRun("label", abandoned);
    expect(measure("label", live)).toHaveLength(1);
  });

  it("does nothing at all when there is no run to forget", () => {
    expect(() => discardRun("voice")).not.toThrow();
    expect(buffered()).toHaveLength(0);
  });
});

describe("percentile", () => {
  /**
   * Grok pass 2, LOW 14: nearest-rank made the p95 of ten runs the slowest of the ten, while the
   * comment beside it claimed the opposite. Ten runs is exactly what the budgets in spec §6 are
   * measured over, so the number that judges them was the worst case by construction. Linear
   * interpolation between ranks gives a p95 the maximum does not decide on its own.
   */
  it("matches the worked example in its own doc comment", () => {
    // Panel round 7, item 2: the comment and the number have to be the same statement.
    const ten = [100, 133, 166, 200, 233, 266, 300, 333, 366, 400];
    expect(percentile(ten, 95)).toBeCloseTo(384.7, 1);
    expect(percentile(ten, 0)).toBe(100);
    expect(percentile(ten, 100)).toBe(400);
  });

  it("interpolates between ranks rather than taking the worst run", () => {
    const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(ten, 50)).toBe(55);
    expect(percentile(ten, 95)).toBeCloseTo(95.5, 6);
    expect(percentile(ten, 95)).toBeLessThan(Math.max(...ten));
  });

  it("still reaches the ends: p0 is the fastest run and p100 the slowest", () => {
    const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(ten, 0)).toBe(10);
    expect(percentile(ten, 100)).toBe(100);
  });

  it("is not moved by the order the runs arrived in", () => {
    expect(percentile([100, 10, 50, 30], 50)).toBe(percentile([10, 30, 50, 100], 50));
  });

  it("reads a single run as both its own p50 and its own p95", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("is null with nothing measured", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("summarize", () => {
  const rows = (...msByStep: [string, number[]][]) =>
    msByStep.flatMap(([step, values]) =>
      values.map((ms) => ({ path: "barcode", step, ms })));

  it("gives p50, p95 and n per path and step", () => {
    expect(summarize(rows(["decode", [10, 20, 30]], ["lookup", [100, 900]]))).toEqual([
      { path: "barcode", step: "decode", p50: 20, p95: 29, n: 3 },
      { path: "barcode", step: "lookup", p50: 500, p95: 860, n: 2 },
    ]);
  });

  it("buckets by path as well as step, in the order a run walks them", () => {
    const mixed = [
      { path: "search-log", step: "commit", ms: 5 },
      { path: "barcode", step: "commit", ms: 7 },
      { path: "barcode", step: "decode", ms: 9 },
    ];
    expect(summarize(mixed).map((r) => [r.path, r.step])).toEqual([
      ["barcode", "decode"], ["barcode", "commit"], ["search-log", "commit"],
    ]);
  });

  it("summarises what measure() just buffered, without a database in between", () => {
    clock(0, 120, 400);
    mark("barcode", "decode");
    mark("barcode", "lookup");
    measure("barcode", RUN);
    expect(summarize(buffered())).toEqual([
      { path: "barcode", step: "decode", p50: 120, p95: 120, n: 1 },
      { path: "barcode", step: "lookup", p50: 280, p95: 280, n: 1 },
    ]);
  });

  it("is empty for no rows at all", () => {
    expect(summarize([])).toEqual([]);
  });
});
