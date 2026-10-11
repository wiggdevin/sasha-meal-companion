/**
 * GET|POST /api/jobs/media-sweep — Vercel cron, daily on Vercel Hobby (hourly needs Pro), the 24 h
 * cutoff is unchanged, so an abandoned upload lives at most about 48 h; commit-delete is the
 * primary path (spec §5, AC8).
 *
 * The backstop for the delete-on-commit path: an abandoned capture leaves an object nobody will
 * ever ask for, and it is gone within 24 hours. Vercel's scheduler issues GET, so both verbs are
 * exported and share one handler.
 *
 * It also scrubs coach Undo records a day past their expiry (`scrubExpiredUndos`).
 *
 * Scale (S3): expired objects are paged by path and deleted `CONCURRENCY` at a time until the
 * listing runs out or `TIME_BUDGET_MS` passes. No cursor is kept: a swept object leaves the
 * listing (its `deleted_at` is set), so the next run starts on exactly what is left. A failed
 * Storage removal leaves the row live (`deleteMedia` throws before the tombstone), so it is
 * retried next run; the in-run paging moves past it. A row linked to a log entry (`entry_id`) is
 * never swept: only unattached drafts are.
 *
 * Owner binding (audit 2026-10-10 P08): the sweep deletes with the service role, so it deletes
 * only a path inside the row owner's own folder (`ownedObjectKey(path, user_id)`). Any other row
 * is skipped and logged, never touched; the media_objects CHECK (migration 20261230091900) keeps
 * new rows to that shape too.
 *
 * The timing-safe bearer check runs before the rate limit (scale S2): the limit is a shared counter,
 * so an unauthenticated caller must not be able to spend the cron's quota.
 */

import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { deleteMedia, ownedObjectKey } from "@/lib/server/media";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { keysetRows, runWithinBudget } from "@/lib/server/job-sweep";
import { BUDGET_MS, HARD_STOP_MS } from "@/lib/server/job-cursor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 8;

function bearerOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * The same daily backstop for coach Undo records (migration 20261210090300): a day past its
 * seven-day expiry a record's inverse is scrubbed (`scrub_coach_action_undos`), so old meal, water and profile tokens
 * are not kept. The row stays as a tombstone, never deleted: a phone still holding its token must
 * be able to see that the action was undone elsewhere or expired (review t4r4 #1).
 * Best effort; a failure never fails the media sweep.
 */
async function scrubExpiredUndos(admin: ReturnType<typeof adminClient>): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
    const { error } = await admin.rpc("scrub_coach_action_undos", { p_cutoff: cutoff });
    if (error) console.error("coach undo scrub failed", { code: error.code });
  } catch (e) {
    console.error("coach undo scrub failed", { error: e instanceof Error ? e.message : "unknown" });
  }
}

async function sweep(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    if (!bearerOk(req)) throw new HttpError(401, "unauthorized", "bad cron secret");
    await enforceRateLimit("jobs:media-sweep", 30, 3600);
    const admin = adminClient();
    const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
    let swept = 0;
    let failed = 0;
    let skipped = 0;
    const pass = await runWithinBudget({
      items: keysetRows<{ path: string; user_id: string }>((last, size) => {
        let query = admin.from("media_objects").select("path, user_id")
          .is("deleted_at", null).is("entry_id", null).lt("created_at", cutoff);
        if (last !== null) query = query.gt("path", last);
        return query.order("path", { ascending: true }).range(0, size - 1);
      }, (row) => row.path),
      keyOf: (row) => row.path,
      concurrency: CONCURRENCY, deadline: startedAt + BUDGET_MS,
      hardStop: startedAt + HARD_STOP_MS,
      work: async (row) => {
        if (ownedObjectKey(row.path, row.user_id) === null) {
          skipped += 1;
          console.error("media sweep skipped a path outside its owner's folder",
            { path: row.path, userId: row.user_id });
          return;
        }
        await deleteMedia(admin, row.path);
        swept += 1;
      },
      onError: (row, e) => {
        failed += 1;
        console.error("sweep delete failed", { path: row.path, error: e });
      },
    });
    if (pass.listError !== undefined && pass.started === 0) {
      throw new HttpError(500, "internal", "could not list media objects");
    }
    if (pass.listError !== undefined) {
      console.error("media sweep listing stopped", { error: pass.listError });
    }
    if (!pass.complete) {
      console.warn("media sweep stopped at its budget; the next run continues", { swept, failed, skipped });
    }
    await scrubExpiredUndos(admin);
    return Response.json({ swept, failed, ...(skipped > 0 ? { skipped } : {}),
      ...(pass.complete ? {} : { incomplete: true }) });
  } catch (e) {
    return jsonError(e);
  }
}

export const GET = sweep;
export const POST = sweep;
