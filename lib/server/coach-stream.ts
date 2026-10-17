/**
 * OD06 / W091: `POST /api/coach` as a stream (wire format: lib/coach/stream-events.ts).
 *
 * The turn itself is unchanged: the route runs it exactly as for a plain request, with one more
 * dependency, the draft sink (lib/server/coach-turn/draft.ts). This module only carries what the
 * turn produces to the phone as it happens: draft text while the final step is written, then the
 * turn, or the error a plain request would have answered. The response deadline still holds: past
 * `deadlineAt` the stream ends with the same retryable 503 the plain route sends, and the work
 * left running is left to finish (a saved turn is replayed by the phone's retry, as before).
 */

import { encodeStreamEvent, COACH_STREAM_TYPE, type CoachErrorBody, type CoachStreamEvent }
  from "@/lib/coach/stream-events";
import type { DraftSink } from "@/lib/server/coach-turn/draft";

export type StreamedTurn = {
  /** Runs the turn with the sink; resolves with the turn's JSON body. */
  run: (draft: DraftSink) => Promise<unknown>;
  /** The status and body a plain request would answer for this error. */
  toError: (e: unknown) => Promise<{ status: number; body: CoachErrorBody }>;
  /** When the route must have answered (epoch ms), and what it answers then. */
  deadlineAt: number;
  timedOut: () => { status: number; body: CoachErrorBody };
};

export function streamTurn({ run, toError, deadlineAt, timedOut }: StreamedTurn): Response {
  const encoder = new TextEncoder();
  let finished = false;
  let push: (event: CoachStreamEvent) => void = () => {};
  let end: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (event) => {
        if (finished) return;
        try { controller.enqueue(encoder.encode(encodeStreamEvent(event))); }
        catch { finished = true; }
      };
      end = () => {
        if (finished) return;
        finished = true;
        try { controller.close(); } catch { /* already closed by the reader */ }
      };
    },
    cancel() { finished = true; },
  });

  const last = (event: CoachStreamEvent) => { push(event); end(); };
  const timer = setTimeout(() => { last({ t: "error", ...timedOut() }); },
    Math.max(0, deadlineAt - Date.now()));
  const work = run((text) => push({ t: "draft", text }));
  void work.then(
    (turn) => { last({ t: "turn", body: turn }); },
    async (e: unknown) => {
      const error = await toError(e).catch(() => ({
        status: 500, body: { error: "internal", message: "Something went wrong." } }));
      last({ t: "error", ...error });
    },
  ).finally(() => clearTimeout(timer));

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": `${COACH_STREAM_TYPE}; charset=utf-8`,
      "cache-control": "no-store",
      // Proxies must pass each event on as it is written, not hold the body until it ends.
      "x-accel-buffering": "no",
    },
  });
}
