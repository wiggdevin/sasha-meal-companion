/**
 * GET|POST /api/jobs/oura-pull — Vercel cron, daily (spec §5, §8; `vercel.json`: `0 10-12 * * *`).
 * Timing-safe CRON_SECRET → rate limit (scale S2: secret first) → job_runs lock. The lock key is (job, user_id,
 * UTC date), so a duplicate cron fire is a no-op rather than a second pull. It is the same
 * reclaimable lock the other jobs take (`claimLock`): a finished pull is final, while a failed pull
 * or a "running" row a killed worker left behind (after 15 minutes) can be taken again.
 *
 * Scale (S3): sources are paged by id and pulled `CONCURRENCY` at a time within the shared budget
 * (lib/server/job-cursor.ts). The day's pass resumes on the next fire (`vercel.json` fires 10:00,
 * 11:00 and 12:00 UTC) and then retries the sources that failed or were held; a pass with nothing
 * left makes the later fires no-ops. A POST is an explicit run and starts a fresh pass; the lock
 * still skips users already pulled that day.
 */
import { timingSafeEqual } from "node:crypto";
import type { OuraPullResponse } from "@/lib/health/contract";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { pullTwoDays, type OuraSourceRow } from "@/lib/server/oura";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { claimLock, releaseLock } from "@/lib/server/jobs";
import { keysetRows } from "@/lib/server/job-sweep";
import { BUDGET_MS, HARD_STOP_MS, sweep, utcDate } from "@/lib/server/job-cursor";
import { chunk } from "@/lib/server/paged-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JOB_NAME = "oura-pull";
const CONCURRENCY = 6;
const SOURCE_COLUMNS = "id, user_id, oauth";

/** The still-connected Oura sources among these ids (the retry phase). */
async function* sourcesById(
  admin: ReturnType<typeof adminClient>, ids: string[],
): AsyncGenerator<OuraSourceRow> {
  for (const batch of chunk(ids)) {
    const { data, error } = await admin.from("health_sources").select(SOURCE_COLUMNS)
      .eq("kind", "oura").is("revoked_at", null).in("id", batch).order("id", { ascending: true });
    if (error) throw new Error(error.message);
    yield* (data ?? []) as OuraSourceRow[];
  }
}

function bearerOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (!bearerOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:oura-pull", 10, 3600);

    const empty: OuraPullResponse = { users: 0, sources: 0, results: [] };
    if (!process.env.HEALTH_INGEST_ENABLED) return Response.json(empty);

    const admin = adminClient();
    const localDate = utcDate(new Date(startedAt));
    const results: OuraPullResponse["results"] = [];

    const pullOne = async (source: OuraSourceRow): Promise<"ok" | "skip" | "retry"> => {
      const lock = await claimLock(admin, JOB_NAME, source.user_id, localDate);
      // "done": this user was pulled today. Otherwise another run holds it; try again later.
      if (lock !== "taken") return lock === "done" ? "skip" : "retry";
      try {
        const counts = await pullTwoDays(admin, source, localDate);
        results.push({ user_id: source.user_id, ...counts });
        await releaseLock(admin, JOB_NAME, source.user_id, localDate, "ok", counts);
        return "ok";
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        results.push({ user_id: source.user_id, inserted: 0, updated: 0, skipped: 0, error: message });
        await releaseLock(admin, JOB_NAME, source.user_id, localDate, "error", { message });
        return "retry";
      }
    };

    const pass = await sweep(admin, {
      job: JOB_NAME, period: localDate, restart: req.method === "POST",
      list: (after) => keysetRows<OuraSourceRow>((last, size) => {
        let query = admin.from("health_sources").select(SOURCE_COLUMNS)
          .eq("kind", "oura").is("revoked_at", null);
        if (last !== null) query = query.gt("id", last);
        return query.order("id", { ascending: true }).range(0, size - 1);
      }, (source) => source.id, after),
      byKeys: (ids) => sourcesById(admin, ids), keyOf: (source) => source.id,
      concurrency: CONCURRENCY, deadline: startedAt + BUDGET_MS,
      hardStop: startedAt + HARD_STOP_MS, work: pullOne,
      onError: (source, error) => {
        results.push({ user_id: source.user_id, inserted: 0, updated: 0, skipped: 0,
          error: error instanceof Error ? error.message : "unknown" });
        console.error("oura pull failed for source", { sourceId: source.id, error });
      },
    }).catch((e: unknown) => {
      console.error("oura pull could not list sources", { error: e });
      throw new HttpError(500, "internal", "could not list Oura sources");
    });

    const body: OuraPullResponse = { users: new Set(results.map((r) => r.user_id)).size,
      sources: results.length, results,
      ...(pass.busy ? { busy: true as const } : pass.passDone ? {} : { incomplete: true as const }) };
    return Response.json(body);
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = POST;
