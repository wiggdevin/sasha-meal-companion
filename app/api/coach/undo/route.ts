/**
 * Server-recorded coach Undo (audit 2026-10-04 P1 #6, criterion C4).
 *
 * GET  ?threadId=&messageId=&actionId=&before=<cursor> — one page of the account's undo records,
 *      newest first: `{ undos: CoachUndoView[], next: string | null }`. Pass a page's `next` back
 *      as `before` to read the next (older) page (review t25 #3, paging only).
 * POST { actionId, kind, token, threadId? } — record one applied action's undo token. The action
 *      id must be on one of the caller's own coach messages with the same kind (404
 *      `unknown_action` otherwise). Idempotent per action: `{ undo: CoachUndoView }`.
 *
 * Performing an Undo is `POST /api/coach/undo/{id}`. Storage: `coach_action_undos`
 * (migration 20261210090300); logic: lib/server/coach-undo.ts.
 */
import { z } from "zod";
import { coachEnabled } from "@/lib/capabilities";
import { recordUndoSchema } from "@/lib/coach/undo-types";
import { HttpError, requireUser } from "@/lib/server/auth";
import { decodeCursor, listUndos, recordUndo } from "@/lib/server/coach-undo";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT_BYTES = 64_000;
const optionalId = z.uuid().optional();
const optionalActionId = z.string().min(1).max(128).optional();

function assertEnabled(): void {
  if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
}

function param(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) ?? undefined;
}

export async function GET(req: Request): Promise<Response> {
  try {
    assertEnabled();
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:undo:list:${userId}`, 60, 60);
    const url = new URL(req.url);
    const threadId = optionalId.safeParse(param(url, "threadId"));
    const messageId = optionalId.safeParse(param(url, "messageId"));
    const actionId = optionalActionId.safeParse(param(url, "actionId"));
    const rawBefore = param(url, "before");
    const before = rawBefore === undefined ? undefined : decodeCursor(rawBefore);
    if (!threadId.success || !messageId.success || !actionId.success || before === null) {
      throw new HttpError(400, "bad_request", "Bad undo filter.");
    }
    const page = await listUndos(client, userId,
      { threadId: threadId.data, messageId: messageId.data, actionId: actionId.data, before });
    return Response.json(page);
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertEnabled();
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:undo:record:${userId}`, 60, 60);
    const body = await readJson(req, recordUndoSchema, BODY_LIMIT_BYTES);
    const undo = await recordUndo(client, userId, body);
    return Response.json({ undo });
  } catch (e) {
    return jsonError(e);
  }
}
