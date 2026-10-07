"use client";

/**
 * The phone's half of server-recorded coach Undo (audit 2026-10-04 P1 #6, criterion C4).
 *
 * After an apply, `startRecording` posts the token (the local token is kept too). `undoViaServer`
 * runs inside `undoCoachAction`'s per-action lock, after any in-flight record for that action has
 * settled, and decides who performs the Undo:
 *
 * - the server, when it holds a record it can invert (any device, after storage was cleared, past
 *   the local cap). Its claim and write are one transaction, so the answer is all or nothing;
 * - this phone's token, only when the server definitely did not and will not: no record, a
 *   phone-only kind, the write not synced yet, or the record not found or expired. Then the phone
 *   marks the record undone (creating it undone if needed) before the lock is released, so a late
 *   record or another device can never undo it again;
 * - nobody, when the outcome is unknown: a 5xx or a dropped answer re-reads the record; unless it
 *   shows the Undo done, the call fails with the token kept, and the next tap asks the server again.
 *   An unreadable server refuses the same way for a record this phone saw stored (another device
 *   may have undone it); an action it never stored still undoes offline through the token.
 *
 * This phone never applies a token twice: every Undo first checks a durable list of actions it
 * knows are undone (by its token or on the server).
 *
 * A queued record is always asked for fresh before its token is used, so a record stored despite
 * a lost answer is honoured whenever the server can be read. A post that may have left (a
 * rejected fetch or a 5xx) counts as possibly stored: while the server cannot be read, its token
 * waits. Only a record the phone never sent (it was offline) lets the token run unread.
 *
 * A record or mark that cannot be sent waits in an account-scoped queue and is sent before the
 * next Undo. Routes: app/api/coach/undo, app/api/coach/undo/[id]; rules: lib/coach/undo-types.ts.
 */

import { accountFetch, accountJson, accountKey, AccountChanged, isCurrent, type AccountHandle }
  from "@/lib/device/account";
import { UNDO_ERRORS, type CoachUndoPage, type CoachUndoView } from "@/lib/coach/undo-types";
import { DEADLINES, DeadlineExceeded } from "@/lib/fetch-with-deadline";

export type { CoachUndoPage, CoachUndoView } from "@/lib/coach/undo-types";

type Opts = { fetchImpl?: typeof fetch };
type Source = { messageId: string; cardIndex: number };
type Pending = {
  actionId: string; kind: string; token: object; threadId?: string; source?: Source; undone: boolean;
  /**
   * A post of this record may have reached the server although no answer came back (a dropped
   * response or a 5xx), so the server may hold it — and another device may have undone it.
   */
  maybeStored?: boolean;
};

const PENDING_KEY = "coach-undo:pending";
/** Action ids whose record this phone saw stored: only these can have been undone elsewhere. */
const STORED_KEY = "coach-undo:stored";
/**
 * Action ids this phone knows are undone (by its token or on the server). Checked first by every
 * Undo, so a token is never applied twice, whatever the queue or the server says (review t4r2 #1).
 */
const DONE_KEY = "coach-undo:done";
const PENDING_LIMIT = 200;
export const UNDO_UNCONFIRMED_REASON = "Undo could not be confirmed. Check the connection and try again.";
export const UNDO_PHONE_ONLY_REASON = "This change can only be undone on the phone that made it.";

/**
 * The copy for the receipt refusals (docs/specs/coach-undo-receipt.md §4.5), by code, so the words
 * stay the same whatever the server's `message` says. Every other code, `undo_conflict`'s "changed
 * since" included, shows the server's own message, as before.
 */
export const UNDO_REFUSAL_COPY: Readonly<Record<string, string>> = {
  [UNDO_ERRORS.receiptMismatch]: "That no longer matches what the coach changed, so Undo left it alone.",
  [UNDO_ERRORS.receiptRecord]: "This was recorded by the server. Undo it from the list.",
  [UNDO_ERRORS.receiptInconsistent]: UNDO_PHONE_ONLY_REASON,
  [UNDO_ERRORS.sourceMismatch]: UNDO_PHONE_ONLY_REASON,
};

