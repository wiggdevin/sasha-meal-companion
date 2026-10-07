import { seqCeiling } from "@/lib/coach/thread-paging";
/**
 * GET returns { thread, messages, cleared } paged by ?before=<seq>&limit=50; a GET without
 * `before` (the latest page, i.e. opening the thread) also clears its unread weekly-review mark.
 * `cleared` says whether the badge may settle: true when the mark was cleared or there was nothing
 * this read had to clear (no mark, or an older page, which is not an open); false only when the
 * clear write failed, so the mark is still set and the phone must keep its badge. DELETE
 * tombstones the thread.
 * Another user's thread answers 404, never 403, so the route confirms nothing about it.
 *
 * No change_log row is written: coach_threads is not a sync entity this wave (contracts §4), and
 * an unknown entity in the change feed would reach a client that iterates ENTITIES. Deviation
 * from the spec line "writes a delete op to change_log" — see Open questions.
 */

import { z } from "zod";
import { HttpError, requireUser } from "@/lib/server/auth";
import { toMessageView } from "@/lib/coach/message-view";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { coachEnabled } from "@/lib/capabilities";
import { deleteChatThread, renameChatThread } from "@/lib/server/coach-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const renameSchema = z.object({ title: z.string().trim().min(1).max(80) });

function assertEnabled(): void {
  if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertEnabled();
    await enforceRateLimit(`coach:thread:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:thread:${userId}`, 60, 60);
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const before = seqCeiling(url.searchParams.get("before"));
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

    const thread = await client.from("coach_threads")
      .select("id, title, kind, last_message_at, unread_at").eq("user_id", userId).eq("id", id)
      .is("deleted_at", null).maybeSingle();
    if (thread.error || !thread.data) throw new HttpError(404, "not_found", "No such thread.");
    const { unread_at: unreadAt, ...threadView } = thread.data as {
      id: string; title: string | null; kind: string; last_message_at: string | null;
      unread_at: string | null;
    };
    // Opening the latest page reads the thread: clear the weekly-review badge. Only a mark at or
    // before the one this read saw, so a review delivered meanwhile stays unread. A failed clear
    // never blocks the read; it answers `cleared: false` and the badge persists until the next open.
    let cleared = true;
    if (unreadAt && url.searchParams.get("before") === null) {
      const write = await client.from("coach_threads").update({ unread_at: null })
        .eq("user_id", userId).eq("id", id).lte("unread_at", unreadAt);
      if (write.error) {
        console.error("coach thread unread clear failed", { id });
        cleared = false;
      }
    }

    const messages = await client.from("coach_messages")
      // The model columns are read only to derive each reply's provenance (lib/coach/message-view.ts).
      .select("id, role, content, seq, created_at, tool_calls, model_id, ai_call_id, deflected")
      .eq("thread_id", id)
      .lt("seq", before)
      .order("seq", { ascending: false }).limit(limit);
    if (messages.error) throw new HttpError(500, "internal", "Could not read the transcript.");
    return Response.json({
      thread: threadView,
      messages: (messages.data ?? []).slice().reverse().map(toMessageView),
      cleared,
    });
  } catch (e) {
    return jsonError(e);
  }
}

/**
 * A saved chat or the weekly-review thread can be deleted here. Plan threads are server-owned
 * working state, not saved conversations, and answer 404 like an unknown id (contract §1). A
 * deleted review thread is not restored: the next delivery opens a fresh one.
 */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertEnabled();
    await enforceRateLimit(`coach:thread:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:thread:${userId}`, 60, 60);
    const { id } = await ctx.params;
    await deleteChatThread(client, userId, id);
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}

/** Renames a saved chat or the weekly-review thread. Another user's thread, or a plan thread, 404s. */
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    assertEnabled();
    await enforceRateLimit(`coach:thread:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:thread:${userId}`, 60, 60);
    const { id } = await ctx.params;
    const body = await readJson(req, renameSchema, 4 * 1024);
    const thread = await renameChatThread(client, userId, id, body.title);
    return Response.json(thread);
  } catch (e) {
    return jsonError(e);
  }
}
