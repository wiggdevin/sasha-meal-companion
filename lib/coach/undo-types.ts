/**
 * Server-recorded coach Undo (AI-integration audit 2026-10-04, P1 #6, criterion C4): the wire
 * shapes and the one rule for which kinds the server can undo. Pure; the client
 * (lib/coach/undo-client.ts) and the server (lib/server/coach-undo.ts) both read it.
 *
 * A record holds the same data the phone's undo token holds (`inverse`). The server can invert a
 * kind when its inverse is one compare-and-swap write through a sync op the phone also sends:
 *
 * | kind | inverse write | "changed since" check |
 * |---|---|---|
 * | log_meal (committed online, revision known) | `log_entries` delete | the entry's revision still equals the commit's, and its date, slot, foods and grams (and, for a composed card's Log it, its exact instant) are the ones the action logged |
 * | log_water (cups after the add known) | `water_log` update, cups minus the added cups (the issued action's own amount) | the day still holds exactly the cups and the row revision the add left; once a record exists, never the phone's token |
 * | skip_slot, restore_slot | `plan_days` update, the slot's previous override | the slot still holds what the action wrote |
 * | add_to_avoid, remove_from_avoid, add_to_eats, remove_from_eats (mark revision known) | `food_membership` (set_food_membership) | the name's membership still holds the revision and status the action's mark wrote |
 *
 * The check and the write run in the database (`perform_coach_undo`, migration 20261210090300),
 * built from the STORED record — the caller sends only the record id — in one transaction with the
 * record's claim, so an Undo either happened completely or not at all; a phone that lost the
 * answer re-reads the record to learn which. This table is the TypeScript twin used for the
 * `serverUndoable` flag; the SQL refuses anything it cannot check (`undo_local_only`).
 *
 * Every other kind (slot edits and meal swaps, which re-resolve the plan on the phone; moves and
 * deletes of entries; weight, profile and target changes, which also restore a target revision;
 * shopping lines) is recorded with `serverUndoable: false` and undoes on the phone that holds its
 * token, as before. A list mark that also changed the food's note is phone-only for the same reason.
 * A legacy `save_recipe` record is phone-only too (docs/specs/coach-undo-receipt.md §5): its only
 * check was the recipe's name, which can match another same-name recipe.
 *
 * Receipt records (`recordMode: "receipt_v1"`, spec §4) are undone from their one immutable receipt
 * (`coach_action_receipts`), never from `inverse`; `receiptServerUndoable` is their rule.
 */
import { z } from "zod";

export const UNDO_TTL_DAYS = 7;
/** The largest inverse the table accepts (`pg_column_size(inverse) <= 32768`), checked first here. */
export const UNDO_INVERSE_MAX_BYTES = 32_000;

/** The actions a receipt can cover (spec §2): each is exactly one write. */
export type ReceiptKind = "log_meal" | "save_recipe" | "set_slot_meal";
export const RECEIPT_KINDS: readonly ReceiptKind[] = ["log_meal", "save_recipe", "set_slot_meal"];

/**
 * How a record undoes (spec §4.1); immutable once stored. `taste_v1` (Phase 18 W5b-2): a confirmed
 * taste-chip card, undone from its `taste_chip_receipts` row (the same action id) only.
 */
export type UndoRecordMode = "legacy" | "receipt_v1" | "taste_v1";
export type SourceCheck = "match" | "mismatch" | "none";

/**
 * What any device draws for one record (spec §6.5). A receipt card is built from the record's
 * receipt only (lib/coach/undo-receipt-card.ts); every legacy record gets the generic card, never
 * one inferred from a coach message.
 */
