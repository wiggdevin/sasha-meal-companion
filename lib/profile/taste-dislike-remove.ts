/**
 * Followups #1: drop one confirmed taste dislike (the read-only pills in Settings), owner-scoped,
 * idempotent, with an exact Undo. Wire contract of `POST /api/profile/taste/dislikes/remove` and
 * `POST /api/profile/taste/dislikes/remove/undo`, shared by the route, the server module
 * (lib/server/taste-dislike-remove.ts) and the phone.
 *
 * Independent of `TASTE_CHIPS_ENABLED`: a dislike pill can already be on the row from the sync
 * path (lib/sync/settings-intents.ts) with chips off, so removing one must not be gated by that
 * flag either.
 *
 * The server decides what was actually removed (migration 20261226090100, `taste_dislike_remove`)
 * and keeps a receipt of EXACTLY that outcome; Undo restores only what its own receipt took off,
 * reporting `restored: false` when there was nothing to put back (already gone, or re-added some
 * other way since). The action id is the request's idempotency key: a retry with the same id and
 * key answers the stored receipt (`existing`); the same id with a different key is refused
 * (`action_conflict`).
 *
 * Any application log of this action carries the action id and outcome only, never `key` — see
 * lib/server/taste-dislike-remove.ts's header.
 *
 * Pure. No I/O.
 */
import { z } from "zod";
import { storedTasteKey, type TasteDislike } from "@/lib/profile/taste";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID);

/**
 * A dislike key a remove request may name: ANY key the storage contract accepts
 * (`storedTasteKey`), exactly as stored -- not only a canonical new-write key (`tasteDislike`). A
 * row written before a canonicalization rule existed, or stored as something like `f:Okra`, must
 * still be removable by its exact stored key; only a string the database could never have
 * accepted (an unknown tag, too long, outside jsonb) is refused with 400.
 */
const dislikeKey = z.string().max(90).refine((value) => storedTasteKey(value) !== null, "not a taste dislike");

/** `POST /api/profile/taste/dislikes/remove`. */
export const tasteDislikeRemoveRequestSchema = z.object({
  actionId: uuid,
  key: dislikeKey,
}).strict();
export type TasteDislikeRemoveRequest = { actionId: string; key: TasteDislike };

/** `POST /api/profile/taste/dislikes/remove/undo`. */
export const tasteDislikeRemoveUndoRequestSchema = z.object({ actionId: uuid }).strict();

/**
 * The remove's 200 body. `removed`: this call actually took `key` off the row. `already_gone`:
 * the key was not on the row when this call ran (idempotent no-op, still recorded so Undo answers
 * `already_undone` cleanly on a repeat, rather than acting on nothing). `existing`: a retry of the
 * same action id and key, answering the stored receipt. `settings`: the `user_settings` row after
 * the call, as the sync feed carries it.
 */
export type TasteDislikeRemoveResult = {
  status: "removed" | "already_gone" | "existing";
  actionId: string;
  key: TasteDislike;
  settings: Record<string, unknown>;
};

/**
 * The Undo's 200 body. `restored`: the key is back on the row because of this Undo. `capped`: it
 * would have restored the key, but the account is already at the 50-dislike cap from something
 * else since the remove — nothing was added. Neither is set for `already_undone` (reads the first
 * Undo's own values).
 */
export type TasteDislikeRemoveUndoResult = {
  status: "undone" | "already_undone";
  actionId: string;
  key: TasteDislike;
  restored: boolean;
  capped: boolean;
  settings: Record<string, unknown>;
};

/** Error codes both routes can answer (`{ error, message }`), with their status. */
export const TASTE_DISLIKE_REMOVE_ERRORS = {
  /** 400: not JSON, or not the request shape (an unknown or non-canonical key). */
  badRequest: "bad_request",
  /** 404 (undo): no remove of the caller's with that action id. */
  unknownAction: "unknown_action",
  /** 409: the action id was used with another key. */
  actionConflict: "action_conflict",
  /** 409 (remove): the account has no settings row on the server yet; sync, then retry. */
  settingsNotSynced: "settings_not_synced",
  /** 409: the stored diet_prefs could not be read as taste, so nothing was changed. */
  settingsUnreadable: "settings_unreadable",
  /** 502: the database refused for an unexpected reason; retry with the same action id. */
  failed: "taste_dislike_remove_failed",
} as const;