/** Record posts still in flight, by account and action id; an Undo waits for its action's. */
const recording = new Map<string, Promise<void>>();
const keyOf = (h: AccountHandle, actionId: string) => `${h.userId}:${actionId}`;

/** Phase 9 §0.3: forget the last account's records with its in-flight applies. */
export function resetUndoRecords(): void {
  recording.clear();
}

function readPending(h: AccountHandle): Pending[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(accountKey(h, PENDING_KEY)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed as Pending[] : [];
  } catch { return []; }
}

function writePending(h: AccountHandle, entries: Pending[]): void {
  if (!isCurrent(h)) return;
  try { localStorage.setItem(accountKey(h, PENDING_KEY), JSON.stringify(entries.slice(-PENDING_LIMIT))); }
  catch { /* Storage full or blocked: the record is lost, and the action stays phone-only. */ }
}

function queue(h: AccountHandle, entry: Pending): void {
  const rest = readPending(h).filter((item) => item.actionId !== entry.actionId);
  writePending(h, [...rest, entry]);
}

type Marks = Record<string, number>;

function readMarks(h: AccountHandle, name: string): Marks {
  try {
    const parsed = JSON.parse(localStorage.getItem(accountKey(h, name)) ?? "{}") as unknown;
    if (Array.isArray(parsed)) {
      // An earlier build stored a plain list; keep its ids, stamped now.
      return Object.fromEntries(parsed.filter((id): id is string => typeof id === "string")
        .map((id) => [id, Date.now()]));
    }
    return parsed !== null && typeof parsed === "object" ? parsed as Marks : {};
  } catch { return {}; }
}

function addMark(h: AccountHandle, name: string, actionId: string): void {
  if (!isCurrent(h)) return;
  // Never pruned (review t4r7 #4): a token can outlive any window, and one mark is a few bytes.
  const kept = readMarks(h, name);
  kept[actionId] = Date.now();
  try { localStorage.setItem(accountKey(h, name), JSON.stringify(kept)); }
  catch { /* Storage blocked: the caller still forgets the token itself. */ }
}

const hasMark = (h: AccountHandle, name: string, actionId: string) =>
  Object.hasOwn(readMarks(h, name), actionId);

function markStored(h: AccountHandle, actionId: string): void { addMark(h, STORED_KEY, actionId); }

/** Whether this phone already knows the action is undone. */
export function isUndoneHere(h: AccountHandle, actionId: string): boolean {
  return hasMark(h, DONE_KEY, actionId);
}

/** Remember, durably, that the action is undone; written before any server mark is attempted. */
export function noteUndoneHere(h: AccountHandle, actionId: string): void {
  addMark(h, DONE_KEY, actionId);
}

function pendingFor(h: AccountHandle, actionId: string): Pending | undefined {
  return readPending(h).find((item) => item.actionId === actionId);
}

type PostOutcome = "stored" | "refused" | "unsent" | "unanswered";

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * POST /api/coach/undo. `refused`: a definite 4xx (no such action, wrong kind). `unsent`: it never
 * left or never reached the handler (the phone was offline, so nothing was sent; 401; 429).
 * `unanswered`: anything else without an answer — a rejected fetch or a 5xx — may have been
 * stored (review t4r6 #1).
 */
/**
 * One whole request — the fetch and every body read — under the `undo` deadline (review t4r8 #4):
 * a stalled body counts as no answer, like a stalled fetch.
 */
async function wholeRequest<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded("undo", DEADLINES.undo)), DEADLINES.undo);
  });
  const running = work();
  void running.catch(() => undefined);
  try { return await Promise.race([running, over]); }
  finally { clearTimeout(timer); }
}

