"use client";

/**
 * The browser side of the coach. A turn is a live model call and is never queued in the outbox
 * (spec "Offline"); only the transcript is cached, in localStorage under the account's own
 * `coach:<threadId>` key (Phase 9 §0.4: `smc:u:<userId>:coach:<threadId>`).
 *
 * draftToProposeResponse hands a CoachDraft to the Phase 4 confirm sheet, per
 * docs/plans/2026-09-11-phase-3-4/00-contracts.md §5: CaptureSheet opens with
 * initialMode "confirm" and this object as initialDraft, and skips capture.
 */

import type { DraftItem, ProposeResponse } from "@/lib/capture/types";
import { isDeadline } from "@/lib/fetch-with-deadline";
import { mark, markMs, measure, newRunId } from "@/lib/timing";
import type { CoachAction } from "@/lib/coach/actions";
import type { CoachAttachment } from "@/lib/coach/attachments";
import type { UndoToken } from "@/lib/coach/apply-client";
import type { CoachMessageView } from "@/lib/coach/message-view";
import type { CoachUndoCard } from "@/lib/coach/undo-types";
import type { CoachDraft, CoachTurnRequest, CoachTurnResponse } from "@/lib/coach/types";
import {
  accountFetch, accountHandle, accountJson, accountKey, assertCurrent, isCurrent,
  rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { ASSISTANT_NAME } from "@/lib/brand";

/** The account-scoped cache name prefix (under `smc:u:<userId>:`). */
export const CACHE_PREFIX = "coach:";
export const CACHE_LIMIT = 50;

export type CachedMessage = Omit<CoachMessageView, "createdAt"> & { createdAt?: string };
export type CachedAction = {
  action: CoachAction; status: "pending" | "applied" | "failed" | "undoing" | "undone";
  reason?: string; token?: UndoToken; messageId: string | null; fastPath?: boolean;
  /**
   * A composed card's button: the saved message holding the card and the card's index in that
   * message's `composed` list. Pass it as `applyCoachAction`'s `source` so the server can record
   * the tapped action (its id is minted at the tap, so no saved message carries it).
   */
  source?: { messageId: string; cardIndex: number };
  /**
   * Another device applied it and the server can undo it (components/coach/server-undo.ts): Undo
   * shows without a token. Set on the transcript's view only, never cached.
   */
  serverUndoable?: boolean;
  /**
   * A server-held entry (components/coach/server-undo.ts): drawn from the server record's own card,
   * never from a saved message action (docs/specs/coach-undo-receipt.md §6.5). Its `action` carries
   * the record's id and kind only. View only, never cached.
   */
  server?: { card: CoachUndoCard; createdAt: string };
  /** `ApplyResult.nutritionUnchecked` (t23 #7): the save landed, but its numbers could not be checked. */
  nutritionUnchecked?: true;
  /**
   * `ApplyResult.notices`: what the save left out and why (a recipe's refused ingredients). Kept
   * with the entry, so the card still says it after a reload.
   */
  notices?: string[];
  /** This Undo found the action already undone, not freshly undone just now (t23 #8). */
  already?: true;
};
export type CachedThread = { messages: CachedMessage[]; actions: CachedAction[] };
/** `unread` (thread list only): a delivered weekly review not yet opened; opening clears it. */
export type ThreadSummary = { id: string; title: string | null; kind: string; lastMessageAt: string | null;
  unread?: boolean };
export type HistoryEvidence = { id: string; threadId: string; seq: number;
  role: "user" | "assistant"; excerpt: string; createdAt: string; title: string };

/**
 * A Node test run (vitest's environment is `node`) has no `localStorage` global, and the spec's
 * transcript test drives the cache directly. Resolve the real store in the browser; where the
 * platform has none, install one in-memory store on `globalThis` so the cache never throws and a
 * caller holding `localStorage` sees the same bytes. The throw on the property itself is private
 * browsing (see lib/capture/drafts.ts) and counts as absent.
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  } as Storage;
}

const fallbackStorage = memoryStorage();
try {
  if (typeof localStorage === "undefined") {
    (globalThis as { localStorage?: Storage }).localStorage = fallbackStorage;
  }
} catch { /* a frozen or blocked global still falls back inside cacheStorage */ }

function cacheStorage(): Storage {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch { /* a blocked storage property counts as absent */ }
  try { (globalThis as { localStorage?: Storage }).localStorage = fallbackStorage; }
  catch { /* frozen global */ }
  return fallbackStorage;
}

/** What a turn shows when the request never reached the server. */
export const NO_CONNECTION_COPY = `No connection to ${ASSISTANT_NAME}.`;

export class CoachError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "CoachError";
  }
}

export function cacheKey(h: AccountHandle, threadId: string): string {
  return accountKey(h, `${CACHE_PREFIX}${threadId}`);
}

