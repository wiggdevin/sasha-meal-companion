/**
 * GET /api/jobs/backup — Vercel cron; POST remains available for explicit runs.
 *
 * A Vercel function has no writable home directory, so the nightly artefact is a JSON dump of the
 * user tables in the PRIVATE Supabase Storage bucket 'backups'. The real .sql dump under
 * ~/Backups/supabase/meal-companion/ is produced by scripts/backup.sh on the Mac (a whole-database
 * pg_dump that scripts/restore-to-branch.sh restores), which is what acceptance criterion 13
 * measures.
 *
 * Complete, consistent, time-bounded (audit 2026-10-10 F10):
 * - Every user-owned table (lib/server/backup-tables.ts), classified against the migrations by
 *   tests/export/backup-tables.test.ts (A083).
 * - Each table is read by key (`key > last`), so a concurrent write never skips or repeats a
 *   row (A122; lib/server/backup-dump.ts).
 * - One pass per UTC date, strung across budgeted runs (A123): a run writes numbered parts
 *   (`meal-companion/<date>/part-NNNN-<run>.json`) until BUDGET_MS, then saves where the next part
 *   starts in `job_cursors` (lib/server/job-cursor.ts) and answers `incomplete`; the next cron
 *   fire continues. The run that writes the last part writes the manifest
 *   (`meal-companion/<date>.json`, `user-table-export-v2`) and marks `backup_runs` ok. A part
 *   still uploading at HARD_STOP_MS is abandoned and the failure recorded before the platform
 *   kill; the cursor keeps every part already written. Each part's path names the run that wrote
 *   it, so an abandoned upload that lands late cannot replace a later run's part. The finishing
 *   steps (manifest, run record, cursor) race the same hard stop.
 * - The job_cursors lease (360 s) keeps one run at a time on a pass; a killed run's lease lapses
 *   before the next fire. A run that cannot claim it answers 503 and writes nothing, and a run
 *   whose cursor save is not confirmed fails, so `done` and `incomplete` always mean saved.
 *
 * Memory stays bounded at any account count (S3): each part is streamed to Storage one page at a
 * time, pulled by the upload, so at most a page or two of rows is ever held.
 *
 * The bearer check runs before the rate limit (scale S2): the limit is one shared counter, so
 * running it first would let an unauthenticated flood use up the cron's own quota. Every job route
 * checks its secret first; a user route still limits first (contracts §8).
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import {
  START, byteStream, manifestPath, manifestText, parseCursor, partPath, partText, serializeCursor,
  type BackupCursor,
} from "@/lib/server/backup-dump";
import { jsonError } from "@/lib/server/http";
import {
  BUDGET_MS, HARD_STOP_MS, claimPass, savePass, savePassConfirmed, utcDate,
} from "@/lib/server/job-cursor";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const JOB = "backup";
const BUCKET = "backups";

type Db = ReturnType<typeof adminClient>;

function bearerOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** The date's `backup_runs` row, one per UTC date: what the pass is doing and how it ended. */
async function recordRun(db: Db, date: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("backup_runs").upsert({ local_date: date, ...fields },
    { onConflict: "local_date" });
  if (error) throw new Error(`could not record the backup run: ${error.message}`);
}

/** Resolves with `work`, or rejects at `hardStop` after calling `onStop`. */
async function beforeHardStop<T>(
  work: Promise<T>, hardStop: number, what: string, onStop: () => void = () => undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onStop();
      work.catch(() => undefined);              // a late failure of the abandoned work is moot
      reject(new Error(`${what} was still running at the hard stop`));
    }, Math.max(0, hardStop - Date.now()));
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
  }
}

/** Writes one part from `cursor` at a path only this run uses, and answers where the next starts. */
async function writePart(
  db: Db, date: string, owner: string, cursor: BackupCursor, passStartedAt: Date, deadline: number,
  hardStop: number,
): Promise<BackupCursor> {
  const progress: { next?: BackupCursor } = {};
  const sent = { bytes: 0 };
  const stop = { stopped: false };
  const path = partPath(date, cursor.part, owner);
  const body = byteStream(partText(db, cursor, { passStartedAt, deadline }, progress), sent, stop);
  const upload = db.storage.from(BUCKET).upload(path, body, {
    contentType: "application/json", upsert: true,
  });
  const result = await beforeHardStop(upload, hardStop, "a part upload", () => { stop.stopped = true; });
  if (result.error) throw new Error(result.error.message);
  if (!progress.next) throw new Error("the upload ended before the part did");
  return { ...progress.next, parts: [...progress.next.parts, path], bytes: cursor.bytes + sent.bytes };
}

