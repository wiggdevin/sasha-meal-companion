/**
 * The ingest pipeline (spec §5): source → replay window → normalize → payload hash → one record RPC
 * (the dedupe event and the samples in one transaction, migration 20261230091000) → response. Identity is the source row, so every database call is a security-definer RPC
 * whose first argument is that row's user_id (§2.2 rule 3); withTokenUser is the MCP path and is
 * deliberately not used here (contracts §2).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { healthAutoExportBodySchema, healthIngestBodySchema, healthTimeZone, ianaTimeZoneSchema,
  MAX_SAMPLES_PER_PAYLOAD, REPLAY_WINDOW_MS, type HealthIngestResponse, type NormalizedSample,
  type NormalizeResult } from "@/lib/health/contract";
import { normalizeHealthAutoExportRows, normalizeShortcut,
  type HaeNormalizeResult } from "@/lib/health/normalize";
import { withinReplayWindow } from "@/lib/health/replay";
import { HttpError } from "@/lib/server/auth";

export type ResolvedSource = { id: string; userId: string; kind: string };

/** Health Auto Export cannot stamp a request, so its payload is bounded by sample age instead. */
export const HAE_FRESHNESS_WINDOW_DAYS = 8;
export const MAX_SAMPLE_AGE_MS = HAE_FRESHNESS_WINDOW_DAYS * 86_400_000;

export function payloadHash(body: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest();
}

function toBytea(hash: Buffer): string {
  return `\\x${hash.toString("hex")}`;
}

/**
 * Envelope-level schema for the Shortcut path. Samples stay `unknown` here and are validated one at
 * a time by normalizeShortcut, so a single malformed entry lands in `rejected` instead of failing
 * the whole request (spec §5: the request only dies on a zod failure *at the envelope level*).
 */
const shortcutEnvelopeSchema = healthIngestBodySchema.extend({
  samples: z.array(z.unknown()).max(MAX_SAMPLES_PER_PAYLOAD),
});

async function parsePayload(admin: SupabaseClient, source: ResolvedSource, body: unknown, now: Date):
    Promise<{ result: NormalizeResult }> {
  const canonical = shortcutEnvelopeSchema.safeParse(body);
  if (canonical.success) {
    if (canonical.data.source_kind !== source.kind) {
      throw new HttpError(403, "wrong_source_kind", "This token belongs to a different source kind.");
    }
    if (!withinReplayWindow(canonical.data.sent_at, now, REPLAY_WINDOW_MS)) {
      throw new HttpError(409, "replayed", "sent_at is outside the ten-minute window.");
    }
    const zone = await admin.rpc("set_health_source_time_zone", { p_user_id: source.userId,
      p_source_id: source.id, p_time_zone: canonical.data.tz });
    if (zone.error) console.error("health source time zone update failed", {
      sourceId: source.id, error: zone.error,
    });
    return { result: normalizeShortcut(canonical.data, canonical.data.tz) };
  }

  const shortcut = body as { source_kind?: unknown; tz?: unknown } | null;
  if (shortcut?.source_kind === "apple_health_shortcut"
      && !ianaTimeZoneSchema.safeParse(shortcut.tz).success) {
    throw new HttpError(422, "invalid_time_zone", "tz must be an IANA time zone.");
  }

  const hae = healthAutoExportBodySchema.safeParse(body);
  if (hae.success) {
    if (source.kind !== "health_auto_export") {
      throw new HttpError(403, "wrong_source_kind", "This token belongs to a different source kind.");
    }
    const context = await admin.rpc("health_ingest_time_zone_context", {
      p_user_id: source.userId, p_source_id: source.id,
    });
    if (context.error) throw new HttpError(500, "internal", "could not load the health time zone");
    const contextRow = (Array.isArray(context.data) ? context.data[0] : context.data) as {
      source_time_zone?: string | null; user_time_zone?: string | null;
    } | null;
    const tz = healthTimeZone(contextRow?.source_time_zone, contextRow?.user_time_zone,
      process.env.HEALTH_TZ);
    const result = normalizeHealthAutoExportRows(hae.data, tz, now);
    return { result: freshHealthAutoExport(result, now) };
  }

  throw new HttpError(422, "unprocessable", "Body is neither the ingest envelope nor an HAE export.");
}

/**
 * The 8-day freshness check runs on the FOLDED day (a partial day would overwrite the stored total
 * through the correction upsert), but a rejection names the payload rows that day was folded from,
 * the same index space every other rejection uses (A012).
 */
function freshHealthAutoExport(result: HaeNormalizeResult, now: Date): NormalizeResult {
  const fresh: NormalizedSample[] = [];
  const stale: NormalizeResult["rejected"] = [];
  result.samples.forEach((sample, position) => {
    if (now.getTime() - Date.parse(sample.start_time) > MAX_SAMPLE_AGE_MS) {
      for (const index of result.rows[position]) {
        stale.push({ index, reason: "sample outside the 8-day freshness window" });
      }
    } else {
      fresh.push(sample);
    }
  });
  const rejected = [...result.rejected, ...stale].sort((a, b) => a.index - b.index);
  return { samples: fresh, rejected };
}

type RecordRow = { event_id: string; is_new: boolean; accepted: number; updated: number;
  skipped: number };

export async function applyIngest(admin: SupabaseClient, source: ResolvedSource, body: unknown,
    now: Date = new Date()): Promise<HealthIngestResponse> {
  const { result } = await parsePayload(admin, source, body, now);

  // One call, one transaction: a failed apply rolls its event back, so the exporter's identical
  // retry is applied rather than answered "duplicate" (A009, A081).
  const recorded = await admin.rpc("health_ingest_record", { p_user_id: source.userId,
    p_source_id: source.id, p_payload_hash: toBytea(payloadHash(body)), p_samples: result.samples });
  if (recorded.error) {
    console.error("health ingest record failed", { sourceId: source.id, code: recorded.error.code });
    throw new HttpError(500, "internal", "could not apply the samples");
  }
  const row = (Array.isArray(recorded.data) ? recorded.data[0] : recorded.data) as RecordRow | null;
  if (!row?.event_id) throw new HttpError(500, "internal", "could not record the ingest event");
  if (!row.is_new) {
    return { event_id: row.event_id, status: "duplicate", accepted: 0, updated: 0, skipped: 0,
      rejected: [] };
  }
  return { event_id: row.event_id, status: "applied", accepted: row.accepted ?? 0,
    updated: row.updated ?? 0, skipped: row.skipped ?? 0, rejected: result.rejected };
}
