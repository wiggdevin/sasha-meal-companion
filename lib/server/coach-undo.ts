/**
 * Server-recorded coach Undo (AI-integration audit 2026-10-04, P1 #6, criterion C4).
 *
 * `recordUndo` stores one `coach_action_undos` row per applied coach action through
 * `record_coach_undo`, only for an action id that one of the account's own coach messages carries,
 * with the same kind — or stores/closes it undone when the phone already undid the action itself,
 * so a late record can never re-enable it.
 *
 * `performUndo` sends only the record id to `perform_coach_undo` (migration 20261210090300). The
 * database builds the inverse write FROM the stored record, checks under row locks that the target
 * still holds what the action left (409 `undo_conflict`) or holds it at all (409
 * `undo_not_synced`), writes it through the sync RPC the phone's own op uses, and stamps
 * `undone_at` — one transaction. Nothing a caller sends can change what is written.
 *
 * Every read runs on the caller's own session client (RLS) with explicit `user_id` filters; the
 * RPC scopes to auth.uid(). Another account's record answers 404.
 *
 * Receipt records (docs/specs/coach-undo-receipt.md, `record_mode = 'receipt_v1'`) are drawn and
 * undone from their one immutable receipt (`coach_action_receipts`), never from `inverse`. The list
 * reads a page of records, then the receipts of its receipt records through the paged reader; any
 * failed page fails the whole request (500 `undo_store_failed`), never a partial list (§6.4).
 * Every legacy record is drawn as the generic "Coach change" card (§5).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import {
  expectedRevOf, inverseOf, isServerUndoable, UNDO_ERRORS, UNDO_INVERSE_MAX_BYTES,
  type CoachUndoPage, type CoachUndoView, type RecordUndoRequest,
} from "@/lib/coach/undo-types";
import { normalizeFoodName } from "@/lib/foods/normalize";
import {
  genericCard, receiptCard, tasteCard, type ReceiptRow, type TasteReceiptRow,
} from "@/lib/coach/undo-receipt-card";
import { receiptServerUndoable, tasteServerUndoable } from "@/lib/coach/undo-types";
import { fetchAllChunked } from "@/lib/server/paged-read";

const TABLE = "coach_action_undos";
const COLUMNS = "id, user_id, thread_id, message_id, action_id, kind, inverse, expected_rev, "
  + "created_at, undone_at, expires_at, record_mode, source_check";
const RECEIPTS = "coach_action_receipts";
const RECEIPT_COLUMNS = "id, action_id, kind, source, source_check, applied";
const TASTE_RECEIPTS = "taste_chip_receipts";
const TASTE_RECEIPT_COLUMNS = "id, action_id, added_dislikes, added_cuisines";
/** One page of records; older ones follow through the `before` cursor (review t25 #3, paging only). */
/** 500 a page under the route's one 60-a-minute limit: a full list of up to 30,000 records fits. */
export const LIST_LIMIT = 500;
const LIST_KINDS = new Set(["add_to_avoid", "remove_from_avoid", "add_to_eats", "remove_from_eats"]);

export type UndoRow = {
  id: string; user_id: string; thread_id: string | null; message_id: string | null;
  action_id: string; kind: string; inverse: Record<string, unknown>; expected_rev: number | null;
  created_at: string; undone_at: string | null; expires_at: string;
  /** Absent only on a database before 20261216090100: every such row is legacy. */
  record_mode?: string | null; source_check?: string | null;
};

const isReceiptRecord = (row: UndoRow) => row.record_mode === "receipt_v1";
/** Phase 18 W5b-2: a confirmed taste-chip card, undone from its taste receipt only. */
const isTasteRecord = (row: UndoRow) => row.record_mode === "taste_v1";

/**
 * One record as the wire carries it. A receipt record needs its receipt (`null` when the read held
 * none: an incomplete card, never server-undoable); a legacy record ignores it.
 */
