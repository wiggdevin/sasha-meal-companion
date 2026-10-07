/**
 * POST/DELETE /api/health/weigh-in — JWT, 8 KB, 60/min/user (T8 §2).
 *
 * The POST decides nothing about the weigh-in: `health_weigh_in` owns the range, the zone, the
 * day and the one-row-per-day rule, and it reads `auth.uid()`, so the call carries no user id and
 * goes through the CALLER's client rather than the admin one. What belongs here is the shape, the
 * pounds-to-kilograms conversion (storage is kilograms — lib/health/units.ts), and turning the
 * RPC's raise into a line the FAB can show them.
 */

import { z } from "zod";
import { HttpError, requireUser } from "@/lib/server/auth";
import { lbToKg } from "@/lib/health/units";
import { adminClient } from "@/lib/server/admin";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

const envelope = z.object({
  localDate: z.string().regex(LOCAL_DATE),
  tz: z.string().min(1).max(64),
  lb: z.number().finite().positive(),
});

/**
 * The RPC's four `raise`s, and one line each in their voice. This map is exhaustive on purpose: it is
 * what separates a REFUSAL from a FAILURE.
 *
 * A refusal is permanent — that weight, that zone or that day will never be accepted — so the phone
 * shows the line and throws the request away. Everything else the RPC can answer with is the server
 * failing: the function missing because the migration has not landed yet, a PostgREST 500, a
 * statement timeout. Mapping one of those to 422 told the phone to discard a weigh-in it should
 * have kept, which is exactly the deploy window between this route shipping and its migration.
 * So: named raise → 422; anything else, and an answer with no row → 500, logged by `jsonError`.
 */
const REFUSALS: Record<string, string> = {
  weight_out_of_range: "That weight looks wrong. Check it and try again.",
  future_date: "That day has not happened yet.",
  bad_tz: "Could not read your time zone.",
  bad_weigh_in: "Could not save that weight.",
};

function refusalFor(message: string): HttpError | null {
  const raise = Object.keys(REFUSALS).find((name) => message.includes(name));
  return raise ? new HttpError(422, "invalid", REFUSALS[raise]) : null;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`health:weigh-in:ip:${ip}`, 60, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`health:weigh-in:user:${userId}`, 60, 60);

    const { localDate, tz, lb } = await readJson(req, envelope, MAX_BYTES);
    const { data, error } = await client.rpc("health_weigh_in",
      { p_local_date: localDate, p_tz: tz, p_kg: lbToKg(lb) });
    if (error) throw refusalFor(error.message) ?? new Error(`health_weigh_in: ${error.message}`);

    const row = (data as { sample_id: string; kg: number }[] | null)?.[0];
    if (!row) throw new Error("health_weigh_in returned no row");
    return Response.json({ kg: Number(row.kg), sampleId: row.sample_id });
  } catch (e) {
    return jsonError(e);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const ip = requestIp(req);
    await enforceRateLimit(`health:weigh-in:ip:${ip}`, 60, 60);
    const { userId } = await requireUser(req);
    await enforceRateLimit(`health:weigh-in:user:${userId}`, 60, 60);

    const date = new URL(req.url).searchParams.get("date");
    if (!date || !LOCAL_DATE.test(date)) {
      throw new HttpError(400, "bad_request", "date must be YYYY-MM-DD.");
    }

    // `health_samples` is select-only for authenticated callers. The server-only client performs
    // the delete, fenced to the authenticated user's manual body-mass key for this exact day.
    const { data, error } = await adminClient().from("health_samples").delete()
      .eq("user_id", userId)
      .eq("type", "body_mass")
      .eq("device_label", "manual")
      .eq("vendor_sample_id", `manual:${date}`)
      .select("id");
    if (error) throw new Error(`delete health weigh-in: ${error.message}`);
    if (!data?.length) throw new HttpError(404, "not_found", "No weigh-in for that day.");
    return new Response(null, { status: 204 });
  } catch (e) {
    return jsonError(e);
  }
}