export async function POST(req: Request): Promise<Response> {
  try {
    if (!bearerOk(req)) {
      throw new HttpError(401, "unauthorized", "bad cron secret");
    }
    await enforceRateLimit("jobs:backup", 10, 3600);
    const db = adminClient();
    const began = Date.now();
    const hardStop = began + HARD_STOP_MS;
    const date = utcDate(new Date(began));
    const owner = randomUUID();

    // The pass lease is the only guard against two overlapping runs writing one pass, so a run
    // that cannot take it does not start (migration 20261217120300 is a deploy prerequisite).
    const claim = await claimPass(db, JOB, date, owner, false);
    if (claim.kind === "busy") throw new HttpError(409, "conflict", "a backup run for today is in progress");
    if (claim.kind === "unavailable") {
      throw new HttpError(503, "unavailable", "the backup's job cursor could not be claimed");
    }
    const state = claim.state;
    if (state.done) {
      await savePass(db, JOB, date, owner, state);
      return Response.json({ ok: true, done: true, alreadyDone: true });
    }
    const saved = parseCursor(state.after);
    if (state.after && !saved) console.error("backup: unreadable cursor; the pass starts again", { date });
    const at = { cursor: saved ?? START };
    const passState = (done: boolean) => ({ after: serializeCursor(at.cursor),
      listed: at.cursor.table === null, retry: [], relist: false, done });

    try {
      await beforeHardStop(recordRun(db, date, { started_at: state.startedAt.toISOString(),
        finished_at: null, status: "running", error: null }), hardStop, "recording the run");
      const deadline = began + BUDGET_MS;
      for (let parts = 0; at.cursor.table !== null; parts += 1) {
        if (parts > 0 && Date.now() >= deadline) break;
        at.cursor = await writePart(db, date, owner, at.cursor, state.startedAt, deadline, hardStop);
      }
      if (at.cursor.table !== null) {
        await beforeHardStop(savePassConfirmed(db, JOB, date, owner, passState(false)), hardStop,
          "saving the cursor");
        console.warn("backup: pass is not finished; the next run continues", { date, parts: at.cursor.part - 1 });
        return Response.json({ ok: true, done: false, incomplete: true,
          parts: at.cursor.part - 1, bytes: at.cursor.bytes });
      }

      const finishedAt = new Date();
      await beforeHardStop((async () => {
        const manifest = await db.storage.from(BUCKET).upload(manifestPath(date),
          manifestText(at.cursor, state.startedAt, finishedAt),
          { contentType: "application/json", upsert: true });
        if (manifest.error) throw new Error(manifest.error.message);
        await recordRun(db, date, { finished_at: finishedAt.toISOString(), bytes: at.cursor.bytes,
          status: "ok", error: null });
        await savePassConfirmed(db, JOB, date, owner, passState(true));
      })(), hardStop, "finishing the pass");
      return Response.json({ ok: true, done: true, parts: at.cursor.part - 1, bytes: at.cursor.bytes });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      // Best effort, inside the time left before the platform kill (maxDuration).
      const grace = began + maxDuration * 1000 - 2_000;
      try {
        await beforeHardStop(savePass(db, JOB, date, owner, passState(false)), grace,
          "saving the cursor");                 // keeps every part already written
        await beforeHardStop(recordRun(db, date, { finished_at: new Date().toISOString(),
          status: "error", error: message }), grace, "recording the failure");
      } catch (recordError) {
        console.error("backup: could not record the failed run", {
          date, error: recordError instanceof Error ? recordError.message : "unknown" });
      }
      throw new HttpError(500, "internal", "backup failed", { cause: e });
    }
  } catch (e) {
    return jsonError(e);
  }
}

// Vercel Cron invokes GET with the same CRON_SECRET bearer check.
export const GET = POST;
