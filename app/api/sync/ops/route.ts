/**
 * POST /api/sync/ops — apply a batch of sync ops. §5 security matrix: Supabase JWT, 1 MB body,
 * 60/min/user, idempotent on `op_id`. Identity comes first because the rate-limit key IS the user
 * id. One `apply_sync_op` RPC per op, in array order; the RPC does the compare-and-swap.
 * When a batch carries a `user_settings` op, the target revision is re-derived from the stored row once per
 * batch (`lib/server/target-recompute.ts`); a recompute failure is logged and never fails the op.
 * Applied `log_entries` ops are stamped with their occasion once per batch
 * (`lib/server/log-occasion.ts`, Phase 17 D1); a stamp failure is logged the same way.
 * Queued `log_entries` writes answer with the commit's policy marks (`lib/server/sync-log-ops.ts`).
 */
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { stampLogOccasionsSafely } from "@/lib/server/log-occasion";
import { recomputeDerivedTarget } from "@/lib/server/target-recompute";
import { applyLabelFoodOp, isLabelFoodOp, withLogEntryFlags } from "@/lib/server/sync-log-ops";
import {
  OpsRequestSchema, type OpResult, type OpsResponse, type SyncOp,
} from "@/lib/sync/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Like the other hot routes (T0 §5): beside the Supabase project (us-west-1 -> sfo1, as vercel.json
// "regions"), since a batch is up to 200 sequential RPCs and each one is a database round trip.
// No maxDuration cap: a full batch's duration is unmeasured, and a cut-off batch loses the results of
// ops it already committed (the phone then retries them). The platform default stays until a 200-op
// batch is benchmarked (scale S1 review).
export const preferredRegion = ["sfo1"];

const BODY_LIMIT_BYTES = 1_048_576;
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;

/** Log it here (op id + entity, never the payload) and hand the client a result it can act on. */
function errorResult(o: SyncOp, message: string, retryable = false): OpResult {
  console.error(`sync: op ${o.op_id} (${o.entity} ${o.kind}) failed: ${message}`);
  return retryable
    ? { op_id: o.op_id, status: "error", message, retryable: true }
    : { op_id: o.op_id, status: "error", message };
}

/** An RPC failure, with the code PostgREST or Postgres gave it. */
class RpcError extends Error {
  constructor(message: string, readonly code: string | undefined) { super(message); }
}

/**
 * A failure the same op would not meet again a moment later (W026, audit A137): no code at all (the
 * request never reached the database: a dropped connection, a fetch timeout), PostgREST's
 * connection and timeout codes (PGRST000-PGRST003), and the Postgres classes for a lost
 * connection (08), a serialization failure or deadlock (40), too many connections or out of
 * memory (53), a cancelled or timed-out statement (57) and a lock wait that ran out (55P03).
 * Anything else (a constraint, a malformed payload, a missing function) fails again the same way.
 */
function isRetryableRpcCode(code: string | undefined): boolean {
  if (!code) return true;
  return /^(08|40|53|57)/.test(code) || code === "55P03" || /^PGRST00[0-3]$/.test(code);
}

/** The RPC is trusted to return an OpResult, but a null or half-built row must not reach the
 *  client: drainOutbox reads `status` on every result it is handed. */
function asOpResult(data: unknown, o: SyncOp): OpResult {
  const row = data as Record<string, unknown> | null;
  if (row && typeof row === "object"
    && typeof row.op_id === "string" && typeof row.status === "string") {
    return row as unknown as OpResult;
  }
  return errorResult(o, "malformed rpc result");
}

