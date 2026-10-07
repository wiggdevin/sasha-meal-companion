/**
 * GET /api/jobs/backup — Vercel cron; POST remains available for explicit runs.
 *
 * A Vercel function has no writable home directory, so the nightly artefact is
 * a JSON dump of the user tables in the PRIVATE Supabase Storage bucket
 * 'backups'. The real .sql dump under ~/Backups/supabase/meal-companion/ is
 * produced by scripts/backup.sh on the Mac, which is what acceptance criterion
 * 13 measures.
 *
 * One successful run per UTC date: failed runs may retry; abandoned leases expire.
 *
 * Memory stays bounded at any account count (S3): the dump is streamed to Storage one table page
 * at a time (`dumpStream`), pulled by the upload, so at most a page or two of rows is ever held.
 * The bytes are the same `user-table-export-v1` JSON document a whole-dump `JSON.stringify` wrote.
 *
 * The bearer check runs before the rate limit (scale S2): the limit is now one shared counter, so
 * running it first would let an unauthenticated flood use up the cron's own quota. Every job route
 * checks its secret first; a user route still limits first (contracts §8).
 */

import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/server/admin";
import { HttpError } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Every user-owned table, so a restore is not missing a phase's data.
 *
 * SOURCE OF TRUTH: supabase/migrations/20260911000500_rls.sql — the owner-table
 * array in pattern 1, plus the child tables in pattern 2, plus food_refs, whose
 * kind='user' rows belong to a user through user_foods. Catalog tables are
 * shared reference data and are rebuilt by the importer, not restored from here.
 * A table added to that migration must be added here too.
 */
const TABLES = [
  // pattern 1: owner tables (user_id column)
  "user_foods", "user_food_prefs", "log_entries", "water_log", "plan_days", "user_settings",
  "gut_log", "recipes", "favorites_foods", "favorites_recipes", "favorites_meals",
  "target_profiles", "expenditure_estimates", "target_proposals", "constraint_profiles",
  "coach_threads", "ai_calls", "api_tokens", "health_sources", "ingest_events",
  "health_samples", "change_seq", "change_log", "duplicate_groups", "media_objects",
  // pattern 2: child tables reached through their parent
  "log_items", "duplicate_group_members", "recipe_revisions", "recipe_items",
  "favorites_meal_items", "coach_messages",
  // pattern 3: shared, but holds user rows
  "food_refs",
] as const;

/** supabase/config.toml sets `max_rows = 1000`: PostgREST truncates a bare `select("*")`
 *  past that with no error, exactly as lib/server/health-daily.ts documents. Page every
 *  table the same way, accumulating until a page comes back shorter than PAGE. */
const PAGE = 1000;
const STALE_LEASE_MS = 2 * 60 * 60 * 1000;
// All other included tables have a single id primary key.
const COMPOSITE_KEYS: Partial<Record<(typeof TABLES)[number], string[]>> = {
  media_objects: ["path"],
  user_food_prefs: ["user_id", "food_ref_id"], water_log: ["user_id", "local_date"],
  plan_days: ["user_id", "local_date"], user_settings: ["user_id"],
  favorites_foods: ["user_id", "food_ref_id"], favorites_recipes: ["user_id", "recipe_id"],
  constraint_profiles: ["user_id"], change_seq: ["user_id"], change_log: ["user_id", "seq"],
  duplicate_group_members: ["group_id", "entry_id"], recipe_items: ["recipe_revision_id", "seq"],
  favorites_meal_items: ["meal_id", "seq"],
};