async function postRecord(h: AccountHandle, entry: Pending, opts: Opts): Promise<PostOutcome> {
  // Offline: the request is not sent at all, so it certainly was not stored.
  if (isOffline()) return "unsent";
  let status: number;
  try {
    status = await wholeRequest(async () => {
      const res = await accountFetch(h, "/api/coach/undo", {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: entry.actionId, kind: entry.kind, token: entry.token,
          ...(entry.threadId ? { threadId: entry.threadId } : {}),
          ...(entry.source ? { source: entry.source } : {}),
          ...(entry.undone ? { undone: true } : {}) }),
      }, { fetchImpl: opts.fetchImpl, budget: "undo" });
      return res.status;
    });
  } catch (error) {
    if (error instanceof AccountChanged) throw error;
    // The request may have left: the server may hold the record.
    return "unanswered";
  }
  if (status >= 200 && status < 300) {
    markStored(h, entry.actionId);
    return "stored";
  }
  if (status === 429 || status === 401) return "unsent";
  return status >= 500 ? "unanswered" : "refused";
}

function requeue(h: AccountHandle, entry: Pending, outcome: PostOutcome): void {
  const maybeStored = entry.maybeStored === true || outcome === "unanswered";
  const current = pendingFor(h, entry.actionId);
  // Never overwrite a newer entry of the same action (an undone mark queued meanwhile).
  if (current && current.undone !== entry.undone) {
    if (maybeStored && !current.maybeStored) queue(h, { ...current, maybeStored });
    return;
  }
  queue(h, { ...(current ?? entry), maybeStored });
}

/** Settle one queued entry after its post: drop it once answered, keep it (flagged) otherwise. */
function settlePending(h: AccountHandle, entry: Pending, outcome: PostOutcome): void {
  if (outcome === "unsent" || outcome === "unanswered") {
    if (outcome === "unanswered" && !entry.maybeStored) requeue(h, entry, outcome);
    return;
  }
  writePending(h, readPending(h).filter((item) =>
    !(item.actionId === entry.actionId && item.undone === entry.undone)));
}

/**
 * Send only this action's queued record or mark (review t4r9 #4): an Undo never waits behind the
 * rest of the queue, so its wait is one request at most. Not chained with the whole-queue flush; a
 * post both send is the same idempotent record.
 */
async function flushOne(h: AccountHandle, actionId: string, opts: Opts): Promise<void> {
  const entry = pendingFor(h, actionId);
  if (!entry) return;
  settlePending(h, entry, await postRecord(h, entry, opts));
}

let flushing: Promise<void> = Promise.resolve();

/**
 * Send every queued record and mark; keep the ones the server did not answer. One flush at a time
 * per phone, so two Undos never read and rewrite the queue over each other (review t4r2 #6).
 */
export function flushPendingUndos(h: AccountHandle, opts: Opts = {}): Promise<void> {
  const run = flushing.then(() => flushOnce(h, opts));
  flushing = run.catch(() => undefined);
  return run;
}

async function flushOnce(h: AccountHandle, opts: Opts): Promise<void> {
  for (const entry of readPending(h)) settlePending(h, entry, await postRecord(h, entry, opts));
}

/**
 * Store one applied action's token on the server. Runs in the background of the apply; an Undo of
 * the same action waits for it. A post that cannot be sent is queued.
 */
export function startRecording(
  h: AccountHandle, action: { actionId: string; kind: string }, token: object,
  opts: Opts & { threadId?: string | null; source?: Source } = {},
): Promise<void> {
  const entry: Pending = { actionId: action.actionId, kind: action.kind, token, undone: false,
    ...(opts.threadId ? { threadId: opts.threadId } : {}), ...(opts.source ? { source: opts.source } : {}) };
  const key = keyOf(h, action.actionId);
  const work = postRecord(h, entry, opts)
    .then((outcome) => {
      if (outcome === "unsent" || outcome === "unanswered") requeue(h, entry, outcome);
    })
    .catch(() => undefined)
    .finally(() => { if (recording.get(key) === work) recording.delete(key); });
  recording.set(key, work);
  return work;
}

export type CoachUndoFilter = {
  threadId?: string; messageId?: string; actionId?: string;
  /** A previous page's `next`: the page of older records. */
  before?: string;
};

