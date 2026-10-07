/**
 * What the server's answer to a commit MEANS, before anything acts on it.
 *
 * Its own file so lib/log-commit-client.ts stays under 400 lines; it is pure — a Response in, a
 * verdict out — and nothing here touches the store, the mirror or the outbox.
 */
import type { LogCommitFailure, LogCommitResponse } from "@/lib/log/contract";
import type { CommitAccepted, CommitRefused } from "@/lib/log-commit-settle";

/**
 * ONE verdict, derived from the HTTP status, for both halves of what happens next: what settles
 * locally, and what the sheet tells them.
 *
 * They used to be derived separately — settle from `res.ok`, the sheet from the body's `status` —
 * so a 4xx with an empty body rolled the card back as a refusal AND told the sheet "Logged",
 * which put the card straight back on Today: a meal the server had refused, sitting in their log
 * (Grok pass 3, HIGH 1). The body can no longer contradict the status line.
 *
 *   2xx → accepted, whatever the body. A body that is unreadable, names no status, or names a
 *         refusal is a body missing its details; the server still took the entry.
 *   4xx → refused, whatever the body. A named refusal keeps its own words; anything else becomes
 *         the generic one, because the user still has to be told.
 *
 * The transient statuses never reach here: they are queued before the body is read.
 */
const REFUSAL_STATUSES = new Set(["invalid", "conflict", "gone", "deleted", "stale_revision"]);

export async function readResult(
  res: Response
): Promise<LogCommitResponse | LogCommitFailure | CommitAccepted | CommitRefused | CommitUnread> {
  let body: unknown = null;
  let read = true;
  try {
    body = await res.json();
  } catch {
    read = false;
    console.warn(`The commit answer could not be read (${res.status}).`);
  }
  const named = (body as { status?: unknown } | null)?.status;
  const status = typeof named === "string" ? named : null;

  if (res.ok) {
    if (status === "ok") return body as LogCommitResponse;
    console.warn(`The commit was accepted (${res.status}) but its answer was not usable.`);
    return { status: "accepted" };
  }
  if (status !== null && REFUSAL_STATUSES.has(status)) return body as LogCommitFailure;
  // A 4xx whose body ran out of budget, or came back as something no one can parse, says the
  // server answered and nothing more. Treating it as a refusal took the card back, dropped the
  // queued write and rolled the mirror back — over an entry the server may well hold, which the
  // next pull then restored (Grok pass 26, HIGH 1). Only a named refusal rolls anything back.
  if (!read) return { status: "unread", http: res.status };
  console.warn(`The commit was refused (${res.status}) with no reason given.`);
  return { status: "refused" };
}

/** The server answered; what it said could not be read. Nothing local may be taken back on it. */
export type CommitUnread = { status: "unread"; http: number };

/** Accepted or refused — the one question settle and the sheet both ask of a result. */
export function isAccepted(result: { status: string }): boolean {
  return result.status === "ok" || result.status === "accepted";
}
