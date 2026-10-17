/**
 * OD06 / W091: the streamed coach turn's wire format, shared by the route and the phone.
 *
 * A phone that sends `Accept: application/x-ndjson` gets one JSON event per line:
 *
 *   {"t":"draft","text":"…"}                 the final step's reply so far; "" clears it
 *   {"t":"turn","body":{…}}                  the whole turn, exactly the JSON body a plain request gets
 *   {"t":"error","status":503,"body":{…}}    the error a plain request would have answered
 *
 * `turn` or `error` is always the last event. Checks that fail before the turn starts (sign-in,
 * the rate limit, a bad body) answer with their usual status and JSON body, never a stream.
 * A draft is a preview only: it is never saved, never carries a card, and the turn replaces it.
 *
 * Pure. No I/O.
 */

export const COACH_STREAM_TYPE = "application/x-ndjson";

export type CoachErrorBody = { error?: string; message?: string; retryAfterSeconds?: number };

export type CoachStreamEvent =
  | { t: "draft"; text: string }
  | { t: "turn"; body: unknown }
  | { t: "error"; status: number; body: CoachErrorBody };

export function encodeStreamEvent(event: CoachStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** One line of the stream, or null for a blank or unreadable line (skipped, never fatal). */
export function parseStreamEvent(line: string): CoachStreamEvent | null {
  if (line.trim() === "") return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.t === "draft" && typeof event.text === "string") return { t: "draft", text: event.text };
  if (event.t === "turn" && event.body && typeof event.body === "object") {
    return { t: "turn", body: event.body };
  }
  if (event.t === "error" && typeof event.status === "number") {
    const body = event.body && typeof event.body === "object" ? event.body as CoachErrorBody : {};
    return { t: "error", status: event.status, body };
  }
  return null;
}

/** Whether a request asked for the streamed turn. */
export function acceptsCoachStream(accept: string | null): boolean {
  return (accept ?? "").split(",").some((part) => part.trim().split(";")[0] === COACH_STREAM_TYPE);
}
