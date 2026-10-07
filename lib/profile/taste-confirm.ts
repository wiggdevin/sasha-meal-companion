/**
 * Confirmed taste chips, written on the server (Phase 18 W5b-2, D6, D9 item 3): the wire contract
 * of `POST /api/profile/taste/confirm` and `POST /api/profile/taste/undo`, shared by the route, the
 * server module (lib/server/taste-confirm.ts) and the phone (lib/profile/taste-confirm-client.ts).
 *
 * The server adds each confirmed chip the row lacks (never past 50 dislikes or 6 cuisines) and keeps
 * a receipt of EXACTLY the keys that call added (`taste_chip_receipts`). Undo removes only those keys
 * that are still present and reports the rest as `gone`. The action id is the request's idempotency
 * key, minted once per user tap: a retry with the same id and request answers the stored receipt
 * (`existing`); the same id with another request is refused (`action_conflict`). Attribution never
 * depends on the phone.
 *
 * Pure. No I/O.
 */
import { z } from "zod";
import { CUISINES, CUISINES_MAX, type CuisineKey } from "@/lib/profile/cuisines";
import { TASTE_DISLIKES_MAX, tasteDislike, type TasteDislike } from "@/lib/profile/taste";

export const TASTE_CONFIRM_SOURCES = ["settings", "onboarding", "coach"] as const;
export type TasteConfirmSource = (typeof TASTE_CONFIRM_SOURCES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID);

/** A dislike key a new write may carry: canonical (`tasteDislike`), not just storable. */
const dislikeKey = z.string().max(90).refine((value) => tasteDislike(value) === value, "not a taste dislike");
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** The coach card the chips came from: one of the caller's own assistant messages and its proposal. */
export const tasteCoachSourceSchema = z.object({
  messageId: uuid,
  proposalId: z.string().min(1).max(64),
}).strict();
export type TasteCoachSource = z.infer<typeof tasteCoachSourceSchema>;

/**
 * `POST /api/profile/taste/confirm`. `coach` is required with `source: "coach"` and refused
 * otherwise; at least one chip; no repeats.
 */
export const tasteConfirmRequestSchema = z.object({
  actionId: uuid,
  source: z.enum(TASTE_CONFIRM_SOURCES),
  dislikes: z.array(dislikeKey).max(TASTE_DISLIKES_MAX).refine(unique, "repeated dislike"),
  cuisines: z.array(z.enum(CUISINES)).max(CUISINES_MAX).refine(unique, "repeated cuisine"),
  coach: tasteCoachSourceSchema.optional(),
}).strict()
  .refine((body) => body.dislikes.length + body.cuisines.length > 0, "no chip")
  .refine((body) => (body.source === "coach") === (body.coach !== undefined), "coach source");
export type TasteConfirmRequest = {
  actionId: string;
  source: TasteConfirmSource;
  dislikes: TasteDislike[];
  cuisines: CuisineKey[];
  coach?: TasteCoachSource;
};

/** `POST /api/profile/taste/undo`. */
export const tasteUndoRequestSchema = z.object({ actionId: uuid }).strict();

export type TasteKeys = { dislikes: string[]; cuisines: string[] };

/**
 * The confirm's 200 body. `added`: exactly what THIS action wrote (and what its Undo may remove).
 * `present`: asked for, already on the row. `capped`: asked for, not written (50 / 6 reached).
 * `settings`: the `user_settings` row after the call, as the sync feed carries it, at `settings.rev`.
 */
export type TasteConfirmResult = {
  status: "applied" | "existing";
  actionId: string;
  added: TasteKeys;
  present: TasteKeys;
  capped: TasteKeys;
  undoneAt: string | null;
  settings: Record<string, unknown>;
};

/** The Undo's 200 body. `removed` came off the row now; `gone` had already left it and stayed gone. */
export type TasteUndoResult = {
  status: "undone" | "already_undone";
  actionId: string;
  removed: TasteKeys;
  gone: TasteKeys;
  undoneAt: string;
  /** Null only when the account has no settings row on the server. */
  settings: Record<string, unknown> | null;
};

/** Error codes both routes can answer (`{ error, message }`), with their status. */
export const TASTE_CONFIRM_ERRORS = {
  /** 400: not JSON, or not the request shape (an unknown or non-canonical key, a repeat, no chip). */
  badRequest: "bad_request",
  /** 404: the flag is off (`TASTE_CHIPS_ENABLED`). */
  notEnabled: "not_enabled",
  /** 404 (confirm, coach): no such card on the caller's own assistant message. */
  unknownProposal: "unknown_proposal",
  /** 404 (undo): no confirm of the caller's with that action id. */
  unknownAction: "unknown_action",
  /** 409: the action id was used with another request (or names another coach record). */
  actionConflict: "action_conflict",
  /** 409 (confirm): the account has no settings row on the server yet; sync, then retry. */
  settingsNotSynced: "settings_not_synced",
  /** 409: the stored diet_prefs cannot be read as an object; nothing written. */
  settingsUnreadable: "settings_unreadable",
  /** 422 (confirm, coach): a chip the card did not offer. */
  chipNotProposed: "chip_not_proposed",
  /** 502: the write failed and was rolled back; retry with the same action id. */
  failed: "taste_confirm_failed",
} as const;
