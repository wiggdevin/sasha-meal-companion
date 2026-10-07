/**
 * The Conversations list's own rules (U20, 2026-10-04): when a chat was last active, which group it
 * falls in, and a forgiving title search that answers on every keystroke while the server's search
 * over message text (from three characters) catches up.
 */
import type { ThreadSummary } from "@/lib/coach-client";

export type ThreadGroup = "Today" | "This week" | "Earlier" | "No messages yet";
export const GROUP_ORDER: readonly ThreadGroup[] = ["Today", "This week", "Earlier", "No messages yet"];

const DAY_MS = 86_400_000;

/** Whole local calendar days from `at` to `now`, counted on each date's own Y-M-D (via Date.UTC),
 *  not by dividing elapsed milliseconds. A span that crosses a daylight-saving change is an hour
 *  short or long, and floored ms read a week-old chat as "This week"; a date-line jump skips a
 *  whole date. Counting dates is exact for both. */
function daysBetween(at: Date, now: Date): number {
  const dayNumber = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
  return dayNumber(now) - dayNumber(at);
}

function activeAt(thread: ThreadSummary): Date | null {
  if (!thread.lastMessageAt) return null;
  const at = new Date(thread.lastMessageAt);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Today, the six days before it, or earlier; chats never used gather last, where they are easy to
 *  clear out. */
export function groupOf(thread: ThreadSummary, now: Date): ThreadGroup {
  const at = activeAt(thread);
  if (!at) return "No messages yet";
  const days = daysBetween(at, now);
  if (days <= 0) return "Today";
  return days < 7 ? "This week" : "Earlier";
}

/** "Now", "12 min", "3 h", "Yesterday", "Mon", "27 Sep" (with the year once it is not this one). */
export function relativeTime(thread: ThreadSummary, now: Date): string {
  const at = activeAt(thread);
  if (!at) return "";
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  const days = daysBetween(at, now);
  if (days <= 0) {
    if (minutes < 1) return "Now";
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h`;
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at);
  return new Intl.DateTimeFormat(undefined, at.getFullYear() === now.getFullYear()
    ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(at);
}

export function titleOf(thread: Pick<ThreadSummary, "title">): string {
  return thread.title?.trim() || "Untitled chat";
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** How many letters a forgiven word may span beyond its own length ("chiken" in "chicken"). */
const SLACK = 2;

/** True when `needle`'s letters appear in `hay` in order within a short span, so a word missing a
 *  letter still matches but letters scattered across a long title do not. */
function inOrder(needle: string, hay: string): boolean {
  for (let start = hay.indexOf(needle[0]); start >= 0; start = hay.indexOf(needle[0], start + 1)) {
    let at = start;
    let found = true;
    for (const letter of needle.slice(1)) {
      at = hay.indexOf(letter, at + 1);
      if (at < 0 || at - start + 1 > needle.length + SLACK) { found = false; break; }
    }
    if (found) return true;
  }
  return false;
}

/**
 * How well `query` matches `text`, higher is better, or null for no match. Every word must appear:
 * a word at the start of a word in the title scores highest, anywhere in it next, its letters in
 * order (a missed letter, "chiken") last.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const hay = fold(text);
  let score = 0;
  for (const word of words) {
    const index = hay.indexOf(word);
    if (index === 0 || (index > 0 && /\W/.test(hay[index - 1]))) score += 3;
    else if (index > 0) score += 2;
    else if (word.length >= 3 && inOrder(word, hay)) score += 1;
    else return null;
  }
  return score;
}

/** The chats whose titles match, best first and most recent first among equals. */
export function filterThreads(threads: readonly ThreadSummary[], query: string): ThreadSummary[] {
  if (!query.trim()) return [...threads];
  return threads
    .map((thread, index) => ({ thread, index, score: fuzzyScore(query, titleOf(thread)) }))
    .filter((row): row is { thread: ThreadSummary; index: number; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.thread);
}

/** Rows grouped Today / This week / Earlier / No messages yet, in the order given, empty groups left out. */
export function groupThreads(threads: readonly ThreadSummary[], now: Date): { group: ThreadGroup; threads: ThreadSummary[] }[] {
  return GROUP_ORDER.map((group) => ({ group, threads: threads.filter((thread) => groupOf(thread, now) === group) }))
    .filter((section) => section.threads.length > 0);
}
