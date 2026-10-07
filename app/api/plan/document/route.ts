/**
 * POST /api/plan/document — JWT, a body of at most a 3 MB PDF in base64, burst 8/min per user.
 * One uploaded meal plan, recipe or menu in (a photo path, a PDF or text); what it is and what it
 * says out (lib/server/plan-document.ts). Nothing is planned or saved: the panel places a matched
 * meal only after a tap.
 */
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { rateLimitKey } from "@/lib/server/capture-rate-limit";
import { jsonError, readJson } from "@/lib/server/http";
import { readDocument } from "@/lib/server/plan-document";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { documentRequestSchema, documentResultSchema, MAX_DOCUMENT_BODY } from "@/lib/plan/document-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Supabase project's own region (us-west-1 -> sfo1), as vercel.json "regions".
export const preferredRegion = ["sfo1"];
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(rateLimitKey(req, "plan:document"), 20, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`plan:document:user:${userId}`, 8, 60);
    const body = await readJson(req, documentRequestSchema, MAX_DOCUMENT_BODY);
    const result = await readDocument(adminClient(), client, userId, body);
    // The phone parses this body with documentResultSchema; a body it would refuse is caught here,
    // logged by field, and never sent as a "successful" read (re-audit r1 #5).
    const checked = documentResultSchema.safeParse(result);
    if (!checked.success) {
      console.error("plan document result outside the phone's schema", {
        paths: checked.error.issues.slice(0, 5).map((issue) => issue.path.join(".")),
      });
      return Response.json({ message: "Couldn’t read that file. Try again." }, { status: 502 });
    }
    return Response.json(result);
  } catch (e) {
    return jsonError(e);
  }
}
