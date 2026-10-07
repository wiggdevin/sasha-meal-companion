/** Resolve citation IDs against live, same-account chat rows. Quoted text stays in its source. */
import { z } from "zod";
import { historyExcerpt } from "@/lib/coach/history-recall";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { coachEnabled } from "@/lib/capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ sources: z.array(z.object({
  threadId: z.uuid(), messageId: z.uuid(),
  matchTerms: z.array(z.string().regex(/^[\p{L}\p{N}]{3,40}$/u)).max(8).optional(),
})).min(1).max(4) });

export async function POST(req: Request): Promise<Response> {
  try {
    if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
    await enforceRateLimit(`coach:history-sources:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:history-sources:${userId}`, 60, 60);
    const { sources } = await readJson(req, schema, 4096);
    const threadIds = [...new Set(sources.map((source) => source.threadId))];
    const messageIds = [...new Set(sources.map((source) => source.messageId))];
    const [threads, messages] = await Promise.all([
      client.from("coach_threads").select("id, title").eq("user_id", userId)
        .eq("kind", "chat").is("deleted_at", null).in("id", threadIds),
      client.from("coach_messages").select("id, thread_id, seq, role, content, created_at")
        .eq("user_id", userId).in("id", messageIds)
        .in("role", ["user", "assistant"]),
    ]);
    if (threads.error || messages.error) {
      throw new HttpError(503, "history_unavailable", "Could not open saved evidence. Try again.");
    }
    const titleById = new Map((threads.data ?? []).map((row) => [row.id,
      row.title?.trim() || "Saved chat"]));
    const messageById = new Map((messages.data ?? []).map((row) => [row.id, row]));
    return Response.json({ sources: sources.flatMap(({ threadId, messageId, matchTerms }) => {
      const row = messageById.get(messageId);
      const title = titleById.get(threadId);
      if (!row || !title || row.thread_id !== threadId) return [];
      return [{ id: row.id, threadId, seq: row.seq, role: row.role,
        excerpt: historyExcerpt(row.content, matchTerms ?? []), createdAt: row.created_at, title }];
    }) });
  } catch (error) {
    return jsonError(error);
  }
}