export type CoachUndoCard =
  | {
    type: "receipt";
    kind: ReceiptKind;
    /** e.g. `Saved the recipe "Eggs on toast"`. */
    title: string;
    /** The foods the write left (a slot's `after`). */
    lines: { name: string | null; grams: number | null }[];
    date: string;
    slot: string | null;
    /** The coach message the action came from; set only when `sourceCheck` is "match". */
    messageId: string | null;
    sourceCheck: SourceCheck;
    /** The one receipt was read. False draws the card from nothing and never server-undoes. */
    complete: boolean;
  }
  | {
    type: "generic";
    kind: string;
    /** The UI shows it with `createdAt` and the Undo state. */
    title: "Coach change";
  }
  | {
    /** Phase 18 W5b-2: a confirmed taste-chip card, drawn from its taste receipt only. */
    type: "taste";
    kind: "confirm_taste_chips";
    title: "Taste preferences added";
    /** Exactly the keys that confirm added (what its Undo may remove). */
    added: { dislikes: string[]; cuisines: string[] };
    /** The receipt was read. False draws the card from nothing and never server-undoes. */
    complete: boolean;
  };

/** What `GET /api/coach/undo` lists and `POST /api/coach/undo` answers, one per applied action. */
export type CoachUndoView = {
  id: string;
  actionId: string;
  kind: string;
  threadId: string | null;
  messageId: string | null;
  createdAt: string;
  expiresAt: string;
  /** Set once the action was undone, here or on the phone that applied it. */
  undoneAt: string | null;
  /**
   * Past `expiresAt`: the server no longer undoes it, but the phone holding the token still can,
   * and then marks it undone. Kept as a tombstone (inverse scrubbed) after a day, never deleted.
   */
  expired: boolean;
  /** The server can perform this Undo now; otherwise only the phone holding the token can. */
  serverUndoable: boolean;
  /**
   * For a logged meal, the entry it wrote: after a server Undo the phone removes it from its day
   * (lib/coach/undo-projection.ts), on a device without the token too.
   */
  target?: { date: string; entryId: string };
  /** How any device draws this record (spec §6.5). */
  card: CoachUndoCard;
};

/** `POST /api/coach/undo/{id}`'s 200 body. Errors are the shared `{ error, message }` shape. */
export type CoachUndoResult = { undo: CoachUndoView; performed: "server" | "local" };

/**
 * `GET /api/coach/undo`'s 200 body: one page of records, newest first, and the cursor for the
 * next (older) page — null when this was the last (review t25 #3, paging only).
 */
export type CoachUndoPage = { undos: CoachUndoView[]; next: string | null };

/** The error codes `POST /api/coach/undo/{id}` can answer, with their HTTP status. */
export const UNDO_ERRORS = {
  /** 404: no record of this account's with that id. */
  notFound: "not_found",
  /** 409: undone before (by any device). */
  alreadyUndone: "undo_already_undone",
  /** 409: a later change exists; the record's expected state no longer matches. Nothing written. */
  conflict: "undo_conflict",
  /** 409: the server has not seen the action's own write yet (still queued on the phone). */
  notSynced: "undo_not_synced",
  /** 410: past `expires_at`. */
  expired: "undo_expired",
  /** 422: this kind undoes only on the phone that holds its token. */
  localOnly: "undo_local_only",
  /** 409: same revision, other identity (items, ingredients, revision id, mutationId). Nothing written. */
  receiptMismatch: "undo_receipt_mismatch",
  /** 422: a receipt record without exactly one matching receipt. */
  receiptInconsistent: "undo_receipt_inconsistent",
  /** 422: the receipt's source check is not "match"; only the phone that made it can undo it. */
  sourceMismatch: "undo_source_mismatch",
  /** 409: a phone-side close (`local`, `undone`) of a receipt record; undo it from the list. */
  receiptRecord: "undo_receipt_record",
} as const;

const uuid = z.uuid();

export const recordUndoSchema = z.object({
  actionId: z.string().min(1).max(128),
  kind: z.string().min(1).max(64),
  /** The undo token `apply` returned, as JSON. */
  token: z.record(z.string(), z.unknown()),
  /** Narrows the message lookup; the server still finds the message by the action id. */
  threadId: uuid.optional(),
  /**
   * A composed meal card's button (Log it, Put it in …, Save as recipe) mints its action id at the
   * tap, so no saved message carries it: the card's message and index stand in, and the server
   * checks that card exists in that message of the caller's.
   */
  source: z.object({ messageId: uuid, cardIndex: z.number().int().min(0).max(50) }).optional(),
  /**
   * The phone already undid it through its token: store the record undone (or mark the existing
   * one), so a late record or another device can never undo it a second time.
   */
  undone: z.boolean().optional(),
});
export type RecordUndoRequest = z.infer<typeof recordUndoSchema>;

