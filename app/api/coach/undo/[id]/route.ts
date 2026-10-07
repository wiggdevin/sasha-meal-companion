/**
 * POST /api/coach/undo/{id} — undo one recorded coach action (audit 2026-10-04 P1 #6, C4).
 *
 * Body `{}` performs the inverse on the server through the same sync op the phone's Undo sends;
 * `{ "local": true }` only marks the record, after the phone undid it through its own token.
 * 200 `{ undo, performed }`. Errors (`{ error, message }`, codes in lib/coach/undo-types.ts):
 * 404 not_found (none of the caller's), 409 undo_already_undone, 409 undo_conflict (a later
 * change exists; nothing written), 409 undo_not_synced (the action's own write has not arrived),
 * 410 undo_expired, 422 undo_local_only (this kind undoes only on the phone holding its token).
 */
import { z } from "zod";
import { coachEnabled } from "@/lib/capabilities";
import { performUndoSchema, type CoachUndoResult } from "@/lib/coach/undo-types";
import { HttpError, requireUser } from "@/lib/server/auth";
import { performUndo } from "@/lib/server/coach-undo";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const BODY_LIMIT_BYTES = 1_024;

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    if (!coachEnabled()) throw new HttpError(404, "not_found", "No such route.");
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`coach:undo:perform:${userId}`, 30, 60);
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) throw new HttpError(404, "not_found", "No such undo.");
    const body = await readJson(req, performUndoSchema, BODY_LIMIT_BYTES);
    const undo = await performUndo(client, userId, id, { local: body.local === true });
    const result: CoachUndoResult = { undo, performed: body.local ? "local" : "server" };
    return Response.json(result);
  } catch (e) {
    return jsonError(e);
  }
}
