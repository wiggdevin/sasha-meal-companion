import { randomUUID } from "node:crypto";
/**
 * Coach thread and message storage — the half of the orchestrator that talks to
 * `coach_threads` / `coach_messages`. Split out of lib/server/coach.ts (T6 §6) so the turn loop
 * in lib/server/coach-turn.ts reads as the loop and nothing else.
 *
 * No "server-only" marker, for the same reason lib/server/coach.ts has none: tests load this
 * module under vitest, and lib/server/ is the boundary.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import { groundedCoachActionSchema, type CoachAction } from "@/lib/coach/actions";
import { MEMORY_MESSAGES, renderPendingDraft, type HistoryMessage } from "@/lib/coach/history";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { Intent } from "@/lib/coach/intent";
import type { CoachSuggestion, CoachTurnResponse } from "@/lib/coach/types";
import { messageProvenance, toMessageView } from "@/lib/coach/message-view";
import { logDraftBlockV1Schema, type LogDraftBlockV1 } from "@/lib/coach/ui-blocks";
import { BY_APP } from "@/lib/provenance";

export type MessageRow = {
  id: string; thread_id: string; user_id: string; role: "user" | "assistant";
  content: string; seq: number; tool_calls: unknown; policy_checks: unknown;
  deflected: boolean; model_id: string | null; ai_call_id: string | null;
};

export function view(row: MessageRow) {
  const provenance = messageProvenance(row);
  return { id: row.id, role: row.role, content: row.content, seq: row.seq,
    ...(provenance ? { provenance } : {}) };
}

export function replayActions(toolCalls: unknown): CoachAction[] {
  if (toolCalls === null || Array.isArray(toolCalls) || typeof toolCalls !== "object") return [];
  const actions = (toolCalls as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action) => {
    const parsed = groundedCoachActionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The cards persisted beside the actions, read back for an idempotent replay. */
function replayCards(toolCalls: unknown): {
  suggestions: CoachSuggestion[]; composed: ComposedMeal[];
  fastPath?: true; intent?: Intent;
} {
  if (toolCalls === null || Array.isArray(toolCalls) || typeof toolCalls !== "object") {
    return { suggestions: [], composed: [] };
  }
  const row = toolCalls as {
    suggestions?: unknown; composed?: unknown; fastPath?: unknown; intent?: unknown;
  };
  const composed = Array.isArray(row.composed)
    ? row.composed as ComposedMeal[]
    : row.composed && typeof row.composed === "object" ? [row.composed as ComposedMeal] : [];
  return {
    suggestions: Array.isArray(row.suggestions) ? row.suggestions as CoachSuggestion[] : [],
    composed,
    ...(row.fastPath === true ? { fastPath: true as const } : {}),
    ...(typeof row.intent === "string" ? { intent: row.intent as Intent } : {}),
  };
}

/**
 * The thread kinds an account manages and continues as conversations: its saved chats and its
 * weekly-review thread. A reply in the review thread is an ordinary turn with the reviews as its
 * history; rename, clear and delete work as on a chat. Plan threads stay server-owned working
 * state and 404 like an unknown id. The review thread is not a chat for the eight-chat cap (the
 * server creates it, one per account, coach_threads_one_weekly).
 */
export const CONVERSATION_KINDS = ["chat", "weekly_review"] as const;

/** Whether a stored thread of `actual` kind can take a turn sent with `requested` scope. */
export function threadAcceptsTurn(requested: "chat" | "plan", actual: string): boolean {
  return requested === "plan" ? actual === "plan"
    : (CONVERSATION_KINDS as readonly string[]).includes(actual);
}

/** How long a turn with a user row and no reply may still be saving: the route's maxDuration. */
export const INCOMPLETE_TURN_WINDOW_MS = 60_000;
export const INCOMPLETE_TURN_REPLY = "I could not finish that one. Ask me again.";

/** Fast user-facing refusal; the insert trigger remains the concurrency authority. */
export async function assertChatCapacity(client: SupabaseClient, userId: string): Promise<void> {
  const { count, error } = await client.from("coach_threads")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("kind", "chat").is("deleted_at", null);
  if (error) throw new HttpError(503, "history_unavailable", "Could not check saved chats. Try again.");
  if (count !== null && count >= 8) {
    throw new HttpError(409, "chat_limit", "You have eight chats. Continue an existing chat.");
  }
}

