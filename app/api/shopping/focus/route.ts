import { z } from "zod";
import { requireRecipeUser } from "@/lib/server/recipe-access";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import {
  clampExactFocusEnd, getShoppingFocusUntil, resolveFocusEnd, setShoppingFocusUntil,
} from "@/lib/server/shopping-focus";
import { FOCUS_MAX_DAYS, shoppingFocusActive } from "@/lib/shopping/focus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  on: z.boolean(), days: z.number().int().min(1).max(FOCUS_MAX_DAYS).optional(),
  /**
   * Undo-only (lib/coach/apply-shopping-focus.ts): the EXACT value to restore, bypassing
   * `resolveFocusEnd` — recomputing "N days from now" at undo time would not reproduce the
   * original timestamp (`now` has moved; a period-end default could have been a different date
   * entirely). Never sent by the coach action's own on/days request.
   */
  exact: z.union([z.string().datetime(), z.null()]).optional(),
});

/**
 * `GET` and `POST` share the one gate `set_shopping_focus` relies on for acceptance 4: an
 * account without Shopping access (`requireRecipeUser`) gets its 404 before anything is read or
 * written. `POST { on: false }` always clears the column outright rather than merely letting an
 * old timestamp lapse, so Undo (which restores whatever this returns as `previous`) always has an
 * exact value to put back, in either direction.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-focus:${userId}`, 60, 60);
    const until = await getShoppingFocusUntil(client, userId);
    return Response.json({ until, active: shoppingFocusActive(until, new Date()) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { client, userId } = await requireRecipeUser(req);
    await enforceRateLimit(`shopping-focus:${userId}`, 30, 60);
    const body = await readJson(req, Body, 500);
    const now = new Date();
    const until = body.exact !== undefined ? clampExactFocusEnd(body.exact, now)
      : body.on ? await resolveFocusEnd(client, userId, now, body.days) : null;
    const previous = await setShoppingFocusUntil(client, userId, until);
    return Response.json({ until, previous }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