/** The account's cached transcript. With no account (or a stale one) there is nothing to read. */
export function readCache(h: AccountHandle | null, threadId: string): CachedThread {
  if (h === null || !isCurrent(h)) return { messages: [], actions: [] };
  try {
    const raw = cacheStorage().getItem(cacheKey(h, threadId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) return { messages: parsed as CachedMessage[], actions: [] };
    if (parsed !== null && typeof parsed === "object") {
      const cached = parsed as Partial<CachedThread>;
      return {
        messages: Array.isArray(cached.messages) ? cached.messages : [],
        actions: Array.isArray(cached.actions) ? cached.actions : [],
      };
    }
    return { messages: [], actions: [] };
  } catch {
    // Private mode, cleared storage or a corrupt value: an empty transcript, never a crash.
    return { messages: [], actions: [] };
  }
}

/** Writes only for the account that started the work: a stale handle throws `AccountChanged`. */
export function writeCache(h: AccountHandle | null, threadId: string, cached: CachedThread): void {
  if (h === null) return;
  assertCurrent(h);
  try {
    const messages = cached.messages.slice(-CACHE_LIMIT);
    const messageIds = new Set(messages.map((message) => message.id));
    const actions = cached.actions.filter((entry) =>
      entry.messageId === null || messageIds.has(entry.messageId));
    cacheStorage().setItem(cacheKey(h, threadId), JSON.stringify({ messages, actions }));
  } catch {
    // Quota or private mode. The transcript reloads from the server next time.
  }
}

/** `account`: the account the turn started as (Phase 9 §0.5a). Default: the bound one. */
export type CoachFetchOptions = { fetchImpl?: typeof fetch; account?: AccountHandle };
export type CoachClientTurnResponse = Omit<CoachTurnResponse, "messages"> & {
  messages: CoachMessageView[];
};
export type CoachAttachmentTurnRequest = CoachTurnRequest & {
  text: "";
  attachment: CoachAttachment;
};

/**
 * Every coach call carries the same 40 s budget (spec §2). A turn that overruns it is reported
 * as a 503, the status CoachChat already reads as retryable — the same text sent again is still
 * correct, so the user gets the Retry button rather than a spinner with no end.
 */
async function call<T>(url: string, init: RequestInit = {}, opts: CoachFetchOptions = {}): Promise<T> {
  const h = opts.account ?? accountHandle();
  let res: Response;
  try {
    res = await accountFetch(h, url, init, { budget: "coach", fetchImpl: opts.fetchImpl });
  } catch (e) {
    rethrowAccountChanged(e);
    if (isDeadline(e)) {
      throw new CoachError(503, "timeout", `${ASSISTANT_NAME} did not answer in time. Try again.`);
    }
    throw e;
  }
  // The budget covers the body too, so the read itself can run out of it — the same 503 the
  // header timeout gives, so the user gets Retry rather than a spinner (Grok pass 26, HIGH 2).
  if (res.ok) {
    try {
      return await accountJson<T>(h, res);
    } catch (e) {
      rethrowAccountChanged(e);
      if (isDeadline(e)) {
        throw new CoachError(503, "timeout", `${ASSISTANT_NAME} did not answer in time. Try again.`);
      }
      throw e;
    }
  }
  let body: { error?: string; message?: string; retryAfterSeconds?: number } = {};
  try {
    body = await accountJson<typeof body>(h, res);
  } catch (e) {
    rethrowAccountChanged(e);
    if (isDeadline(e)) {
      throw new CoachError(503, "timeout", `${ASSISTANT_NAME} did not answer in time. Try again.`);
    }
    /* an empty error body */
  }
  throw new CoachError(res.status, body.error ?? "http_error",
    body.message ?? `Request failed (${res.status}).`, body.retryAfterSeconds ?? null);
}

/**
 * One turn, and one `client_timings` run (T0 §1).
 *
 * `sent` is the start stamp; `first-text` and `reply-done` are DURATIONS from that moment, not
 * instants — stamping them as start marks in the same tick made both measure ~0 ms and left the
 * whole wait sitting on `sent`, which is not what AC9 judges (Grok 4.6 HIGH 5). The response is
 * non-streaming, so the two are the same number today.
 *
 * A turn that never answered measures nothing: a failed wait is not a latency sample.
 */
async function postMeasuredTurn(
  req: CoachTurnRequest | CoachAttachmentTurnRequest,
  start: "sent" | "attach",
  opts: CoachFetchOptions,
): Promise<CoachClientTurnResponse> {
  mark("coach-turn", start);
  const startedAt = nowMs();
  const response = await call<CoachClientTurnResponse>("/api/coach", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(withHerClock(req)),
  }, opts);
  const elapsed = nowMs() - startedAt;
  markMs("coach-turn", "first-text", elapsed);
  markMs("coach-turn", "reply-done", elapsed);
  if (response.timings) {
    markMs("coach-turn", "model", response.timings.model);
    markMs("coach-turn", "ground", response.timings.ground);
  }
  measure("coach-turn", newRunId());
  return response;
}