/**
 * One page of the account's undo records, newest first (expired ones flagged, tombstones kept) —
 * for a thread, a message or one action — and the cursor for the next (older) page, null when
 * there is none (review t25 #3, paging only). `listCoachUndos` follows every page for callers that
 * want the whole list; use this directly to read one page at a time.
 */
export async function listCoachUndosPage(
  h: AccountHandle, filter: CoachUndoFilter, opts: Opts = {},
): Promise<CoachUndoPage> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filter)) if (value) params.set(name, value);
  return wholeRequest(async () => {
    const res = await accountFetch(h, `/api/coach/undo?${params.toString()}`,
      { method: "GET", cache: "no-store" }, { fetchImpl: opts.fetchImpl, budget: "undo" });
    if (!res.ok) throw new Error("Could not read the undo records.");
    const body = await accountJson<Partial<CoachUndoPage>>(h, res);
    // A page without both fields cannot say whether the list ended: fail, never guess complete.
    if (!Array.isArray(body.undos) || (typeof body.next !== "string" && body.next !== null)) {
      throw new Error("Could not read the undo records.");
    }
    return { undos: body.undos, next: body.next };
  });
}

/**
 * Every undo record of the account that matches, newest first (expired ones flagged, tombstones
 * kept) — for a thread, a message or one action, following every page to the end.
 *
 * For the UI lane (review t4r3 #3): when a thread opens, call this with `{ threadId }`. In
 * components/coach/Transcript.tsx, show Undo on an applied action card that has no local token
 * when its record is `serverUndoable && !undoneAt`, and show it as undone when `undoneAt` is set.
 * In components/coach/CoachShell.tsx, `undo` must not return early on a missing `entry.token`:
 * call `undoCoachAction(actionId, entry.token ?? null, …)`; it performs the server Undo.
 * In components/CoachComposedCard.tsx (review t4r5 #2), a button's action carries its card: the
 * shell passes `source: { messageId, cardIndex }` (the saved assistant message id and the card's
 * index in its `composed` list) in the `applyCoachAction` context, so the record can be stored.
 *
 * Fix (review t25 round 2 finding): this used to read one page and silently return it as the
 * whole list when `next` was non-null. It now follows `next` until the server says there is none.
 * Every page counts against the route's one 60-a-minute limit (500 records a page, so 30,000
 * records); `LIST_PAGES_MAX` matches it, and a list past it, or a refused page, throws rather
 * than returning a partial list as if it were complete.
 */
export async function listCoachUndos(
  h: AccountHandle, filter: { threadId?: string; messageId?: string; actionId?: string },
  opts: Opts = {},
): Promise<CoachUndoView[]> {
  const all: CoachUndoView[] = [];
  let before: string | undefined;
  for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
    const result = await listCoachUndosPage(h, { ...filter, before }, opts);
    all.push(...result.undos);
    if (!result.next) return all;
    before = result.next;
  }
  throw new Error("Too many undo records to list in full; narrow the filter and try again.");
}

/** The list route's 60-a-minute limit: past it the list fails out loud, never partly. */
const LIST_PAGES_MAX = 60;

/** The record as the server holds it now; `undefined` when the server could not be read. */
async function readRecord(h: AccountHandle, actionId: string, opts: Opts):
  Promise<CoachUndoView | null | undefined> {
  try { return (await listCoachUndos(h, { actionId }, opts))[0] ?? null; }
  catch (error) {
    if (error instanceof AccountChanged) throw error;
    return undefined;
  }
}

type PerformAnswer =
  | { status: "undone" }
  | { status: "refused"; code: string; reason: string }
  | { status: "unknown" };