export function toUndoView(row: UndoRow, now: Date = new Date(),
  receipt: ReceiptRow | null = null, tasteReceipt: TasteReceiptRow | null = null): CoachUndoView {
  const expired = Date.parse(row.expires_at) <= now.getTime();
  const base = {
    id: row.id, actionId: row.action_id, kind: row.kind, threadId: row.thread_id,
    messageId: row.message_id, createdAt: row.created_at, expiresAt: row.expires_at,
    undoneAt: row.undone_at, expired,
  };
  if (isTasteRecord(row)) {
    const card = tasteCard(tasteReceipt);
    return { ...base, card, serverUndoable: tasteServerUndoable(base, card) };
  }
  if (isReceiptRecord(row)) {
    const card = receiptCard({ kind: row.kind, createdAt: row.created_at,
      sourceCheck: row.source_check ?? null }, receipt);
    const applied = card.type === "receipt" && card.complete ? receipt?.applied : undefined;
    return {
      ...base, card, serverUndoable: receiptServerUndoable(base, card),
      // A server Undo takes the meal off every phone's day by the entry the receipt names.
      ...(row.kind === "log_meal" && typeof applied?.date === "string"
        && typeof applied.entryId === "string"
        ? { target: { date: applied.date, entryId: applied.entryId } } : {}),
    };
  }
  return {
    ...base, card: genericCard(row.kind),
    serverUndoable: !expired && isServerUndoable(row.kind, row.inverse),
    ...(row.kind === "log_meal" && typeof row.inverse.date === "string"
      && typeof row.inverse.entryId === "string"
      ? { target: { date: row.inverse.date, entryId: row.inverse.entryId } } : {}),
  };
}

/**
 * The receipts of the receipt records among `rows`, by action id: one paged, all-or-nothing read
 * (spec §6.4). Any failed page throws 500 `undo_store_failed`; nothing partial is returned.
 */
async function receiptsFor(client: SupabaseClient, userId: string, rows: readonly UndoRow[]):
  Promise<Map<string, ReceiptRow>> {
  const actionIds = [...new Set(rows.filter(isReceiptRecord).map((row) => row.action_id))];
  if (actionIds.length === 0) return new Map();
  let receipts: ReceiptRow[];
  try {
    receipts = await fetchAllChunked<string, ReceiptRow>(actionIds, (batch, from, to) =>
      client.from(RECEIPTS).select(RECEIPT_COLUMNS).eq("user_id", userId).in("action_id", batch)
        .order("id", { ascending: true }).range(from, to)
        .then(({ data, error }) => ({ data: data as unknown as ReceiptRow[] | null, error })));
  } catch (error) {
    throw dbError("Could not read the undo receipts.", error);
  }
  return new Map(receipts.map((receipt) => [receipt.action_id, receipt]));
}

