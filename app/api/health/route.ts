/**
 * GET /api/health — the deployment's own liveness check (scale S1), for an uptime monitor.
 *
 * No session and no user data: it answers whether this function can reach the database, and which
 * commit it runs. The database ping is one head-only read of the tiny `catalog_versions` table
 * through the admin client, under a 2 s budget; a ping that fails or overruns answers 503 with
 * `db: "down"`. A healthy answer is cached at Vercel's edge for 10 s (`s-maxage`), so a flood of
 * checks reaches the function and the database at most once per 10 s per edge region; a 503 or 429 is
 * never cached. It is also rate limited per IP (`x-real-ip`, the address Vercel's edge accepted, as lib/server/capture-rate-limit),
 * because an unauthenticated route that touches the database without a limit is an invitation.
 *
 * Not to be confused with the routes under it (/api/health/ingest, /oura, …): those are the
 * account's health data. The middleware matcher skips every /api path, so no sign-in redirect
 * stands in front of this one.
 */

import { adminClient } from "@/lib/server/admin";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Supabase project's own region (us-west-1 -> sfo1), as vercel.json "regions".
export const preferredRegion = ["sfo1"];
export const maxDuration = 5;

/** The database ping's whole budget, so a hung pool answers 503 well inside maxDuration. */
const DB_PING_TIMEOUT_MS = 2_000;
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;
const NO_STORE = { "cache-control": "no-store" };
/** Edge-cached for 10 s, never by the browser (scale S1 review: the IP limit is per instance). */
const EDGE_CACHED = { "cache-control": "public, max-age=0, s-maxage=10" };

type HealthBody = { ok: boolean; db: "ok" | "down"; version: string | null };

async function pingDb(): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(false); }, DB_PING_TIMEOUT_MS);
  });
  // The race holds the budget even if the client ignores the abort; the abort still frees the socket.
  const ping = (async () => {
    const { error } = await adminClient().from("catalog_versions")
      .select("id", { head: true }).limit(1).abortSignal(controller.signal);
    if (error) console.error("health: db ping failed", { code: error.code, message: error.message });
    return !error;
  })().catch((e: unknown) => {
    console.error("health: db ping threw", e instanceof Error ? e.message : String(e));
    return false;
  });
  try {
    return await Promise.race([ping, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`health:ip:${req.headers.get("x-real-ip") ?? "unknown"}`, RATE_LIMIT,
      RATE_WINDOW_SECONDS);
  } catch (e) {
    const limited = jsonError(e);
    limited.headers.set("cache-control", "no-store");
    return limited;
  }
  const dbOk = await pingDb();
  const body: HealthBody = {
    ok: dbOk, db: dbOk ? "ok" : "down", version: process.env.VERCEL_GIT_COMMIT_SHA || null,
  };
  return Response.json(body, { status: dbOk ? 200 : 503, headers: dbOk ? EDGE_CACHED : NO_STORE });
}
