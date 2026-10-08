import "server-only";

/**
 * Followups #1: the two RPCs of migration 20261226090100 on the caller's own session client.
 * `taste_dislike_remove` and `taste_dislike_remove_undo` run in one transaction each, under the
 * user_settings lock every settings writer takes; the database decides what was removed and what
 * its Undo restores, from its own receipt only.
 *
 * Privacy (standing rule for this item): nothing here logs the dislike KEY. A 5xx is logged by
 * `jsonError` (lib/server/http.ts) from the thrown `HttpError`'s own message, which this module
 * builds without interpolating `key` anywhere — only the action id and outcome ever reach a log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import {
  TASTE_DISLIKE_REMOVE_ERRORS as E, type TasteDislikeRemoveResult, type TasteDislikeRemoveUndoResult,
} from "@/lib/profile/taste-dislike-remove";
import type { TasteDislike } from "@/lib/profile/taste";

type RpcAnswer = {
  status?: string; action_id?: string; key?: string; settings?: unknown;
  restored?: boolean; capped?: boolean;
};

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { rev?: unknown }).rev === "number";

/** A database refusal that names a malformed request (22023) is the caller's 400; the rest are ours. */
function rpcError(error: { code?: string } | null): HttpError {
  if (error?.code === "22023") return new HttpError(400, E.badRequest, "That dislike cannot be removed.");
  return new HttpError(502, E.failed, "That did not save. Try again with the same action.", { cause: error });
}

function refusal(status: string | undefined): HttpError | null {
  switch (status) {
    case "action_conflict":
      return new HttpError(409, E.actionConflict, "That action was already used for a different dislike.");
    case "settings_not_synced":
      return new HttpError(409, E.settingsNotSynced, "Your settings have not reached the server yet. Try again after it syncs.");
    case "settings_unreadable":
      return new HttpError(409, E.settingsUnreadable, "Your saved preferences could not be read, so nothing was changed.");
    case "not_found":
      return new HttpError(404, E.unknownAction, "No such action.");
    default:
      return null;
  }
}

export async function removeTasteDislike(client: SupabaseClient, userId: string,
  actionId: string, key: TasteDislike): Promise<TasteDislikeRemoveResult> {
  const { data, error } = await client.rpc("taste_dislike_remove",
    { p_user_id: userId, p_action_id: actionId, p_key: key });
  if (error) throw rpcError(error);
  const answer = data as RpcAnswer | null;
  const refused = refusal(answer?.status);
  if (refused) throw refused;
  if ((answer?.status !== "removed" && answer?.status !== "already_gone" && answer?.status !== "existing")
    || typeof answer.key !== "string" || !isRow(answer.settings)) {
    throw new HttpError(502, E.failed, "That did not save. Try again with the same action.", { cause: { status: answer?.status } });
  }
  return {
    status: answer.status, actionId: String(answer.action_id ?? actionId), key: answer.key as TasteDislike,
    settings: answer.settings,
  };
}

export async function undoRemoveTasteDislike(client: SupabaseClient, userId: string,
  actionId: string): Promise<TasteDislikeRemoveUndoResult> {
  const { data, error } = await client.rpc("taste_dislike_remove_undo", { p_user_id: userId, p_action_id: actionId });
  if (error) throw rpcError(error);
  const answer = data as RpcAnswer | null;
  const refused = refusal(answer?.status);
  if (refused) throw refused;
  if ((answer?.status !== "undone" && answer?.status !== "already_undone") || typeof answer.key !== "string"
    || typeof answer.restored !== "boolean" || typeof answer.capped !== "boolean" || !isRow(answer.settings)) {
    throw new HttpError(502, E.failed, "Undo did not save. Try again with the same action.", { cause: { status: answer?.status } });
  }
  return {
    status: answer.status, actionId: String(answer.action_id ?? actionId), key: answer.key as TasteDislike,
    restored: answer.restored, capped: answer.capped, settings: answer.settings,
  };
}