async function applyOp(client: Awaited<ReturnType<typeof requireUser>>["client"], userId: string,
  op: SyncOp): Promise<OpResult> {
  if (op.entity !== "food_membership") {
    // A033/A030: a queued label commit goes through the commit path whole; every other queued log
    // write gets the commit's policy marks on its result.
    if (isLabelFoodOp(op)) return applyLabelFoodOp(client, userId, op);
    const { data, error } = await client.rpc("apply_sync_op", { p_user_id: userId, p_op: op });
    if (error) throw new RpcError(error.message, error.code);
    return withLogEntryFlags(client, userId, op, asOpResult(data, op));
  }
  const { name_norm: nameNorm, status, note, rev } = op.payload;
  if (typeof nameNorm !== "string"
    || (status !== null && status !== "eats" && status !== "avoid")
    || (note !== null && typeof note !== "string")
    || typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) {
    return errorResult(op, "malformed food membership payload");
  }
  // W029 (audit 2026-10-10 A140): the server assigns the revision, at least the phone's `rev`
  // hint, and records the op id, so a retry answers its first result and never writes again
  // (migration 20261231110000). A tap is no longer refused for another device's clock.
  const { data, error } = await client.rpc("set_food_membership", {
    p_user: userId,
    p_name_norm: nameNorm,
    p_status: status,
    p_note: note,
    p_rev: rev,
    p_op_id: op.op_id,
  });
  if (error) throw new RpcError(error.message, error.code);
  const row = data as { rev?: unknown; status?: unknown } | null;
  if (typeof row?.rev !== "number" || !Number.isSafeInteger(row.rev)
    || (row.status !== null && row.status !== "eats" && row.status !== "avoid")) {
    return errorResult(op, "malformed food membership result");
  }
  if (row.rev < rev || row.status !== status) {
    return {
      op_id: op.op_id,
      status: "rejected",
      user_id: userId,
      name_norm: nameNorm,
      current_status: row.status,
      current_rev: row.rev,
    } as unknown as OpResult;
  }
  return { op_id: op.op_id, status: "applied", rev: row.rev, seq: 0 };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`sync:ops:${userId}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
    const body = await readJson(req, OpsRequestSchema, BODY_LIMIT_BYTES);

    const results: OpResult[] = [];
    let settingsTouched = false;
    const loggedEntries: string[] = [];
    for (const op of body.ops) {
      // One op's failure must not lose the results already collected for the ops before it, and
      // must not stop the ops after it from running — each op gets its own try/catch, and the
      // batch always comes back 200 with one result per op.
      // Phase 9 §0.5: an op must name its owner, and the owner must be the JWT subject. Anything
      // else is refused with `error` (which an old build parks and keeps) and writes nothing.
      const { user_id: owner, ...wire } = op;
      if (owner === undefined) { results.push(errorResult(wire, "account_unbound")); continue; }
      if (owner !== userId) { results.push(errorResult(wire, "account_mismatch")); continue; }
      try {
        const result = await applyOp(client, userId, wire);
        results.push(result);
        // Not only "applied": a replay or conflict means the stored row may be newer than the last
        // derivation (an earlier attempt can have applied and died before recomputing). The
        // recompute is a no-op when the revision already matches.
        if (wire.entity === "user_settings") settingsTouched = true;
        // D1: only a log write this request applied is stamped, after the batch. A conflict, a
        // replay or an error wrote nothing here, and stamping its id could label an old row.
        // A label op's commit path stamps its own write and reports a replay as applied too, so it
        // is left out here (a replay is never restamped).
        if (wire.entity === "log_entries" && result.status === "applied" && !isLabelFoodOp(wire)) {
          loggedEntries.push(wire.entity_id);
        }
      } catch (e) {
        // An RPC error can arrive after the row committed (a dropped response), so a settings op
        // that reached the database still recomputes; that is a no-op when nothing changed.
        if (wire.entity === "user_settings") settingsTouched = true;
        results.push(errorResult(wire, e instanceof Error ? e.message : "unknown",
          e instanceof RpcError && isRetryableRpcCode(e.code)));
      }
    }

    if (settingsTouched) {
      try {
        // t24b: dated by the account's stored zone when one is on file, else the phone's own day.
        const outcome = await recomputeDerivedTarget(client, userId,
          { clientDay: body.local_date ?? null, requestZone: body.time_zone ?? null });
        if (outcome.status === "unsettled") {
          console.warn(`sync: target recompute for ${userId} unsettled after ${outcome.rounds} rounds`);
        }
      } catch (e) {
        console.error(`sync: target recompute for ${userId} failed: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }

    if (loggedEntries.length) await stampLogOccasionsSafely(client, userId, { ids: loggedEntries });

    const build = process.env.VERCEL_GIT_COMMIT_SHA;
    const payload: OpsResponse = { results, server_time: new Date().toISOString(),
      ...(build ? { server_build: build } : {}) };
    return Response.json(payload);
  } catch (e) {
    return jsonError(e);
  }
}
