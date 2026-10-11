/**
 * A queued `log_entries` write, applied through /api/sync/ops (audit 2026-10-10 A033, A030).
 *
 * A commit that could not reach /api/log/commit drains here. Two things the commit path does
 * must happen on this path too:
 * - the policy marks. Logging marks and never refuses (ruling 2026-09-14), so an applied or
 *   replayed create or update answers with `flagged`, judged from the stored items, for the
 *   phone to put on the card;
 * - the label food. A label commit's op carries the placeholder ref and the label body, which only
 *   applyLogEntry can turn into the account's own food, so that op goes through it whole.
 *
 * A failed policy read never fails the op: the write already stands, and the mark is best effort.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LogCommitFailure, LogCommitResponse } from "@/lib/log/contract";
import { applyLogEntry, storedEntryFlags } from "@/lib/server/log";
import { LABEL_FOOD_PLACEHOLDER_REF } from "@/lib/server/log-label-food";
import type { OpResult, SyncOp } from "@/lib/sync/types";

type Flag = { path: string; message: string };

/** Does this op carry a label food the server still has to save? */
export function isLabelFoodOp(op: SyncOp): boolean {
  const items = op.payload.items;
  return op.entity === "log_entries" && op.kind === "create"
    && op.payload.save_label_as_food === true && Array.isArray(items)
    && items.some((item) => (item as { food_ref_id?: unknown })?.food_ref_id
      === LABEL_FOOD_PLACEHOLDER_REF);
}

/** applyLogEntry's answer in the sync vocabulary the drain already reads. */
function opResultOf(op: SyncOp, result: LogCommitResponse | LogCommitFailure): OpResult {
  switch (result.status) {
    case "ok":
      return { op_id: op.op_id, status: "applied", rev: result.rev, seq: 0,
        ...(result.flagged?.length ? { flagged: result.flagged } : {}) };
    case "conflict":
      return { op_id: op.op_id, status: "conflict", entity: "log_entries",
        current_rev: result.current_rev, current: result.entity };
    case "deleted":
      return { op_id: op.op_id, status: "deleted", entity: "log_entries",
        deleted_at: result.deleted_at };
    case "gone":
      return { op_id: op.op_id, status: "gone" };
    case "stale_revision":
      return { op_id: op.op_id, status: "error", message: "stale_revision" };
    default:
      return { op_id: op.op_id, status: "error",
        message: `invalid: ${result.issues.map((issue) => issue.path).join(",")}` };
  }
}

/** The label op, whole, through the commit path. Its op id is the commit's own (opIdFor). */
export async function applyLabelFoodOp(
  client: SupabaseClient, userId: string, op: SyncOp,
): Promise<OpResult> {
  const result = await applyLogEntry(client, userId, op.payload,
    { labelFood: op.payload.label_food });
  return opResultOf(op, result);
}

/** The marks for an applied or replayed create/update, added to its result. */
export async function withLogEntryFlags(
  client: SupabaseClient, userId: string, op: SyncOp, result: OpResult,
): Promise<OpResult> {
  if (op.entity !== "log_entries" || (op.kind !== "create" && op.kind !== "update")) return result;
  if (result.status !== "applied" && result.status !== "duplicate") return result;
  let flagged: Flag[];
  try {
    flagged = await storedEntryFlags(client, userId, op.entity_id);
  } catch (e) {
    console.warn(`sync: policy marks for op ${op.op_id} could not be read: ${
      e instanceof Error ? e.message : "unknown"}`);
    return result;
  }
  return flagged.length > 0 ? { ...result, flagged } : result;
}
