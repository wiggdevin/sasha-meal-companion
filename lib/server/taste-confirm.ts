import "server-only";

/**
 * Confirmed taste chips (Phase 18 W5b-2): the two RPCs of migration 20261220090000 on the caller's
 * own session client. `taste_chips_confirm` and `taste_chips_undo` run in one transaction each, under
 * the user_settings lock every settings writer takes; the database decides what was added and what
 * an Undo removes, from its receipt only. Nothing here computes or trusts a key list from the phone
 * beyond the request it validates.
 *
 * Dark behind `TASTE_CHIPS_ENABLED` (the routes answer 404 while it is unset).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import {
  TASTE_CONFIRM_ERRORS as E, type TasteConfirmRequest, type TasteConfirmResult, type TasteKeys,
  type TasteUndoResult,
} from "@/lib/profile/taste-confirm";

type Keys = { dislikes?: unknown; cuisines?: unknown } | null | undefined;
type RpcAnswer = {
  status?: string; action_id?: string; added?: Keys; present?: Keys; capped?: Keys; removed?: Keys;
  gone?: Keys; undone_at?: string | null; settings?: unknown;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const keysOf = (value: Keys): TasteKeys => ({ dislikes: strings(value?.dislikes), cuisines: strings(value?.cuisines) });
const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { rev?: unknown }).rev === "number";

/** A database refusal that names a malformed request (22023) is the caller's 400; the rest are ours. */
function rpcError(error: { code?: string } | null, message: string): HttpError {
  if (error?.code === "22023") return new HttpError(400, E.badRequest, "Those chips cannot be saved.");
  return new HttpError(502, E.failed, message, { cause: error });
}

function refusal(status: string | undefined): HttpError | null {
  switch (status) {
    case "action_conflict":
      return new HttpError(409, E.actionConflict, "That confirmation was already used for other chips.");
    case "settings_not_synced":
      return new HttpError(409, E.settingsNotSynced, "Your settings have not reached the server yet. Try again after it syncs.");
    case "settings_unreadable":
      return new HttpError(409, E.settingsUnreadable, "Your saved preferences could not be read, so nothing was changed.");
    case "unknown_proposal":
      return new HttpError(404, E.unknownProposal, "That suggestion is no longer available.");
    case "chip_not_proposed":
      return new HttpError(422, E.chipNotProposed, "That chip was not one the coach suggested.");
    case "not_found":
      return new HttpError(404, E.unknownAction, "No such confirmation.");
    default:
      return null;
  }
}

export async function confirmTasteChips(client: SupabaseClient, userId: string,
  body: TasteConfirmRequest): Promise<TasteConfirmResult> {
  const { data, error } = await client.rpc("taste_chips_confirm", {
    p_user_id: userId, p_action_id: body.actionId, p_source: body.source,
    p_dislikes: body.dislikes, p_cuisines: body.cuisines, p_coach: body.coach ?? null,
  });
  if (error) throw rpcError(error, "Those chips did not save. Try again.");
  const answer = data as RpcAnswer | null;
  const refused = refusal(answer?.status);
  if (refused) throw refused;
  if ((answer?.status !== "applied" && answer?.status !== "existing") || !isRow(answer.settings)) {
    throw new HttpError(502, E.failed, "Those chips did not save. Try again.", { cause: answer });
  }
  return {
    status: answer.status, actionId: String(answer.action_id ?? body.actionId),
    added: keysOf(answer.added), present: keysOf(answer.present), capped: keysOf(answer.capped),
    undoneAt: typeof answer.undone_at === "string" ? answer.undone_at : null,
    settings: answer.settings,
  };
}

export async function undoTasteChips(client: SupabaseClient, userId: string,
  actionId: string): Promise<TasteUndoResult> {
  const { data, error } = await client.rpc("taste_chips_undo", { p_user_id: userId, p_action_id: actionId });
  if (error) throw rpcError(error, "Undo did not save. Try again.");
  const answer = data as RpcAnswer | null;
  const refused = refusal(answer?.status);
  if (refused) throw refused;
  if ((answer?.status !== "undone" && answer?.status !== "already_undone")
    || typeof answer.undone_at !== "string" || (answer.settings !== null && !isRow(answer.settings))) {
    throw new HttpError(502, E.failed, "Undo did not save. Try again.", { cause: answer });
  }
  return {
    status: answer.status, actionId: String(answer.action_id ?? actionId),
    removed: keysOf(answer.removed), gone: keysOf(answer.gone), undoneAt: answer.undone_at,
    settings: answer.settings === null ? null : answer.settings as Record<string, unknown>,
  };
}