async function postUndo(h: AccountHandle, id: string, opts: Opts): Promise<PerformAnswer> {
  try {
    return await wholeRequest(async (): Promise<PerformAnswer> => {
      const res = await accountFetch(h, `/api/coach/undo/${encodeURIComponent(id)}`, {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
        body: "{}",
      }, { fetchImpl: opts.fetchImpl, budget: "undo" });
      if (res.ok) return { status: "undone" };
      const body = await accountJson<{ error?: string; message?: string } | null>(h, res)
        .catch((error: unknown) => { if (error instanceof AccountChanged) throw error; return null; });
      if (res.status >= 500 || !body?.error) return { status: "unknown" };
      return { status: "refused", code: body.error,
        reason: UNDO_REFUSAL_COPY[body.error] ?? body.message ?? "Undo did not save." };
    });
  } catch (error) {
    if (error instanceof AccountChanged) throw error;
    return { status: "unknown" };
  }
}

async function refreshFromServer(h: AccountHandle): Promise<void> {
  try {
    const { syncOnce } = await import("@/lib/sync/client");
    await syncOnce(h);
  } catch { /* The next sync pass projects the Undo; the server write already stands. */ }
}

async function flushOutbox(h: AccountHandle): Promise<void> {
  try {
    const { flushOutboxNow } = await import("@/lib/sync/client");
    await flushOutboxNow(h);
  } catch { /* Offline: the server compares against what it has, and answers not-synced. */ }
}

/** Codes after which the server certainly wrote nothing and never will for this record. */
const LOCAL_OK = new Set<string>([
  UNDO_ERRORS.notSynced, UNDO_ERRORS.localOnly, UNDO_ERRORS.notFound, UNDO_ERRORS.expired,
]);

/**
 * `already` (t23 #8): set on the "server" plan when the record was found undone before this tap
 * tried anything, or when the server answered "already undone" to this tap's own attempt — either
 * way, this tap did not freshly undo it. `"none"` (this phone already marked the action done,
 * before any network call) is always that case too; its caller does not need the flag repeated.
 */
export type UndoPlan = { via: "server"; record: CoachUndoView; already?: true }
  | { via: "local" } | { via: "none" };

/**
 * Decide, and when it is the server, perform. `"server"`: undone on the server (now or before, on
 * any device) and the projection is refreshing. `"local"`: the caller undoes through its token and
 * then calls `markUndoneLocally`. Throws when the server refused for a reason the token cannot fix
 * (a later change exists), when the outcome is unknown, or when there is no token to fall back to.
 */
/**
 * The whole server decision has one budget (review t4r9 #4), under the dispatcher's 20 s action
 * timeout, so an Undo never holds its lock longer than that. Past it the outcome is unknown: the
 * token is kept, and the next tap asks the server again.
 */
export const UNDO_TOTAL_MS = 15_000;

export async function undoViaServer(
  h: AccountHandle, actionId: string, hasLocalToken: boolean, opts: Opts & { totalMs?: number } = {},
): Promise<UndoPlan> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(UNDO_UNCONFIRMED_REASON)), opts.totalMs ?? UNDO_TOTAL_MS);
  });
  const deciding = decide(h, actionId, hasLocalToken, opts);
  void deciding.catch(() => undefined);
  try { return await Promise.race([deciding, over]); }
  finally { clearTimeout(timer); }
}

