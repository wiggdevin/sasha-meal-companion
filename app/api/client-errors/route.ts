/**
 * POST /api/client-errors — crash reports from the phone (audit 2026-10-08 §5; W053). No session,
 * no table, no vendor: one allowlisted line to the function log under CLIENT_ERROR_LOG_PREFIX,
 * which Vercel's runtime logs keep. Search them for `[client-error]`.
 *
 * The body is re-cleaned here (`cleanReport`), so only allowlisted values are ever logged (an error
 * code, an error name, a route pattern, a Next digest hash, a build sha), whatever a caller sends;
 * the request itself (headers, IP, cookies, the raw body) is never logged or echoed.
 *
 * Order: a declared Content-Length over 4 KB is refused before anything else (413, no read, no
 * limiter write); then the shared limiter (per IP, fail closed: 429/503); then the body is read
 * as a stream with a running byte count and cancelled the moment it passes 4 KB (413), so an
 * undeclared or understated body is never read whole. 202 for everything else, a malformed body
 * included, so the reporter never has a reason to retry. The middleware matcher skips /api, so a
 * crash on the sign-in page reaches it too.
 */

import { CLIENT_ERROR_LOG_PREFIX, CLIENT_ERROR_MAX_BYTES, cleanReport } from "@/lib/client-errors";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["sfo1"];

const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 60;
const ACCEPTED = () => new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
const tooLarge = () => new HttpError(413, "too_large", `Body over ${CLIENT_ERROR_MAX_BYTES} bytes.`);

function refuseDeclaredOversize(req: Request): void {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= CLIENT_ERROR_MAX_BYTES)) throw tooLarge();
}

/** Reads at most CLIENT_ERROR_MAX_BYTES; one byte more cancels the stream and throws 413. */
async function readBounded(req: Request): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CLIENT_ERROR_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: Request): Promise<Response> {
  try {
    refuseDeclaredOversize(req);
    await enforceRateLimit(`client-errors:ip:${requestIp(req)}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
    const raw = await readBounded(req);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return ACCEPTED(); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ACCEPTED();
    const report = cleanReport(parsed);
    console.error(CLIENT_ERROR_LOG_PREFIX, JSON.stringify({
      ...report, serverBuild: process.env.VERCEL_GIT_COMMIT_SHA || null,
    }));
    return ACCEPTED();
  } catch (e) {
    return jsonError(e);
  }
}