/**
 * The saved turn for `messageId`, read with the session client. `admin` writes only the "could not
 * finish" reply of an abandoned turn, a `role = 'assistant'` row the user may not insert (W018),
 * into the thread the session read just proved belongs to the caller.
 */
export async function storedTurn(
  client: SupabaseClient, admin: SupabaseClient, userId: string, messageId: string,
  model: CoachTurnResponse["model"],
  scope?: { threadId: string | null; kind: "chat" | "plan" },
): Promise<CoachTurnResponse | null> {
  const { data } = await client.from("coach_messages")
    .select("id, thread_id, role, content, seq, created_at").eq("user_id", userId).eq("id", messageId)
    .maybeSingle();
  const row = data as { id: string; thread_id: string; role: "user"; content: string;
    seq: number; created_at?: string | null } | null;
  if (!row) return null;
  if (row.role !== "user") throw new HttpError(404, "not_found", "No such turn.");
  if (scope) {
    if (scope.threadId !== null && scope.threadId !== row.thread_id) {
      throw new HttpError(404, "not_found", "No such thread.");
    }
    const { data: thread, error: threadError } = await client.from("coach_threads")
      .select("id, kind").eq("id", row.thread_id).eq("user_id", userId)
      .is("deleted_at", null).maybeSingle();
    if (threadError) throw new HttpError(503, "history_unavailable", "Could not read the saved turn.");
    if (!thread || !threadAcceptsTurn(scope.kind, (thread as { kind: string }).kind)) {
      throw new HttpError(404, "not_found", "No such thread.");
    }
  }
  const { data: rest } = await client.from("coach_messages")
    .select("id, role, content, seq, tool_calls, model_id, ai_call_id, deflected")
    .eq("thread_id", row.thread_id)
    .gte("seq", row.seq).order("seq", { ascending: true });
  // THIS turn only — its user row and the reply saved at the next seq. A later turn's reply is
  // not this one's (Sol review, 2026-09-23: `find` over everything after the row could pick it).
  const messages = ((rest ?? []) as { id: string; role: "user" | "assistant";
    content: string; seq: number; tool_calls: unknown; model_id?: string | null;
    ai_call_id?: string | null; deflected?: boolean | null }[])
    .filter((message) => message.seq === row.seq || message.seq === row.seq + 1);
  let assistant = messages.find((message) =>
    message.role === "assistant" && message.seq === row.seq + 1);
  if (!assistant) {
    // The user row landed and the reply has not: a save the route gave up on may still be
    // finishing, so a recent one is "try again", never a finished turn.
    const age = row.created_at ? Date.now() - Date.parse(row.created_at) : Infinity;
    if (age < INCOMPLETE_TURN_WINDOW_MS) {
      throw new HttpError(503, "in_progress", "Still working on that one. Try again in a moment.");
    }
    // Long since abandoned: the reply is SAVED as "could not finish" when its seq is free, so every
    // later read of the thread agrees with this one. When a later message already holds that seq,
    // or takes it meanwhile, the same reply is answered UNSAVED and final — a 503 there would be
    // retried forever against a seq that will never free (Sol r3, 2026-09-23).
    const unsaved = { id: `${row.id}-incomplete`, role: "assistant" as const,
      content: INCOMPLETE_TURN_REPLY, seq: row.seq + 1, tool_calls: { provenance: BY_APP } };
    const seqTaken = messages.some((message) => message.seq === row.seq + 1);
    if (seqTaken) {
      assistant = unsaved;
    } else {
      const saved = { ...unsaved, id: randomUUID() };
      const { error } = await admin.from("coach_messages").insert({
        ...saved, thread_id: row.thread_id, user_id: userId, policy_checks: [],
        deflected: false, model_id: null, ai_call_id: null,
      });
      if (error && (error as { code?: string }).code !== "23505") {
        throw new HttpError(503, "in_progress", "Still working on that one. Try again in a moment.");
      }
      assistant = error ? unsaved : saved;
    }
    // This turn is its question and that reply — never the later message holding the seq.
    messages.splice(0, messages.length, ...messages.filter((message) => message.seq === row.seq),
      assistant);
  }
  const replayed = replayCards(assistant?.tool_calls);
  const provenance = assistant ? messageProvenance(assistant) : undefined;
  return {
    threadId: row.thread_id, actions: replayActions(assistant?.tool_calls),
    // A replay is the SAME turn, so it carries the same cards: a phone that retried its POST used
    // to get the actions back but lose the suggestion cards and the composed meal (Grok pass 1,
    // HIGH 7).
    suggestions: replayed.suggestions, composed: replayed.composed,
    ...(replayed.fastPath ? { fastPath: replayed.fastPath } : {}),
    ...(replayed.intent ? { intent: replayed.intent } : {}),
    messages: messages.map(toMessageView),
    draft: null, deflected: false, toolsUsed: [], model,
    ...(provenance ? { provenance } : {}),
  };
}