/** One table's rows, page by page in complete primary-key order. */
async function* tablePages(
  db: ReturnType<typeof adminClient>, table: (typeof TABLES)[number],
): AsyncGenerator<unknown[]> {
  for (let offset = 0; ; offset += PAGE) {
    let query = db.from(table).select("*");
    for (const key of COMPOSITE_KEYS[table] ?? ["id"]) query = query.order(key);
    const { data, error } = await query.range(offset, offset + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (data && data.length > 0) yield data;
    if (!data || data.length < PAGE) return;
  }
}

/** The export document as text pieces, in order: header, then each table's rows a page at a time. */
async function* dumpText(db: ReturnType<typeof adminClient>, takenAt: string): AsyncGenerator<string> {
  yield `{"format":"user-table-export-v1","consistency":"per-request","taken_at":${
    JSON.stringify(takenAt)},"tables":{`;
  for (const [index, table] of TABLES.entries()) {
    yield `${index === 0 ? "" : ","}${JSON.stringify(table)}:[`;
    let first = true;
    for await (const rows of tablePages(db, table)) {
      yield `${first ? "" : ","}${rows.map((row) => JSON.stringify(row)).join(",")}`;
      first = false;
    }
    yield "]";
  }
  yield "}}";
}

/** A pull-driven byte stream of the dump: the next page is read only when the upload asks for
 *  more, so memory holds what is in flight, never the whole dump. `sent.bytes` counts what went. */
function dumpStream(
  db: ReturnType<typeof adminClient>, takenAt: string, sent: { bytes: number },
): ReadableStream<Uint8Array> {
  const pieces = dumpText(db, takenAt);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await pieces.next();
      if (next.done) {
        controller.close();
        return;
      }
      const bytes = encoder.encode(next.value);
      sent.bytes += bytes.byteLength;
      controller.enqueue(bytes);
    },
    async cancel() {
      await pieces.return(undefined);
    },
  });
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
  try {
    if (!bearerOk(req)) {
      throw new HttpError(401, "unauthorized", "bad cron secret");
    }
    await enforceRateLimit("jobs:backup", 10, 3600);
    const db = adminClient();
    const localDate = new Date().toISOString().slice(0, 10);

    const startedAt = new Date().toISOString();
    const claim = { local_date: localDate, started_at: startedAt, finished_at: null,
      status: "running", error: null, bytes: null };
    const lock = await db.from("backup_runs").insert(claim).select("local_date");
    if (lock.error) {
      if (lock.error.code !== "23505") throw new HttpError(500, "internal", "could not take the backup lock");
      // Conditional updates are the claim: two retries cannot both change error→running.
      const retry = await db.from("backup_runs").update(claim)
        .eq("local_date", localDate).eq("status", "error").select("local_date");
      if (retry.error) throw new HttpError(500, "internal", "could not reclaim failed backup");
      if (!retry.data?.length) {
        const stale = await db.from("backup_runs").update(claim)
          .eq("local_date", localDate).eq("status", "running")
          .lt("started_at", new Date(Date.now() - STALE_LEASE_MS).toISOString()).select("local_date");
        if (stale.error) throw new HttpError(500, "internal", "could not reclaim abandoned backup");
        if (!stale.data?.length) throw new HttpError(409, "conflict", "today's backup is complete or already running");
      }
    }

    try {
      const sent = { bytes: 0 };
      const upload = await db.storage
        .from("backups")
        .upload(`meal-companion/${localDate}.json`, dumpStream(db, new Date().toISOString(), sent), {
          contentType: "application/json", upsert: true,
        });
      if (upload.error) throw new Error(upload.error.message);

      const finished = await db.from("backup_runs")
        .update({ finished_at: new Date().toISOString(), bytes: sent.bytes, status: "ok" })
        .eq("local_date", localDate).eq("started_at", startedAt).select("local_date");
      if (finished.error || finished.data?.length !== 1) throw new Error("Could not record backup completion");
      return Response.json({ ok: true, bytes: sent.bytes });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      await db.from("backup_runs")
        .update({ finished_at: new Date().toISOString(), status: "error", error: message })
        .eq("local_date", localDate).eq("started_at", startedAt);
      throw new HttpError(500, "internal", "backup failed");
    }
  } catch (e) {
    return jsonError(e);
  }
}

// Vercel Cron invokes GET with the same CRON_SECRET bearer check.
export const GET = POST;