/** The taste receipts of the taste records among `rows`, by action id: paged and all-or-nothing. */
async function tasteReceiptsFor(client: SupabaseClient, userId: string, rows: readonly UndoRow[]):
  Promise<Map<string, TasteReceiptRow>> {
  const actionIds = [...new Set(rows.filter(isTasteRecord).map((row) => row.action_id))]
    .filter((id) => UUID.test(id));
  if (actionIds.length === 0) return new Map();
  let receipts: TasteReceiptRow[];
  try {
    receipts = await fetchAllChunked<string, TasteReceiptRow>(actionIds, (batch, from, to) =>
      client.from(TASTE_RECEIPTS).select(TASTE_RECEIPT_COLUMNS).eq("user_id", userId).in("action_id", batch)
        .order("id", { ascending: true }).range(from, to)
        .then(({ data, error }) => ({ data: data as unknown as TasteReceiptRow[] | null, error })));
  } catch (error) {
    throw dbError("Could not read the undo receipts.", error);
  }
  return new Map(receipts.map((receipt) => [receipt.action_id.toLowerCase(), receipt]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function viewsOf(client: SupabaseClient, userId: string, rows: readonly UndoRow[],
  now: Date): Promise<CoachUndoView[]> {
  const [receipts, tasteReceipts] = await Promise.all([
    receiptsFor(client, userId, rows), tasteReceiptsFor(client, userId, rows)]);
  return rows.map((row) => toUndoView(row, now, receipts.get(row.action_id) ?? null,
    tasteReceipts.get(row.action_id.toLowerCase()) ?? null));
}

function dbError(message: string, cause: unknown): HttpError {
  return new HttpError(500, "undo_store_failed", message, { cause });
}

const RPC_ERRORS: Record<string, () => HttpError> = {
  undo_conflict: () => new HttpError(409, UNDO_ERRORS.conflict,
    "That has changed since, so Undo left it alone."),
  undo_not_synced: () => new HttpError(409, UNDO_ERRORS.notSynced,
    "That change has not reached the server yet. Undo it on the phone that made it."),
  undo_local_only: () => new HttpError(422, UNDO_ERRORS.localOnly,
    "This change can only be undone on the phone that made it."),
  undo_receipt_mismatch: () => new HttpError(409, UNDO_ERRORS.receiptMismatch,
    "That no longer matches what the coach changed, so Undo left it alone."),
  undo_receipt_inconsistent: () => new HttpError(422, UNDO_ERRORS.receiptInconsistent,
    "This change can only be undone on the phone that made it."),
  undo_source_mismatch: () => new HttpError(422, UNDO_ERRORS.sourceMismatch,
    "This change can only be undone on the phone that made it."),
  undo_receipt_record: () => new HttpError(409, UNDO_ERRORS.receiptRecord,
    "This was recorded by the server. Undo it from the list."),
};

/** The RPC refusal a database error carries, if it is one of ours. */
function knownRefusal(error: unknown): HttpError | null {
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  const known = Object.keys(RPC_ERRORS).find((code) => message.includes(code));
  return known ? RPC_ERRORS[known]() : null;
}

async function readById(client: SupabaseClient, userId: string, id: string): Promise<UndoRow | null> {
  const { data, error } = await client.from(TABLE).select(COLUMNS)
    .eq("user_id", userId).eq("id", id).maybeSingle();
  if (error) throw dbError("Could not read the undo record.", error);
  return (data as unknown as UndoRow | null) ?? null;
}

type RpcAnswer = { status: "undone" | "not_found" | "already_undone" | "expired"; undone_at?: string };

/** One transaction in the database; `local` only marks the record (allowed after expiry). */
async function runUndo(client: SupabaseClient, row: UndoRow, local: boolean): Promise<UndoRow> {
  const { data, error } = await client.rpc("perform_coach_undo",
    { p_undo_id: row.id, p_local: local });
  if (error) {
    const known = knownRefusal(error);
    if (known) throw known;
    // Rolled back: nothing was written and the record is still open.
    throw new HttpError(502, "undo_failed", "Undo did not save. Try again.", { cause: error });
  }
  const answer = data as RpcAnswer | null;
  switch (answer?.status) {
    case "undone": return { ...row, undone_at: answer.undone_at ?? new Date().toISOString() };
    case "already_undone":
      throw new HttpError(409, UNDO_ERRORS.alreadyUndone, "This was already undone.");
    case "expired": throw new HttpError(410, UNDO_ERRORS.expired, "This can no longer be undone.");
    case "not_found": throw new HttpError(404, UNDO_ERRORS.notFound, "No such undo.");
    default: throw new HttpError(502, "undo_failed", "Undo did not save. Try again.");
  }
}

/** The stored inverse: the token, plus the normalized name a list mark's Undo writes by. */
function storedInverse(kind: string, token: Record<string, unknown>): Record<string, unknown> {
  const inverse = inverseOf(token);
  delete inverse.nameNorm;
  if (LIST_KINDS.has(kind) && typeof inverse.name === "string" && inverse.name.length > 0) {
    inverse.nameNorm = normalizeFoodName(inverse.name);
  }
  return inverse;
}

type RecordAnswer = { status: "ok"; row: UndoRow }
  | { status: "unknown_action" | "kind_mismatch" | "target_mismatch" };

/**
 * Record one applied action through `record_coach_undo`, which checks in the database that one of
 * the caller's own coach messages carries the action id with this kind (clients cannot insert
 * directly). A repeat answers the existing record (409 when its kind differs). With `undone`, the
 * phone already undid it: the record is stored, or closed, undone.
 */
export async function recordUndo(client: SupabaseClient, userId: string, body: RecordUndoRequest,
  now: Date = new Date()): Promise<CoachUndoView> {
  if (body.token.kind !== body.kind) {
    throw new HttpError(400, "bad_request", "The undo token does not match the action kind.");
  }
  const inverse = storedInverse(body.kind, body.token);
  if (JSON.stringify(inverse).length > UNDO_INVERSE_MAX_BYTES) {
    throw new HttpError(413, "undo_too_large", "This action's undo record is too large to keep.");
  }
  const { data, error } = await client.rpc("record_coach_undo", {
    p_action_id: body.actionId, p_kind: body.kind, p_inverse: inverse,
    p_expected_rev: expectedRevOf(body.kind, inverse), p_thread_id: body.threadId ?? null,
    p_undone: body.undone === true,
    p_source_message: body.source?.messageId ?? null, p_source_card: body.source?.cardIndex ?? null,
  });
  if (error) {
    // A receipt record is never closed by the phone (spec §4.5): 409 undo_receipt_record.
    const known = knownRefusal(error);
    if (known?.code === UNDO_ERRORS.receiptRecord) throw known;
    throw dbError("Could not save the undo record.", error);
  }
  const answer = data as RecordAnswer | null;
  if (answer?.status === "ok") return (await viewsOf(client, userId, [answer.row], now))[0];
  if (answer?.status === "unknown_action") {
    throw new HttpError(404, "unknown_action", "No coach message carries that action.");
  }
  if (answer?.status === "kind_mismatch") {
    throw new HttpError(409, "undo_kind_mismatch", "That action was recorded as another kind.");
  }
  if (answer?.status === "target_mismatch") {
    throw new HttpError(409, "undo_target_mismatch", "The undo token names another target than the action.");
  }
  throw dbError("Could not save the undo record.", answer);
}

export type UndoFilter = {
  threadId?: string; messageId?: string; actionId?: string;
  /** A previous page's `next`: this page holds only older records than it (review t25 #3). */
  before?: UndoCursor;
};
export type UndoCursor = { createdAt: string; id: string };

/** `next` on the wire: `<created_at ISO>,<id>` (paging only — no card display, no source batch). */
export function encodeCursor(row: Pick<UndoRow, "created_at" | "id">): string {
  return `${row.created_at},${row.id}`;
}

/** A timestamptz as PostgREST writes it. `Date.parse` alone took "Thu, 01 Jan 2026" and other
 *  shapes that reach the quoted `or()` filter and fail the Postgres cast (W012, A126). */
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function decodeCursor(value: string): UndoCursor | null {
  const at = value.lastIndexOf(",");
  if (at <= 0) return null;
  const createdAt = value.slice(0, at);
  const id = value.slice(at + 1);
  if (!CURSOR_INSTANT.test(createdAt) || Number.isNaN(Date.parse(createdAt))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { createdAt, id };
}

/**
 * One page of the account's records, newest first (created_at, then id as the tiebreak), expired
 * ones included (flagged `expired`; scrubbed tombstones too), so a phone can tell "expired, not
 * undone" from "never recorded". `next` carries the cursor for the next (older) page, or null when
 * this was the last — a caller that wants every record follows it until null
 * (lib/coach/undo-client.ts `listCoachUndos`).
 */
export async function listUndos(client: SupabaseClient, userId: string, filter: UndoFilter,
  now: Date = new Date()): Promise<CoachUndoPage> {
  let query = client.from(TABLE).select(COLUMNS).eq("user_id", userId);
  if (filter.threadId) query = query.eq("thread_id", filter.threadId);
  if (filter.messageId) query = query.eq("message_id", filter.messageId);
  if (filter.actionId) query = query.eq("action_id", filter.actionId);
  if (filter.before) {
    const { createdAt, id } = filter.before;
    query = query.or(`created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt.${id})`);
  }
  const { data, error } = await query.order("created_at", { ascending: false })
    .order("id", { ascending: false }).limit(LIST_LIMIT + 1);
  if (error) throw dbError("Could not read the undo records.", error);
  // One row past the page says whether another page exists, so a last full page ends the list.
  const fetched = (data as unknown as UndoRow[] | null) ?? [];
  const rows = fetched.slice(0, LIST_LIMIT);
  return {
    undos: await viewsOf(client, userId, rows, now),
    next: fetched.length > LIST_LIMIT ? encodeCursor(rows[rows.length - 1]) : null,
  };
}

/**
 * Undo one record. `local: true` only marks it (the phone already undid it through its token;
 * allowed after expiry). Answers the record after the Undo, or throws an HttpError carrying one of
 * UNDO_ERRORS. Only the id reaches the database.
 */
export async function performUndo(client: SupabaseClient, userId: string, id: string,
  opts: { local?: boolean } = {}, now: Date = new Date()): Promise<CoachUndoView> {
  const row = await readById(client, userId, id);
  if (!row) throw new HttpError(404, UNDO_ERRORS.notFound, "No such undo.");
  if (isTasteRecord(row)) {
    // Phase 18 W5b-2: no phone holds an inverse for it; the database refuses `local` too.
    if (opts.local) throw RPC_ERRORS.undo_receipt_record();
    await runUndo(client, row, false);
    return (await viewsOf(client, userId, [await readById(client, userId, id) ?? row], now))[0];
  }
  if (isReceiptRecord(row)) {
    // The database refuses it too; only a verified inverse closes a receipt record (spec §4.5).
    if (opts.local) throw RPC_ERRORS.undo_receipt_record();
    // Every receipt refusal (inconsistent, source, conflict, mismatch) is the database's to give.
    const receipts = await receiptsFor(client, userId, [row]);
    const done = await runUndo(client, row, false);
    return toUndoView(done, now, receipts.get(row.action_id) ?? null);
  }
  const view = toUndoView(row, now);
  // The database refuses these too (undo_local_only); answering here saves the round trip.
  if (!opts.local && !view.undoneAt && !view.expired && !view.serverUndoable) {
    throw RPC_ERRORS.undo_local_only();
  }
  return toUndoView(await runUndo(client, row, opts.local === true), now);
}
