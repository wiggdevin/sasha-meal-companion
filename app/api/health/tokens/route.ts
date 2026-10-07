/** POST /api/health/tokens — spec §5: issue a per-source token, returned exactly once. */
import { z } from "zod";
import { ianaTimeZoneSchema } from "@/lib/health/contract";
import { adminClient } from "@/lib/server/admin";
import { requireUser } from "@/lib/server/auth";
import { issueSourceToken } from "@/lib/server/health-tokens";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { toBytea } from "@/lib/server/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  kind: z.enum(["health_auto_export", "apple_health_shortcut", "manual"]),
  device_label: z.string().min(1).max(120).optional(),
  time_zone: ianaTimeZoneSchema.optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId } = await requireUser(req);
    await enforceRateLimit(`health:tokens:${userId}`, 20, 3600);
    const body = await readJson(req, bodySchema, 1024);

    const { raw, hash } = issueSourceToken();
    const { data, error } = await adminClient().from("health_sources")
      .insert({ user_id: userId, kind: body.kind, device_label: body.device_label ?? null,
        token_hash: toBytea(hash), time_zone: body.time_zone ?? null })
      .select("id, kind, device_label").single();
    if (error) throw error;

    // The plaintext is returned here and nowhere else; only the hash reaches Postgres (spec §8).
    return Response.json({ token: raw, source: data });
  } catch (e) {
    return jsonError(e);
  }
}
