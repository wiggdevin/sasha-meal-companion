import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { tasteChipsEnabled } from "@/lib/server/taste-flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Phase 18 W5b-3: GET → `{ enabled }` — may the phone offer the taste-chip text field? The answer is
 * `TASTE_CHIPS_ENABLED`, the same switch `POST /api/profile/prefs { taste }`, `/taste/confirm` and
 * `/taste/undo` read, so a phone can tell "off" (200 `{ enabled: false }`) from a failed request
 * before it draws the field. Side-effect free: no write, no model call, no rate-limit counter (as
 * `GET /api/onboarding/profile-pilot`). Auth required (401 without a session). No-store.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req);
    return Response.json({ enabled: tasteChipsEnabled() }, { headers: NO_STORE });
  } catch (error) {
    const res = jsonError(error);
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }
}
