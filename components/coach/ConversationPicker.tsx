"use client";

/**
 * The saved-chat list (U20, 2026-10-04; owner: "this whole conversations setup should be a completely
 * different UI, like a visual representation of the actual chats … displayed differently than these
 * huge and variable pills. There should also be options to clear any of these conversations, and we
 * should also be able to search specific conversations").
 *
 * It rides the shared Sheet (the top X, Escape, the scrim; focus returns to its opener). "New chat"
 * sits on top; at the server's chat limit it says how to make room. The search filters titles on
 * every keystroke and, from three characters, asks the server to search inside messages, showing
 * the matching line under its chat. Rows are grouped Today / This week / Earlier
 * (conversations/ConversationRow.tsx). In "source" mode ("Ask from history") it only picks one.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import SearchField from "@/components/ui/SearchField";
import ConversationRow from "@/components/coach/conversations/ConversationRow";
import { filterThreads, groupThreads, relativeTime, titleOf } from "@/components/coach/conversations/list";
import {
  SEARCH_MIN, ThreadsUnavailable, searchThreads, type ThreadSearchHit,
} from "@/lib/coach/threads-client";
import type { ThreadSummary } from "@/lib/coach-client";
import { INSTANT, MORPH } from "@/lib/design/motion";
import { useUnreadThreads } from "@/components/coach/unread-threads";
import styles from "@/components/coach/conversations/Conversations.module.css";

type Props = {
  mode: "conversations" | "source";
  threads: readonly ThreadSummary[];
  /** Weekly review threads: listed first under "Reviews", managed and answered like a chat, and
   *  outside the chat limit. */
  reviews?: readonly ThreadSummary[];
  currentThreadId: string | null;
  selectedSourceId: string | null;
  busy: boolean;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
  onRetry: () => void;
  /** The server's chat limit; "New chat" waits for a delete beyond it. */
  limit?: number;
  onDelete?: (id: string) => Promise<void>;
  onClear?: (id: string) => Promise<void>;
  onRename?: (id: string, title: string) => Promise<void>;
  search?: (query: string, signal: AbortSignal) => Promise<ThreadSearchHit[]>;
  now?: () => Date;
};

/** How to make room for a new chat. An account kept from before the limit can hold more than it,
 *  so the line counts what has to go rather than saying "one". */
export function limitLine(count: number, limit: number): string {
  const over = count - limit + 1;
  return over <= 1
    ? `You can keep ${limit} chats. Delete one to start a new chat: swipe it left, or use its … menu.`
    : `You can keep ${limit} chats and have ${count}. Delete ${over} to start a new chat: swipe each left, or use its … menu.`;
}

const UNAVAILABLE = "Deleting, clearing and renaming chats arrive with the next update.";
const SEARCH_WAIT_MS = 250;

/** The search words in a snippet, in bold. The snippet is plain text; React escapes it. */
function marked(snippet: string, query: string): ReactNode {
  const words = query.trim().split(/\s+/).filter((word) => word.length >= 2)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return snippet;
  const parts = snippet.split(new RegExp(`(${words.join("|")})`, "gi"));
  return parts.map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part);
}

function useServerSearch(query: string, search: NonNullable<Props["search"]>) {
  const [hits, setHits] = useState<{ query: string; rows: ThreadSearchHit[] } | null>(null);
  const [state, setState] = useState<"idle" | "unavailable" | "failed">("idle");
  const q = query.trim();
  useEffect(() => {
    if (q.length < SEARCH_MIN) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void search(q, controller.signal).then((rows) => { setHits({ query: q, rows }); setState("idle"); })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState(error instanceof ThreadsUnavailable ? "unavailable" : "failed");
        });
    }, SEARCH_WAIT_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, search]);
  return { hits: q.length >= SEARCH_MIN && hits?.query === q ? hits.rows : [], state: q.length >= SEARCH_MIN ? state : "idle" };
}

const defaultSearch = (query: string, signal: AbortSignal) => searchThreads(query, { signal });