/**
 * Reserve a new thread id without inserting it. Provider or retention-gate failures must not
 * leave empty conversations in history. The thread is created only when its reply is ready
 * to persist; existing transcripts are never deleted as failure cleanup.
 *
 * An existing id is read back through the RLS-scoped client before it is trusted: a foreign or
 * made-up id 404s here, before the model call burns a turn from their budget (cross-user 404).
 */
export async function resolveThread(
  client: SupabaseClient, userId: string, threadId: string | null,
  newId: () => string, kind: "chat" | "plan" = "chat",
): Promise<string> {
  if (threadId) {
    const { data } = await client.from("coach_threads")
      .select("id, kind").eq("id", threadId).eq("user_id", userId)
      .is("deleted_at", null).maybeSingle();
    if (!data || !threadAcceptsTurn(kind, (data as { kind: string }).kind)) {
      throw new HttpError(404, "not_found", "No such thread.");
    }
    return threadId;
  }
  return newId();
}

/** The first still-`pending` log_draft in a message's `tool_calls.blocks`, or none. */
function pendingDraftBlockFrom(toolCalls: unknown): LogDraftBlockV1 | null {
  if (toolCalls === null || Array.isArray(toolCalls) || typeof toolCalls !== "object") return null;
  const blocks = (toolCalls as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return null;
  for (const raw of blocks) {
    const parsed = logDraftBlockV1Schema.safeParse(raw);
    if (parsed.success && parsed.data.status === "pending") return parsed.data;
  }
  return null;
}

/**
 * The draft's own item identities — a barcode match's single foodRefId/description, or a propose
 * draft's per-item foodRefId (often null pre-resolution) and label. Used only to guess whether a
 * LATER log_meal actually logged this draft; see findPendingDraft below.
 */
function draftItemIdentities(block: LogDraftBlockV1): { refs: Set<string>; names: Set<string> } {
  const draft = block.draft;
  if ("match" in draft) {
    return { refs: new Set([draft.match.foodRefId]), names: new Set([draft.match.description.toLowerCase()]) };
  }
  return {
    refs: new Set(draft.items.map((item) => item.foodRefId).filter((id): id is string => id !== null)),
    names: new Set(draft.items.map((item) => item.label.toLowerCase())),
  };
}

/**
 * The most recent draft still worth telling the model about: scanning newest to oldest, the first
 * log_draft block wins, UNLESS a later log_meal actually logged it. Evidence 2026-09-20:
 * runAttachmentTurn (lib/server/coach-attachments.ts) persists a photo draft under
 * `tool_calls.blocks` only, so the loop below reads the same raw `tool_calls` replayActions does,
 * not the already-mapped HistoryMessage, which carries no blocks.
 *
 * 2026-10-02 Grok audit: this used to stop at ANY later action, not only one that actually logged
 * the draft — a weigh-in or an avoid-list mark between the photo and "log it" hid the draft, and
 * the model had no idea what "it" meant. No action schema carries the draft's own id to match
 * precisely yet, so the available signal was narrowed to log_meal specifically.
 *
 * 2026-10-02 Grok audit (finding D): log_meal alone was still too broad — "I also had a banana"
 * between the photo and the eventual "log it" hid the draft just as completely as logging it would
 * have, because ANY later log_meal cleared it regardless of what it actually logged. No action
 * schema carries the draft's own id yet, so this falls back to matching by item identity: a log_meal
 * only resolves a draft when at least one of its items shares a foodRefId or name with that draft
 * (a correction, e.g. "it was bison not sausage", still overlaps on the OTHER unchanged items).
 * Items logged by any log_meal seen while walking backward accumulate, so a draft further back
 * still sees everything logged after it, not just the nearest log_meal.
 */
function findPendingDraft(
  rows: readonly { tool_calls: unknown }[], messages: readonly HistoryMessage[],
): string | null {
  const loggedRefs = new Set<string>();
  const loggedNames = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const block = pendingDraftBlockFrom(rows[i].tool_calls);
    if (block) {
      const { refs, names } = draftItemIdentities(block);
      const consumed = [...refs].some((ref) => loggedRefs.has(ref))
        || [...names].some((name) => loggedNames.has(name));
      if (!consumed) return renderPendingDraft(block);
    }
    for (const action of messages[i].actions ?? []) {
      if (action.kind !== "log_meal") continue;
      for (const item of action.items) {
        loggedRefs.add(item.foodRefId);
        loggedNames.add(item.name.toLowerCase());
      }
    }
  }
  return null;
}

