import { requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { profilePilotEnabled } from "@/lib/server/profile-pilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** GET → { enabled } for the session user: show the optional onboarding cuisine question (W15). */
export async function GET(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    return Response.json({ enabled: profilePilotEnabled(userId) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}
