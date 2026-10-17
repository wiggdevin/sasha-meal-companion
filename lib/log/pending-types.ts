/**
 * The pending-record shape and its bounds. Split out of lib/log/pending.ts (W027) so that module
 * stays under the house rule; lib/log/pending.ts re-exports all of it.
 */
import type { LogCommitRequest } from "@/lib/log/contract";
import type { LoggedFood } from "@/lib/types";

/** Reads after this many stop. The record does NOT go: it becomes `stale`, because an entry the
 *  server has that this phone could never read back is not final (Grok pass 6, HIGH 2). */
export const MAX_ATTEMPTS = 20;

/** The first few retries are every sync; after this they space out, doubling each time. */
export const FREE_ATTEMPTS = 5;

/** The first spaced gap. Doubling from here: a record costs a handful of reads a day at most. */
export const BACKOFF_MS = 60_000;

/**
 * How many unconfirmed records may keep the request the user could retry. Each is one commit body,
 * bounded by the route's own 8 KB, so fifty is under half a megabyte and far more writes than a
 * day of logging could leave unconfirmed. Past that the oldest request is dropped, once, with a
 * warning — and its card stops offering a retry it cannot honour (pass 9, MEDIUM 5; pass 10).
 */
export const MAX_UNCONFIRMED = 50;

/**
 * `deleted` is the user's delete, waiting for the one thing a local delete cannot do by itself: tell the
 * server. It is durable and it is a STATE rather than a module flag, because the commit whose
 * settle has to honour it may be in another tab, and because a page that dies between the user's delete
 * and the server delete must still finish the job on the next launch (Grok pass 12, HIGH 1).
 */
export type PendingState = "in_flight" | "needs_reconcile" | "stale" | "deleted";

export type PendingLogEntry = {
  entryId: string;
  /** Has ANY path seen the server take this entry — a 2xx, a drain's `applied` or `duplicate`, a
   *  row read back? Until one has, the app may not tell the user's it is logged (pass 8, HIGH 2). */
  confirmed: boolean;
  /** What to post if the user taps to try again. Kept only while the entry is unconfirmed. */
  request?: LogCommitRequest;
  /** The card this commit put on Today. The request is ids and grams: a meal's name, the user's note and
   *  every line the wire never carried live here or nowhere (Grok pass 23, HIGH 1). */
  card?: LoggedFood;
  /** The day this entry is filed under. It outlives the request, because Today has to say where
   *  an unsettled meal is long after the server took it (Grok pass 24, HIGH 1). */
  localDate?: string;
  /**
   * The revision this commit was based on, from the request itself — 0 for a create. A row AT that
   * revision is the previous commit's, not this one's, and must not be read as proof that this one
   * landed (Grok pass 8, MEDIUM 1; Grok pass 9, HIGH 3).
   */
  baseRev?: number;
  /** Who committed it. `null` when the session could not be read at the time. */
  userId: string | null;
  /**
   * Is there an outbox op behind this entry? Absent means yes. `false` says the write before the
   * POST could not be made, so no drain will ever send this one (Grok pass 16, HIGH 1).
   */
  durable?: boolean;
  state: PendingState;
  attempts: number;
  markedAt: string;
  /** Not read again before this instant. Spacing, not a deadline: a sync earlier just skips it. */
  nextAttemptAt: number;
};
