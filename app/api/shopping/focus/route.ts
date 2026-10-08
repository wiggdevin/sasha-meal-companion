import { z } from "zod";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import {
  focusDay, readShoppingFocusState, resolveFocusEnd, setShoppingFocus,
} from "@/lib/server/shopping-focus";
import { FOCUS_MAX_DAYS, shoppingFocusActive } from "@/lib/shopping/focus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * No timestamp field: the server decides every end (D7 default, or `days` from now, capped at 31).
 * `date` and `zone` are the phone's own day and zone, read only as hints for the account's day
 * (lib/server/account-day.ts); an implausible day is ignored.
 */
const Body = z.object({
  on: z.boolean(),
  days: z.number().int().min(1).max(FOCUS_MAX_DAYS).optional(),
  date: z.string().regex(ISO_DAY).optional(),
  zone: z.string().max(64).optional(),
}).strict();

/**
 * `GET` and `POST` share the one gate `set_shopping_focus` relies on for acceptance 4: an
 * account without Shopping access (`requireRecipeUser`) gets its 404 before anything is read or
 * written. `GET ?date=&zone=` answers `{ until, active, keys }`: the dated list/pantry keys the
 * phone's generators rank by while focus is on. `POST` answers `{ until, previous, actionId }`;
 * Undo is `POST /api/shopping/focus/undo { actionId }` and needs no timestamp.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-focus:${userId}`, 60, 60);
    const params = new URL(req.url).searchParams;
    const now = new Date();
    const day = await focusDay(client, userId, { clientDay: params.get("date"),
      requestZone: params.get("zone") }, now);
    const state = await readShoppingFocusState(client, userId, day, now);
    return Response.json({ until: state.until, active: shoppingFocusActive(state.until, now), keys: state.keys },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-focus:${userId}`, 30, 60);
    const body = await readJson(req, Body, 500);
    const now = new Date();
    const until = body.on
      ? await resolveFocusEnd(client, userId, now,
        await focusDay(client, userId, { clientDay: body.date, requestZone: body.zone }, now), body.days)
      : null;
    const write = await setShoppingFocus(userId, until);
    return Response.json(write, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}