/**
 * The thread's memory: its rolling summary, its last `MEMORY_MESSAGES` messages oldest first, and
 * the most recent still-open draft (T6 §1; the draft line, 2026-10-01). A brand-new thread has
 * none of the three, and a failed read is treated as an empty thread — the turn still answers, it
 * just answers without memory.
 */
export async function threadHistory(
  client: SupabaseClient, threadId: string | null,
): Promise<{ summary: string | null; messages: HistoryMessage[]; pendingDraft: string | null }> {
  if (!threadId) return { summary: null, messages: [], pendingDraft: null };
  const [thread, rows] = await Promise.all([
    client.from("coach_threads").select("summary").eq("id", threadId).maybeSingle(),
    client.from("coach_messages").select("role, content, seq, tool_calls")
      .eq("thread_id", threadId).order("seq", { ascending: false }).limit(MEMORY_MESSAGES),
  ]);
  const summary = (thread.data as { summary?: string | null } | null)?.summary ?? null;
  const sorted = ((rows.data ?? []) as { role: "user" | "assistant"; content: string;
    seq: number; tool_calls: unknown }[]).slice().sort((a, b) => a.seq - b.seq);
  const messages = sorted.map((row) => ({ role: row.role, content: row.content,
    actions: replayActions(row.tool_calls) }));
  return { summary, messages, pendingDraft: findPendingDraft(sorted, messages) };
}

export async function nextSeq(client: SupabaseClient, threadId: string): Promise<number> {
  const { data } = await client.from("coach_messages")
    .select("seq").eq("thread_id", threadId).order("seq", { ascending: false }).limit(1)
    .maybeSingle();
  return ((data as { seq: number } | null)?.seq ?? 0) + 1;
}

/**
 * generateStructured does not return the ai_calls id it wrote, and lib/ai/adapter.ts is a shared
 * file. The most recent ok row for this user and purpose is that call — one user, one turn at a
 * time. A miss leaves ai_call_id null rather than guessing. A coach turn passes every purpose its
 * model call can be written under (W035: an OpenRouter-served turn is `coach-openrouter`).
 */
