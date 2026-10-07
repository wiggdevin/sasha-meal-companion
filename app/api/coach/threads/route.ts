/** GET lists their threads; POST creates one. architecture §5: JWT, 4 KB, 60/min/user, RLS (§2.1). */

import { z } from "zod";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import { coachEnabled } from "@/lib/capabilities";
import { searchChatThreads } from "@/lib/server/coach-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ title: z.string().min(1).max(80).optional() });
const searchQuerySchema = z.string().trim().min(3).max(100);

function assertEnabled(): void {
  if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
}

/**
 * Without `q` the listing behaves as before, plus `unread` per thread: true while a delivered weekly
 * review waits unopened (coach_threads.unread_at; opening the thread clears it). With `q`, a search
 * over active chats only.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    assertEnabled();
    await enforceRateLimit(`coach:threads:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:threads:${userId}`, 60, 60);
    const q = new URL(req.url).searchParams.get("q");
    if (q !== null) {
      const parsed = searchQuerySchema.safeParse(q);
      if (!parsed.success) {
        throw new HttpError(400, "bad_request", "q must be 3 to 100 characters.");
      }
      const results = await searchChatThreads(client, userId, parsed.data);
      return Response.json({ results });
    }
    const rows: { id: string; title: string | null; kind: string; last_message_at: string | null;
      unread_at: string | null }[] = [];
    // A legacy account can already have more than eight. Read every saved row, not only
    // PostgREST's default first 1,000, so all old chats remain accessible.
    for (let start = 0; ; start += 500) {
      const { data, error } = await client.from("coach_threads")
        .select("id, title, kind, last_message_at, unread_at").eq("user_id", userId)
        .is("deleted_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false }).range(start, start + 499);
      if (error) throw new HttpError(500, "internal", "Could not read your threads.");
      rows.push(...(data ?? []));
      if (!data || data.length < 500) break;
    }
    return Response.json(rows.map((t) => ({
      id: t.id, title: t.title, kind: t.kind, lastMessageAt: t.last_message_at,
      unread: t.unread_at !== null && t.unread_at !== undefined,
    })));
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertEnabled();
    await enforceRateLimit(`coach:threads:pre:ip:${requestIp(req)}`, 120, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:threads:${userId}`, 60, 60);
    const body = await readJson(req, createSchema, 4 * 1024);
    const { data, error } = await client.from("coach_threads")
      .insert({ user_id: userId, title: body.title ?? null, kind: "chat" })
      .select("id, title, kind, last_message_at").single();
    if (error?.message.includes("coach_chat_limit")) {
      throw new HttpError(409, "chat_limit", "You have eight chats. Continue an existing chat.");
    }
    if (error || !data) throw new HttpError(500, "internal", "Could not start a thread.");
    return Response.json(data);
  } catch (e) {
    return jsonError(e);
  }
}
