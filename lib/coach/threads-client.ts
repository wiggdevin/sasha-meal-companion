/**
 * Managing saved chats from the Conversations list (U20, 2026-10-04; owner: "there should also be
 * options to clear any of these conversations, and we should also be able to search specific
 * conversations"). The UI's own client over the backend's thread routes (PR #354):
 *
 * - `DELETE /api/coach/threads/[id]`          → 204; 404 `{"error":"not_found"}` for a thread that
 *   is not a chat, is unknown, or was already deleted. Permanent: there is no un-delete.
 * - `DELETE /api/coach/threads/[id]/messages` → 204; clears the messages and summary, keeps the title.
 * - `PATCH  /api/coach/threads/[id]` `{title}` → 200 `{id,title,kind,lastMessageAt}` (1–80 chars).
 * - `GET    /api/coach/threads?q=` (3–100 chars) → `{results:[{threadId,title,matches:[…]}]}`.
 * - `GET    /api/coach/threads/unread`        → `{unread: number}`: threads holding an unopened weekly
 *   review (the same rule as `unread` on the list); 404 while the coach is off.
 *
 * A server without those routes answers 405 (the thread route has no DELETE or PATCH) or a 404
 * that is not the JSON `not_found` (no messages route), and the search answers the plain thread
 * array because it ignores `q`. All three read as `ThreadsUnavailable`, so the list can say so in a
 * Notice instead of failing.
 */
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { isDeadline } from "@/lib/fetch-with-deadline";
import type { ThreadSummary } from "@/lib/coach-client";

export const TITLE_MAX = 80;
export const SEARCH_MIN = 3;
export const SEARCH_MAX = 100;

export type ThreadSearchMatch = { messageId: string; snippet: string; at: string };
export type ThreadSearchHit = { threadId: string; title: string | null; matches: ThreadSearchMatch[] };
export type ThreadsOptions = { fetchImpl?: typeof fetch; account?: AccountHandle; signal?: AbortSignal };

/** The server has not got the management routes yet. */
export class ThreadsUnavailable extends Error {
  constructor() {
    super("Managing chats is not available yet.");
    this.name = "ThreadsUnavailable";
  }
}

/** Any other refusal or a network failure; `message` is safe to show. */
export class ThreadsError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ThreadsError";
  }
}

const NETWORK_COPY = "No connection. Try again.";

async function threadRequest(path: string, init: RequestInit, opts: ThreadsOptions,
  budget: "commit" | "search" | "prefs") {
  const h = opts.account ?? accountHandle();
  try {
    return { h, res: await accountFetch(h, path, { ...init, signal: opts.signal },
      { budget, fetchImpl: opts.fetchImpl }) };
  } catch (error) {
    rethrowAccountChanged(error);
    if ((error as { name?: string } | null)?.name === "AbortError") throw error;
    if (isDeadline(error)) throw new ThreadsError(0, "That took too long. Try again.");
    throw new ThreadsError(0, NETWORK_COPY);
  }
}

async function errorBody(h: AccountHandle, res: Response): Promise<{ error?: string; message?: string } | null> {
  try { return await accountJson<{ error?: string; message?: string }>(h, res); }
  catch (error) { rethrowAccountChanged(error); return null; }
}

/** 404 with the JSON `not_found` is the thread; any other 404 or a 405 is a missing route. */
async function refusal(h: AccountHandle, res: Response): Promise<"missing"> {
  const body = await errorBody(h, res);
  if (res.status === 404 && body?.error === "not_found") return "missing";
  if (res.status === 404 || res.status === 405) throw new ThreadsUnavailable();
  throw new ThreadsError(res.status, body?.message ?? "That did not save. Try again.");
}

const threadPath = (id: string) => `/api/coach/threads/${encodeURIComponent(id)}`;

/** Deletes a chat for good. `missing` means it is already gone, which a list treats the same. */
export async function deleteThread(id: string, opts: ThreadsOptions = {}): Promise<"deleted" | "missing"> {
  const { h, res } = await threadRequest(threadPath(id), { method: "DELETE" }, opts, "commit");
  if (res.status === 204 || res.ok) return "deleted";
  return refusal(h, res);
}

/** Empties a chat's messages and summary; its title stays. */
export async function clearThreadMessages(id: string, opts: ThreadsOptions = {}): Promise<"cleared" | "missing"> {
  const { h, res } = await threadRequest(`${threadPath(id)}/messages`, { method: "DELETE" }, opts, "commit");
  if (res.status === 204 || res.ok) return "cleared";
  return refusal(h, res);
}

/** A title the server accepts: trimmed, 1–80 characters. */
export function cleanTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim();
  return title.length >= 1 && title.length <= TITLE_MAX ? title : null;
}

export async function renameThread(id: string, raw: string, opts: ThreadsOptions = {}): Promise<ThreadSummary> {
  const title = cleanTitle(raw);
  if (!title) throw new ThreadsError(400, `Use 1 to ${TITLE_MAX} characters.`);
  const { h, res } = await threadRequest(threadPath(id), {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
  }, opts, "commit");
  if (res.ok) {
    const row = await accountJson<Partial<ThreadSummary>>(h, res);
    return { id: row.id ?? id, title: row.title ?? title, kind: row.kind ?? "chat",
      lastMessageAt: row.lastMessageAt ?? null };
  }
  await refusal(h, res);
  throw new ThreadsError(404, "That chat is no longer available.");
}

/**
 * How many of this account's threads hold an unopened weekly review: the badge's cheap background
 * check, so the full list is read only when there is something to find. `null` when the coach is off
 * (404): no badge and nothing to report. Any other refusal, a bad body or no connection throws.
 * A short read with nothing waiting on it, so the short `prefs` deadline.
 */
export async function countUnreadThreads(opts: ThreadsOptions = {}): Promise<number | null> {
  const { h, res } = await threadRequest("/api/coach/threads/unread", { cache: "no-store" }, opts, "prefs");
  if (res.status === 404) return null;
  if (!res.ok) throw new ThreadsError(res.status, "Could not check for new reviews.");
  const body = await accountJson<{ unread?: unknown } | null>(h, res);
  const count = body?.unread;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new ThreadsError(res.status, "Could not check for new reviews.");
  }
  return count;
}

function isHit(value: unknown): value is ThreadSearchHit {
  const hit = value as Partial<ThreadSearchHit> | null;
  return !!hit && typeof hit.threadId === "string" && Array.isArray(hit.matches);
}

/** Server search over message text. Shorter or longer queries are not sent (the route refuses them). */
export async function searchThreads(raw: string, opts: ThreadsOptions = {}): Promise<ThreadSearchHit[]> {
  const q = raw.trim();
  if (q.length < SEARCH_MIN || q.length > SEARCH_MAX) return [];
  const { h, res } = await threadRequest(`/api/coach/threads?q=${encodeURIComponent(q)}`, {}, opts, "search");
  if (!res.ok) {
    if (res.status === 404 || res.status === 405) throw new ThreadsUnavailable();
    throw new ThreadsError(res.status, "Search did not answer. Try again.");
  }
  const body = await accountJson<unknown>(h, res);
  // An older server ignores `q` and lists every thread: the search itself is not there yet.
  if (Array.isArray(body)) throw new ThreadsUnavailable();
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new ThreadsUnavailable();
  return results.filter(isHit).map((hit) => ({
    threadId: hit.threadId, title: typeof hit.title === "string" ? hit.title : null,
    matches: hit.matches.filter((match) => typeof match?.snippet === "string")
      .map((match) => ({ messageId: String(match.messageId), snippet: match.snippet, at: String(match.at) })),
  }));
}
