/**
 * POST /api/client-errors — crash reports from the phone (audit 2026-10-08 §5). No session, no
 * table, no vendor: one scrubbed line to the function log under CLIENT_ERROR_LOG_PREFIX, which
 * Vercel's runtime logs keep. Search them for `[client-error]`.
 *
 * The body is re-cleaned here (`cleanReport`), so only the bounded report fields are ever logged,
 * whatever a caller sends; the request itself (headers, IP, cookies, the raw body) is never logged
 * or echoed. 413 over 4 KB; 429/503 from the shared limiter (per IP, fail closed, before the body
 * is read); 202 for everything else, a malformed body included, so the reporter never has a reason
 * to retry. The middleware matcher skips /api, so a crash on the sign-in page reaches it too.
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

async function readBounded(req: Request): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > CLIENT_ERROR_MAX_BYTES) {
    throw new HttpError(413, "too_large", `Body over ${CLIENT_ERROR_MAX_BYTES} bytes.`);
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > CLIENT_ERROR_MAX_BYTES) {
    throw new HttpError(413, "too_large", `Body over ${CLIENT_ERROR_MAX_BYTES} bytes.`);
  }
  return raw;
}

export async function POST(req: Request): Promise<Response> {
  try {
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