/** `local: true` says the phone already undid it through its token: only mark the record. */
export const performUndoSchema = z.object({ local: z.boolean().optional() });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isLocalDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const LIST_KINDS = new Set(["add_to_avoid", "remove_from_avoid", "add_to_eats", "remove_from_eats"]);
const isRev = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The token as stored: JSON only (a function such as a test's `fetchImpl` is dropped). */
export function inverseOf(token: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(token)) as Record<string, unknown>;
}

/** The revision the action left behind, when the token knows it. */
export function expectedRevOf(kind: string, inverse: Record<string, unknown>): number | null {
  // A meal the phone queued offline has no commit revision yet, but its entry id is new, so the
  // queued create lands at revision 1 (apply_sync_op) — the revision the server checks once it
  // syncs (review t4r11 #2). A later edit moves it, and the server Undo then refuses.
  if (kind === "log_meal") return isRev(inverse.baseRev) ? inverse.baseRev : inverse.baseRev === null ? 1 : null;
  if (kind === "save_recipe") return isRev(inverse.rev) ? inverse.rev : null;
  if (kind === "log_water") return isRev(inverse.afterRev) ? inverse.afterRev : null;
  if (LIST_KINDS.has(kind)) return isRev(inverse.markRev) ? inverse.markRev : null;
  return null;
}

/** Whether the server can perform this record's Undo (see the table above). */
export function isServerUndoable(kind: string, inverse: Record<string, unknown>): boolean {
  switch (kind) {
    // The commit's revision, or 1 for a meal queued offline (its create lands at 1).
    case "log_meal": return isLocalDate(inverse.date) && isString(inverse.entryId)
      && (isRev(inverse.baseRev) || inverse.baseRev === null);
    // Water is additive: only the exact cups the add left prove nothing else (an Undo included) ran.
    // ...and the row revision the add left: the same count after a later edit is not that row.
    case "log_water": return isLocalDate(inverse.date) && typeof inverse.cups === "number"
      && Number.isSafeInteger(inverse.cups) && inverse.cups > 0 && isRev(inverse.after)
      && inverse.after >= inverse.cups && isRev(inverse.afterRev);
    case "skip_slot":
    case "restore_slot":
      return isLocalDate(inverse.date) && isString(inverse.slot)
        && "applied" in inverse && "previous" in inverse;
    // Phone-only (spec §5): the legacy check was the recipe's name.
    case "save_recipe": return false;
    case "add_to_avoid":
    case "remove_from_avoid":
    case "add_to_eats":
    case "remove_from_eats": {
      // nameNorm is stamped by the record route; the database writes the membership by it, and
      // only while the membership still holds the revision this mark wrote (markRev).
      if ((!isString(inverse.name) && !isString(inverse.nameNorm)) || !isRev(inverse.markRev)) return false;
      const previous = isRecord(inverse.previous) ? inverse.previous : null;
      // Restoring an earlier note is a second write (save_food_note) the phone owns.
      return !(inverse.appliedNote !== undefined && previous?.status);
    }
    default: return false;
  }
}

/**
 * Whether the server can undo a receipt record now (spec §6.5): open, unexpired, its one receipt
 * read, and the receipt's source check a match.
 */
export function receiptServerUndoable(record: { undoneAt: string | null; expired: boolean },
  card: CoachUndoCard): boolean {
  return record.undoneAt === null && !record.expired && card.type === "receipt" && card.complete
    && card.sourceCheck === "match";
}

/** A taste record (record_mode `taste_v1`): the server undoes it while open, unexpired and receipted. */
export function tasteServerUndoable(record: { undoneAt: string | null; expired: boolean },
  card: CoachUndoCard): boolean {
  return record.undoneAt === null && !record.expired && card.type === "taste" && card.complete;
}
