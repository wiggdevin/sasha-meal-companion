/**
 * The shared route edge. Errors are `{ error, message }` and never echo the
 * request body (architecture.md §5, spec "API changes").
 */

import type { ZodType } from "zod";
import { HttpError } from "@/lib/server/auth";

function json(status: number, body: { error: string; message: string },
  retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfterSeconds !== undefined) headers["retry-after"] = String(retryAfterSeconds);
  return new Response(JSON.stringify(body), { status, headers });
}

/** A Retry-After an HttpError carries (the rate limiter's 429 and 503), when it is a whole number. */
function retryAfterOf(e: HttpError): number | undefined {
  const value = (e as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Only a cause's name, code and message: never its details, hint or the request body. */
function causeSummary(cause: unknown): Record<string, string> | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const summary: Record<string, string> = {};
  for (const key of ["name", "code", "message"] as const) {
    const value = (cause as Record<string, unknown>)[key];
    if (typeof value === "string") summary[key] = value;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

export function jsonError(e: unknown): Response {
  if (e instanceof HttpError) {
    // A 5xx is ours to fix: leave one structured line so the cause is traceable (audit FIX-4).
    if (e.status >= 500) {
      console.error("HttpError in route:", JSON.stringify({
        status: e.status, code: e.code, message: e.message, cause: causeSummary(e.cause),
      }));
    }
    return json(e.status, { error: e.code, message: e.message }, retryAfterOf(e));
  }
  // Not an expected HttpError: log it server-side so the incident is traceable,
  // then return the generic 500 (never leak internal detail to the client).
  console.error("Unhandled error in route:", e);
  return json(500, { error: "internal", message: "Something went wrong." });
}

export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes: number): Promise<T> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, "too_large", `Body over ${maxBytes} bytes.`);
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new HttpError(413, "too_large", `Body over ${maxBytes} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "bad_request", "Body is not JSON.");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(400, "bad_request", "Body does not match the expected shape.");
  }
  return result.data;
}

/**
 * A redirect target is acceptable only when it stays on this origin: a single
 * leading slash, no scheme, no control characters. Everything else becomes "/".
 */
export function safeNextPath(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  for (let i = 0; i < next.length; i += 1) {
    if (next.charCodeAt(i) < 0x20) return "/";
  }
  return next;
}