export async function lastAiCallId(
  admin: SupabaseClient, userId: string, purpose: string | readonly string[],
): Promise<string | null> {
  const purposes = typeof purpose === "string" ? [purpose] : [...purpose];
  const { data } = await admin.from("ai_calls").select("id")
    .eq("user_id", userId).in("purpose", purposes).eq("status", "ok")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export type ThreadSummaryRow = { id: string; title: string | null; kind: string;
  last_message_at: string | null };

/**
 * Deletes a saved chat or the weekly-review thread (never a plan thread — that 404s like an
 * unknown id). A deleted review thread stays deleted; the next delivery opens a new one.
 */
export async function deleteChatThread(
  client: SupabaseClient, userId: string, threadId: string,
): Promise<void> {
  const { data, error } = await client.from("coach_threads")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", userId).eq("id", threadId).in("kind", CONVERSATION_KINDS).is("deleted_at", null)
    .select("id").maybeSingle();
  if (error) throw new HttpError(500, "internal", "Could not delete the thread.");
  if (!data) throw new HttpError(404, "not_found", "No such thread.");
}

/**
 * Empties a saved chat's (or the weekly-review thread's) transcript: every coach_messages row for
 * that thread, then the thread's rolling summary, last_message_at and unread mark are cleared. The
 * title survives, and ai_calls is never touched — it is billing history, not conversation state.
 * Clearing review messages removes their review_week stamps; the job_runs lock per (user, week)
 * still keeps a week from being reviewed twice.
 */
export async function clearChatThread(
  client: SupabaseClient, userId: string, threadId: string,
): Promise<void> {
  const { data: thread, error: threadError } = await client.from("coach_threads")
    .select("id").eq("user_id", userId).eq("id", threadId).in("kind", CONVERSATION_KINDS)
    .is("deleted_at", null).maybeSingle();
  if (threadError) throw new HttpError(500, "internal", "Could not read the thread.");
  if (!thread) throw new HttpError(404, "not_found", "No such thread.");
  const { error: deleteError } = await client.from("coach_messages")
    .delete().eq("user_id", userId).eq("thread_id", threadId);
  if (deleteError) throw new HttpError(500, "internal", "Could not clear the chat.");
  const { error: updateError } = await client.from("coach_threads")
    .update({ summary: null, last_message_at: null, unread_at: null })
    .eq("user_id", userId).eq("id", threadId);
  if (updateError) throw new HttpError(500, "internal", "Could not clear the chat.");
}

/**
 * Renames a saved chat or the weekly-review thread. Returns the same shape the list and create
 * routes return.
 */
export async function renameChatThread(
  client: SupabaseClient, userId: string, threadId: string, title: string,
): Promise<{ id: string; title: string | null; kind: string; lastMessageAt: string | null }> {
  const { data, error } = await client.from("coach_threads")
    .update({ title }).eq("user_id", userId).eq("id", threadId).in("kind", CONVERSATION_KINDS)
    .is("deleted_at", null).select("id, title, kind, last_message_at").maybeSingle();
  if (error) throw new HttpError(500, "internal", "Could not rename the thread.");
  if (!data) throw new HttpError(404, "not_found", "No such thread.");
  const row = data as ThreadSummaryRow;
  return { id: row.id, title: row.title, kind: row.kind, lastMessageAt: row.last_message_at };
}

export type ThreadSearchMatch = { messageId: string; snippet: string; at: string };
export type ThreadSearchResult = { threadId: string; title: string | null;
  matches: ThreadSearchMatch[] };

/** A plain-text window of ~120 chars around the first hit of any query word, never a quote mark. */
export function searchSnippet(content: string, q: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= 120) return clean;
  const lower = clean.toLocaleLowerCase("en-US");
  const words = q.toLocaleLowerCase("en-US").split(/\s+/).filter((word) => word.length > 0);
  const hits = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(first - 40, clean.length - 120));
  const fragment = clean.slice(start, start + 120).trim();
  return `${start > 0 ? "…" : ""}${fragment}${start + 120 < clean.length ? "…" : ""}`;
}

/**
 * Active chat threads only, owner only: title substring match plus websearch full-text on
 * coach_messages.content (the existing GIN index, english config). At most 20 threads and 3
 * message matches per thread; a title-only hit still appears, with matches: [].
 */
export async function searchChatThreads(
  client: SupabaseClient, userId: string, q: string,
): Promise<ThreadSearchResult[]> {
  const threads: { id: string; title: string | null; last_message_at: string | null }[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await client.from("coach_threads")
      .select("id, title, last_message_at").eq("user_id", userId).eq("kind", "chat")
      .is("deleted_at", null)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false }).range(start, start + 499);
    if (error) throw new HttpError(500, "internal", "Could not search your threads.");
    threads.push(...((data ?? []) as typeof threads));
    if (!data || data.length < 500) break;
  }
  if (threads.length === 0) return [];
  const lowerQ = q.toLocaleLowerCase("en-US");
  // W038: each thread ranks its own newest hits before the 20-thread limit, so one chatty thread
  // can no longer fill a global row limit and hide the matches in every other chat.
  const results: ThreadSearchResult[] = [];
  for (let i = 0; i < threads.length && results.length < SEARCH_THREAD_LIMIT; i += SEARCH_PARALLEL) {
    const batch = threads.slice(i, i + SEARCH_PARALLEL);
    const matches = await Promise.all(batch.map((thread) => threadMatches(client, userId, thread.id, q)));
    batch.forEach((thread, index) => {
      const titleHit = (thread.title ?? "").toLocaleLowerCase("en-US").includes(lowerQ);
      if (titleHit || matches[index].length > 0) {
        results.push({ threadId: thread.id, title: thread.title, matches: matches[index] });
      }
    });
  }
  return results.slice(0, SEARCH_THREAD_LIMIT);
}