export default function ConversationPicker({ mode, threads, reviews = [], currentThreadId, selectedSourceId,
  busy, loading, error, onSelect, onNew, onClose, onRetry, limit = 8,
  onDelete, onClear, onRename, search = defaultSearch, now = () => new Date() }: Props) {
  const sourceMode = mode === "source";
  const reduce = useReducedMotion();
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const server = useServerSearch(sourceMode ? "" : query, search);
  const atLimit = threads.length >= limit;
  /** "New chat" tapped at the limit: the list takes focus and a notice says what to delete (Kimi K6:
   *  a disabled button there read as dead, with its reason two lines away). */
  const [roomAsked, setRoomAsked] = useState(false);
  const list = useRef<HTMLDivElement | null>(null);
  const showRoom = atLimit && roomAsked;
  const options = sourceMode ? threads.filter((thread) => thread.id !== currentThreadId) : threads;
  const unread = new Set(useUnreadThreads().map((thread) => thread.id));
  const reviewRows = sourceMode ? [] : filterThreads(reviews, query);

  const rows = useMemo(() => {
    const titled = filterThreads(options, query);
    const seen = new Set(titled.map((thread) => thread.id));
    const fromMessages = server.hits.map((hit) => options.find((thread) => thread.id === hit.threadId))
      .filter((thread): thread is ThreadSummary => !!thread && !seen.has(thread.id));
    return [...titled, ...fromMessages];
  }, [options, query, server.hits]);
  const snippets = new Map(server.hits.map((hit) => [hit.threadId, hit.matches[0]?.snippet]));
  const at = now();
  /** One managed row, a chat's or a review's: open, swipe or "…" to delete, clear and rename. */
  const managedRow = (thread: ThreadSummary) => <ConversationRow thread={thread} time={relativeTime(thread, at)}
    current={thread.id === currentThreadId} disabled={busy || loading}
    unread={unread.has(thread.id)}
    manageable={!!onDelete && !(busy && thread.id === currentThreadId)}
    snippet={snippets.get(thread.id) ? marked(snippets.get(thread.id)!, query) : undefined}
    onOpen={() => onSelect(thread.id)}
    actions={{
      onDelete: guarded(() => onDelete?.(thread.id) ?? Promise.resolve()),
      onClear: guarded(() => onClear?.(thread.id) ?? Promise.resolve()),
      onRename: (title) => guarded(() => onRename?.(thread.id, title) ?? Promise.resolve())(),
    }} />;

  /** Runs a row action; a refusal is shown above the list and still fails the row's own button. */
  const guarded = (action: () => Promise<void>) => async () => {
    setNotice(null);
    try { await action(); }
    catch (caught) {
      setNotice(caught instanceof ThreadsUnavailable ? UNAVAILABLE
        : caught instanceof Error ? caught.message : "That did not save. Try again.");
      throw caught;
    }
  };

  function newChat() {
    if (!atLimit) { onNew(); return; }
    setRoomAsked(true);
    list.current?.focus({ preventScroll: true });
    list.current?.scrollIntoView?.({ block: "nearest" });
  }

  const header = sourceMode ? null : <div className="flex flex-col gap-2">
    <Button variant={atLimit ? "secondary" : "primary"} block disabled={busy || loading}
      aria-describedby={atLimit ? "conversation-limit" : undefined} onClick={newChat}>
      {atLimit ? "New chat · make room first" : "New chat"}
    </Button>
    {atLimit && !showRoom && <p id="conversation-limit" className={`${styles.limit} text-tiny`}>
      {limitLine(threads.length, limit)}</p>}
    {showRoom && <div id="conversation-limit"><Notice tone="attention" title="Delete a chat to make room">
      {limitLine(threads.length, limit)}</Notice></div>}
  </div>;

  return <Sheet title={sourceMode ? "Ask from history" : "Conversations"}
    subtitle={sourceMode ? "Choose one saved conversation for your next question."
      : "Tap to open. Swipe left to delete."}
    onClose={onClose}>
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {!sourceMode && <SearchField value={query} onValueChange={setQuery} label="Search chats" />}
      {busy && <p role="status" className="m-0 text-caption text-graphite">Finishing this reply…</p>}
      {error && <Notice tone="error" title={error} action={{ label: "Retry", onClick: onRetry }} />}
      {notice && <Notice tone="attention" title={notice} onDismiss={() => setNotice(null)} />}
      {loading && <p role="status" className="m-0 text-caption text-graphite">Loading conversations…</p>}
      {server.state === "unavailable" && <p className="m-0 text-tiny text-muted">
        Searching inside messages arrives with the next update. Titles are searched.</p>}
      {server.state === "failed" && <p className="m-0 text-tiny text-muted">
        Message search did not answer. Titles are searched.</p>}
      {sourceMode && <Button variant={selectedSourceId === currentThreadId ? "primary" : "secondary"} block
        disabled={!currentThreadId || busy || loading} aria-pressed={selectedSourceId === currentThreadId}
        onClick={() => currentThreadId && onSelect(currentThreadId)}>This conversation</Button>}
      <div ref={list} tabIndex={-1} role="group" className="flex min-w-0 flex-col gap-4 outline-none"
        aria-label="Saved conversations">
        {reviewRows.length > 0 && <section className={styles.group}>
          <h3 className="m-0 px-1 text-overline uppercase text-muted">Reviews</h3>
          <ul className={styles.list}>
            <AnimatePresence initial={false}>
            {reviewRows.map((thread) => <motion.li key={thread.id} className={styles.item}
              exit={{ height: 0, opacity: 0, transition: reduce ? INSTANT : MORPH.frame }}>
              {managedRow(thread)}
            </motion.li>)}
            </AnimatePresence>
          </ul>
        </section>}
        {groupThreads(rows, at).map((section) => <section key={section.group} className={styles.group}>
          <h3 className="m-0 px-1 text-overline uppercase text-muted">{section.group}</h3>
          <ul className={styles.list}>
            <AnimatePresence initial={false}>
            {section.threads.map((thread) => <motion.li key={thread.id} className={styles.item}
              exit={{ height: 0, opacity: 0, transition: reduce ? INSTANT : MORPH.frame }}>
              {sourceMode
                ? <button type="button" className={`tap ${styles.open}`} disabled={busy || loading}
                    aria-pressed={selectedSourceId === thread.id}
                    data-selected={selectedSourceId === thread.id ? "true" : undefined}
                    onClick={() => onSelect(thread.id)}>
                    <span className={styles.line}>
                      <span className={`${styles.title} text-caption font-medium`}>{titleOf(thread)}</span>
                      <span className={`${styles.time} text-tiny`}>{relativeTime(thread, at)}</span>
                    </span>
                  </button>
                : managedRow(thread)}
            </motion.li>)}
            </AnimatePresence>
          </ul>
        </section>)}
        {!rows.length && !reviewRows.length && !loading && <Notice tone="neutral" title={query.trim()
          ? `No chats match “${query.trim()}”.`
          : sourceMode ? "No other saved conversations yet." : "No saved conversations yet."} />}
      </div>
    </div>
  </Sheet>;
}
