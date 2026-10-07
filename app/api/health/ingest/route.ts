/**
 * POST /api/health/ingest — spec §8 row 1. Order is rate limit (on the token hash, so an
 * unauthenticated flood costs no lookup) → identity → body (Phase 0 contracts §8).
 */
import { MAX_INGEST_BYTES } from "@/lib/health/contract";
import { z } from "zod";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { applyIngest } from "@/lib/server/health-ingest";
import { resolveSourceByToken } from "@/lib/server/health-tokens";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { hashToken } from "@/lib/server/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function POST(req: Request): Promise<Response> {
  try {
    if (!process.env.HEALTH_INGEST_ENABLED) {
      throw new HttpError(503, "unavailable", "Health ingest is off.");
    }
    const raw = bearer(req);
    const key = raw.length > 0 ? hashToken(raw).toString("hex") : "none";
    await enforceRateLimit(`health:ingest:${key}`, 30, 3600);
    // gap-privileged-boundary-6: the token-hash key above is a hash of the raw, unverified
    // bearer, so a caller who fabricates a fresh token per request never trips it. `x-real-ip`
    // is the address Vercel's edge network actually accepted the connection from and cannot be
    // spoofed by the client (see app/api/health/oura/callback/route.ts), so it is checked here
    // in addition, keeping repeat-token abuse throttled per-token and a flood of distinct
    // fabricated tokens throttled per-source.
    const ip = req.headers.get("x-real-ip") ?? "unknown";
    await enforceRateLimit(`health:ingest:ip:${ip}`, 30, 3600);

    const source = await resolveSourceByToken(adminClient(), raw);
    if (!source) throw new HttpError(401, "unauthorized", "Unknown, revoked or expired token.");

    const body = await readJson(req, z.unknown(), MAX_INGEST_BYTES);
    return Response.json(await applyIngest(adminClient(), source, body));
  } catch (e) {
    const res = jsonError(e);
    if (res.status === 401) res.headers.set("WWW-Authenticate", "Bearer");
    return res;
  }
}