const SEARCH_THREAD_LIMIT = 20;
const SEARCH_MATCHES_PER_THREAD = 3;
const SEARCH_PARALLEL = 4;

/** One thread's newest full-text hits; a failed read fails the whole search, never a partial one. */
async function threadMatches(
  client: SupabaseClient, userId: string, threadId: string, q: string,
): Promise<ThreadSearchMatch[]> {
  const { data, error } = await client.from("coach_messages")
    .select("id, thread_id, content, created_at").eq("user_id", userId).eq("thread_id", threadId)
    .textSearch("content", q, { type: "websearch", config: "english" })
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(SEARCH_MATCHES_PER_THREAD);
  if (error) {
    throw new HttpError(503, "history_unavailable", "Could not search saved messages. Try again.");
  }
  return ((data ?? []) as { id: string; content: string; created_at: string }[]).map((row) => ({
    messageId: row.id, snippet: searchSnippet(row.content, q), at: row.created_at }));
}

const IN_PROGRESS = "Still working on that one. Try again in a moment.";

/**
 * Saves one turn in one transaction (W088, migration 20270104120000): `coach_save_turn` creates the
 * thread when `newThreadTitle` is given, appends the rows at consecutive seqs and touches the thread
 * (last_message_at, and the summary when given), all or nothing — a failure leaves no empty thread
 * and no half turn. Returns the rows as saved.
 *
 * The rows hold consecutive seqs (a replay pairs the user row at N with the reply at N+1). When
 * another writer took one of them first, the function saves the rows again after the thread's new
 * last seq (W035, audit A151); only the same message id already saved is still "in progress".
 *
 * W018: the function is service-role only and is called with the session-verified user id. It
 * makes the checks the session client's RLS made on the user's own question (the thread is this
 * account's, the question carries no model fields), and the reply is still written by the server.
 */
export async function persist(
  _client: SupabaseClient, threadId: string, rows: MessageRow[], newThreadTitle: string | null,
  summary: string | null | undefined,
  kind: "chat" | "plan", admin: SupabaseClient,
): Promise<MessageRow[]> {
  const unanchored = rows.some((row, at) => row.role !== "user" && !rows.slice(0, at).some((user) =>
    user.role === "user" && user.thread_id === row.thread_id && user.user_id === row.user_id));
  if (unanchored) throw new HttpError(500, "internal", "Could not save the turn.");
  const { data, error } = await admin.rpc("coach_save_turn", {
    p_user_id: rows[0].user_id, p_thread_id: threadId, p_kind: kind,
    p_new_title: newThreadTitle === null ? null : newThreadTitle.slice(0, 80),
    p_rows: rows, p_summary: summary ?? null,
  });
  if (error) throw saveError(error, newThreadTitle !== null);
  const seqs = new Map(((data ?? []) as { id: string; seq: number }[])
    .map((saved) => [saved.id, saved.seq]));
  if (rows.some((row) => typeof seqs.get(row.id) !== "number")) {
    throw new HttpError(500, "internal", "Could not save the turn.");
  }
  return rows.map((row) => ({ ...row, seq: seqs.get(row.id) as number }));
}

/** The function's named refusals, as the turn answers them. */
function saveError(error: { message?: string }, newThread: boolean): HttpError {
  const message = error.message ?? "";
  if (message.includes("coach_chat_limit")) {
    return new HttpError(409, "chat_limit", "You have eight chats. Continue an existing chat.");
  }
  // The same message id already saved: a retry raced an attempt still running. Retryable, and
  // the next retry replays whichever attempt won (Sol review, 2026-09-23). A seq still taken after
  // the function's own retries is the same: another turn is mid-save on this thread.
  if (message.includes("coach_message_exists") || message.includes("coach_seq_busy")) {
    return new HttpError(503, "in_progress", IN_PROGRESS);
  }
  // W126 (migration 20270106090200): the thread was deleted after the turn's pre-read, on this or
  // another device. Answered as the pre-read answers a deleted thread.
  if (message.includes("coach_thread_deleted")) {
    return new HttpError(404, "not_found", "No such thread.");
  }
  if (newThread && message.includes("coach_thread_exists")) {
    return new HttpError(500, "internal", "Could not start a thread.");
  }
  return new HttpError(500, "internal", "Could not save the turn.");
}