async function decide(
  h: AccountHandle, actionId: string, hasLocalToken: boolean, opts: Opts,
): Promise<UndoPlan> {
  // Undone before, here: nothing to do, ever again.
  if (isUndoneHere(h, actionId)) return { via: "none" };
  await recording.get(keyOf(h, actionId));
  await flushOne(h, actionId, opts);
  const local = (reason: string): UndoPlan => {
    if (!hasLocalToken) throw new Error(reason);
    return { via: "local" };
  };
  const done = async (view: CoachUndoView, already?: true): Promise<UndoPlan> => {
    noteUndoneHere(h, actionId);
    // The projection catches up in the background; the Undo itself already stands.
    void refreshFromServer(h);
    return { via: "server", record: view, ...(already ? { already } : {}) };
  };

  // Always read fresh (review t4r3 #1, t4r5 #1): a queued record may be stored anyway (a lost
  // answer), and an open record may have been closed since by another tab or device; only the
  // server's current state, or an unreadable server for a post that certainly never arrived, may
  // let the token run.
  const pending = pendingFor(h, actionId);
  const record = await readRecord(h, actionId, opts);
  if (record === undefined) {
    // Unreadable. A record that may be stored may have been undone on another device, so the
    // token waits; one this phone never stored cannot have been, so the token undoes as before.
    if (pending?.maybeStored || hasMark(h, STORED_KEY, actionId)) throw new Error(UNDO_UNCONFIRMED_REASON);
    return local(UNDO_UNCONFIRMED_REASON);
  }
  // Records are never deleted (tombstones), so "none" means never stored — unless this phone saw it
  // stored, which only an account reset could explain: then the token waits.
  if (record === null) {
    if (hasMark(h, STORED_KEY, actionId)) throw new Error(UNDO_UNCONFIRMED_REASON);
    return local(UNDO_PHONE_ONLY_REASON);
  }
  // Already undone before this tap tried anything (t23 #8): nothing to perform, and the card says so.
  if (record.undoneAt) return done(record, true);
  // Water is additive: once any record of it exists, its Undo is the server's or nobody's — never
  // this phone's token (review t4r8 #1), even for a record the server cannot perform.
  if (record.kind === "log_water" && !record.serverUndoable) {
    throw new Error("This water entry can no longer be undone here. Edit the count on Today.");
  }
  if (!record.serverUndoable) return local(UNDO_PHONE_ONLY_REASON);

  // Send this phone's own queued writes first, so the server compares against the latest.
  if (hasLocalToken) await flushOutbox(h);
  const answer = await postUndo(h, record.id, opts);
  if (answer.status === "undone"
    || (answer.status === "refused" && answer.code === UNDO_ERRORS.alreadyUndone)) {
    const undone = { ...record, undoneAt: record.undoneAt ?? new Date().toISOString() };
    // "undone": this tap just did it, fresh. "refused" + alreadyUndone: another tap or device won
    // the race between our read and our write, so this tap did not — the card says "already".
    return done(undone, answer.status === "undone" ? undefined : true);
  }
  if (answer.status === "refused") {
    // Water is additive: "not synced" also reads like a count corrected back since, so once a
    // record exists its Undo is the server's only (review t4r7 #2).
    if (record.kind === "log_water") throw new Error(answer.reason);
    if (LOCAL_OK.has(answer.code)) return local(answer.reason);
    if (answer.code === UNDO_ERRORS.conflict) throw new Error(answer.reason);
  }
  // A 5xx, a 429 or a lost answer: the claim and the write are one transaction, so the record
  // says whether it happened. Not (yet) undone is still not proof — a dropped request may commit
  // later — so the token is never used here: it is kept, and the next tap asks the server again
  // (a committed Undo then answers already-undone).
  const after = await readRecord(h, actionId, opts);
  // Found undone on the re-read, but this tap's own write was never confirmed: it may have been
  // this one committing late, so "already" (not freshly undone just now) is the honest read.
  if (after?.undoneAt) return done(after, true);
  throw new Error(answer.status === "refused" ? answer.reason : UNDO_UNCONFIRMED_REASON);
}

/**
 * After the token undid it: store the record undone (or mark it), so no late record and no other
 * device can undo it again. Awaited inside the Undo's lock; queued when it cannot be sent.
 */
export async function markUndoneLocally(
  h: AccountHandle, action: { actionId: string; kind: string }, token: object, opts: Opts = {},
): Promise<void> {
  noteUndoneHere(h, action.actionId);
  // Keep what the unsent record knew (its thread, a composed card's source) so it can still be stored.
  const earlier = pendingFor(h, action.actionId);
  const entry: Pending = { ...earlier, actionId: action.actionId, kind: action.kind, token, undone: true };
  // Queued durably first; the post runs in the background so the Undo's lock is not held for it.
  // This phone's own guard (noteUndoneHere) already stops a second token, and the server's state
  // checks stop a second server Undo of a write this token already took back.
  queue(h, entry);
  void flushOne(h, action.actionId, opts).catch(() => undefined);
}