export function postTurn(
  req: CoachTurnRequest, opts: CoachFetchOptions = {},
): Promise<CoachClientTurnResponse> {
  return postMeasuredTurn(req, "sent", opts);
}

/** Attachment turns use the same coach endpoint but carry an empty text field by contract. */
export function postAttachmentTurn(
  req: CoachAttachmentTurnRequest, opts: CoachFetchOptions = {},
): Promise<CoachClientTurnResponse> {
  return postMeasuredTurn(req, "attach", opts);
}

/**
 * Their clock rides on every turn (T6 §2). It is stamped HERE, not only at the call site: the server
 * falls back to DEFAULT_TZ when the body has neither, and a caller that forgets silently moves
 * every date and every `at` the coach emits into the server's timezone.
 */
export function withHerClock<T extends CoachTurnRequest>(
  req: T, at: Date = new Date(),
): T & Required<Pick<CoachTurnRequest, "now" | "tz">> {
  return {
    ...req,
    now: req.now ?? at.toISOString(),
    tz: req.tz ?? deviceTz(),
  } as T & Required<Pick<CoachTurnRequest, "now" | "tz">>;
}

/**
 * The entries this phone holds for their local date, so `delete_entry` and `move_entry` can name one
 * the user logged seconds ago — before the outbox has landed it and before the server can see it
 * (Grok pass 1, HIGH 6).
 */
export function recentEntriesFor(
  date: string, tz: string, load: () => { days: Record<string, { extras?: { id: string;
    name: string; at: string }[] }> },
): CoachTurnRequest["recentEntries"] {
  try {
    const extras = load().days[date]?.extras ?? [];
    const clock = (at: string) => {
      try {
        return new Intl.DateTimeFormat("en-GB",
          { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
          .format(new Date(at));
      } catch { return at.slice(11, 16); }
    };
    return extras.slice(-20).map((extra) => ({
      entryId: extra.id, what: `${extra.name} at ${clock(extra.at)}`.slice(0, 120),
    }));
  } catch { return undefined; }
}

function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch { return "UTC"; }
}

function nowMs(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

export async function listThreads(opts: CoachFetchOptions = {}): Promise<ThreadSummary[]> {
  return call<ThreadSummary[]>("/api/coach/threads", {}, opts);
}

/** A citation resolves only while its source chat still belongs to this account. */
export async function readHistoryEvidence(
  sources: readonly { threadId: string; id: string; matchTerms?: string[] }[],
  opts: CoachFetchOptions = {},
): Promise<HistoryEvidence[]> {
  const response = await call<{ sources: HistoryEvidence[] }>("/api/coach/history-sources", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sources: sources.slice(0, 4).map((source) => ({
      threadId: source.threadId, messageId: source.id, matchTerms: source.matchTerms ?? [],
    })) }),
  }, opts);
  return response.sources;
}

/**
 * One page of a thread. `cleared` (opening the latest page): true when the weekly-review unread
 * mark was cleared or there was nothing to clear; false when the clear write failed and the mark
 * is still set, so the badge must stay.
 */
export type ThreadPage = { thread: ThreadSummary; messages: CachedMessage[]; cleared: boolean };

export async function getThread(
  id: string, { limit }: { limit?: number } = {}, opts: CoachFetchOptions = {},
): Promise<ThreadPage> {
  const query = limit === undefined ? "" : `?limit=${limit}`;
  return call(`/api/coach/threads/${id}${query}`, {}, opts);
}

/** Fetch one older page without changing the latest-page contract used by getThread. */
export async function fetchOlder(
  id: string, before: number, limit: number, opts: CoachFetchOptions = {},
): Promise<ThreadPage> {
  const query = new URLSearchParams({ before: String(before), limit: String(limit) });
  return call(`/api/coach/threads/${id}?${query}`, {}, opts);
}

/**
 * Every drafted item is already grounded and already policy-checked server-side (checkDraft, in
 * lib/server/coach.ts) — row.verdict carries that real result through. Its absence (an older
 * cached draft, or a draft built without going through the policy pass) falls back to "allowed"
 * rather than "unverified", matching this function's prior, always-allowed behavior.
 */
export function draftToProposeResponse(draft: CoachDraft, method: "text" = "text"): ProposeResponse {
  const items: DraftItem[] = draft.items.map((row, seq) => ({
    seq, label: row.name, foodRefId: row.foodRefId,
    catalogFoodRevisionId: row.catalogFoodRevisionId, grams: row.grams, qty: 1, unit: "g",
    portionId: null, confidence: 1, policy: { verdict: row.verdict ?? "allowed" },
    alternatives: [], autoResolved: true,
  }));
  return { draftId: draft.draftId, method, items, notes: [], spend: { usedToday: 0, softCap: 0 } };
}
