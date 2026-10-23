import { after } from "next/server";
import { afterResponse } from "@/lib/server/after-response";
import { z } from "zod";
import { readAppCapabilities } from "@/lib/capabilities";
import { HttpError, requireUser } from "@/lib/server/auth";
import { adminClient } from "@/lib/server/admin";
import { refreshBarcode, resolveBarcode } from "@/lib/server/barcode";
import { clientIp, withRetryAfter } from "@/lib/server/catalog";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { BY_APP } from "@/lib/provenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// T0 §5: fluid-compute function config. The region is pinned to the Supabase project's own
// (us-west-1 -> sfo1, as vercel.json "regions") so every query in this route is a short hop,
// and `maxDuration` is the client budget in lib/fetch-with-deadline.ts plus room for the
// response, never more.
export const preferredRegion = ["sfo1"];
export const maxDuration = 15;

const MAX_BODY_BYTES = 8 * 1024;
const WINDOW_SECONDS = 60;

const Body = z.object({
  gtin: z.string().min(6).max(32),
  hint: z.object({ brand: z.string().max(120).optional(), name: z.string().max(120).optional() }).optional(),
});

/**
 * Contracts §2 orders this route "rate limit → identity → body". The per-user limit needs a user
 * id, so the first limiter is per IP exactly as /api/foods/search does it, and the 120/min/user
 * limit lands the moment requireUser returns. The 20/min outbound budget is injected into
 * resolveBarcode and is spent only on the branch that actually reaches a provider.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    // Read at request time, never a module const: the flag gates the route, and a test flips it.
    // Same rule as the rest of the app (lib/capabilities.ts): the server's FEATURE_SCAN wins, the
    // public twin is the fallback, so one flag turns the scanner off everywhere.
    if (!readAppCapabilities(process.env).scan) {
      throw new HttpError(404, "not_found", "That is not available.");
    }
    await enforceRateLimit(`barcode:ip:${clientIp(req)}`, 600, WINDOW_SECONDS);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`barcode:${userId}`, 120, WINDOW_SECONDS);
    const body = await readJson(req, Body, MAX_BODY_BYTES);
    const onOutbound = async (): Promise<void> => {
      await enforceRateLimit(`barcode:out:${userId}`, 20, WINDOW_SECONDS);
    };
    const answer = await resolveBarcode(client, adminClient(), userId, body, {
      onOutbound,
      // after() runs once the response is sent, so the 90-day refresh never sits on the hot path.
      scheduleRefresh: (g) => after(() => refreshBarcode(adminClient(), userId, g, { onOutbound })),
    });
    const matches = answer.status === "resolved" ? [answer.match]
      : answer.status === "ambiguous" ? answer.matches : [];
    if (matches.length > 0) afterResponse(async () => {
      try {
        const { ensureCatalogRevisionFacets } = await import("@/lib/foods/facet-warm");
        await ensureCatalogRevisionFacets(matches.map((match) => match.revisionId), { userId });
      } catch (error) {
        console.error("barcode facet warm failed", { error });
      }
    });
    // Catalog and provider data, matched in code: no model read it (C8 provenance).
    return Response.json({ ...answer, provenance: BY_APP });
  } catch (e) {
    const res = jsonError(e);
    return res.status === 429 ? withRetryAfter(res, WINDOW_SECONDS) : res;
  }
}
