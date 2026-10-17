/**
 * Phase 5 wire contract. Every request and response type for the health routes is a zod schema with
 * an inferred type (spec §5); the 10-minute replay window is checked in the route, not here, because
 * the schema has no clock and a body that is merely late is still well-formed.
 */
import { z } from "zod";
import { isCalendarDate } from "@/lib/server/validate";

export const SAMPLE_TYPES = ["body_mass", "step_count", "active_energy", "basal_energy",
  "sleep_asleep", "sleep_in_bed", "resting_heart_rate", "hrv_sdnn", "readiness_score"] as const;
export type SampleType = (typeof SAMPLE_TYPES)[number];

/** The ingest path is narrower than the storage union: readiness and basal energy arrive from Oura,
 *  never from a phone payload (spec §5's sample `type` union). */
export const INGEST_SAMPLE_TYPES = ["body_mass", "step_count", "active_energy", "sleep_asleep",
  "sleep_in_bed", "resting_heart_rate", "hrv_sdnn"] as const;
export const INGEST_UNITS = ["kg", "lb", "count", "kcal", "min", "bpm", "ms"] as const;

export const DEFAULT_TZ = "UTC";
export const REPLAY_WINDOW_MS = 600_000;
export const MAX_INGEST_BYTES = 2 * 1024 * 1024;
export const MAX_DAILY_WINDOW_DAYS = 90;
export const MAX_SAMPLES_PER_PAYLOAD = 5000;

const isoInstant = z.string().min(1).max(64)
  .refine((s) => !Number.isNaN(Date.parse(s)), "not an ISO 8601 timestamp");
const isoDate = z.string().refine(isCalendarDate, "expected a real date, YYYY-MM-DD");

export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function healthTimeZone(
  sourceTimeZone?: string | null,
  userTimeZone?: string | null,
  environmentTimeZone?: string | null,
): string {
  return [sourceTimeZone, userTimeZone, environmentTimeZone, DEFAULT_TZ]
    .find(isIanaTimeZone) ?? DEFAULT_TZ;
}

export const ianaTimeZoneSchema = z.string().min(1).max(64)
  .refine(isIanaTimeZone, "expected an IANA time zone");

export const healthIngestSampleSchema = z.object({
  type: z.enum(INGEST_SAMPLE_TYPES),
  value: z.number().finite(),
  unit: z.enum(INGEST_UNITS),
  start_time: isoInstant,
  end_time: isoInstant,
  vendor_sample_id: z.string().min(1).max(200).optional(),
  vendor_updated_at: isoInstant.optional(),
  device_label: z.string().min(1).max(120).optional(),
});

export const healthIngestBodySchema = z.object({
  source_kind: z.enum(["health_auto_export", "apple_health_shortcut"]),
  sent_at: isoInstant,
  tz: ianaTimeZoneSchema,
  samples: z.array(healthIngestSampleSchema).max(MAX_SAMPLES_PER_PAYLOAD),
});
export type HealthIngestBody = z.infer<typeof healthIngestBodySchema>;

/**
 * Health Auto Export's REST automation posts its own document and cannot add a client timestamp or
 * a tz field. That shape is accepted separately; the route applies the sample-age rule to it instead
 * of the replay window (see lib/server/health-ingest.ts and "Open questions").
 */
export const healthAutoExportBodySchema = z.object({
  data: z.object({ metrics: z.array(z.unknown()).max(64) }),
});
export type HealthAutoExportBody = z.infer<typeof healthAutoExportBodySchema>;

export const ingestEnvelopeSchema = z.union([healthIngestBodySchema, healthAutoExportBodySchema]);
export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;

export const dailyQuerySchema = z.object({ from: isoDate, to: isoDate });

export type HealthIngestResponse = {
  event_id: string;
  status: "applied" | "duplicate";
  accepted: number;
  updated: number;
  skipped: number;
  rejected: Array<{ index: number; reason: string }>;
};

export type DailyHealthRow = {
  local_date: string; steps: number | null; active_kcal: number | null;
  sleep_minutes: number | null; body_mass_kg: number | null; sources: string[];
  /** T11b: the two heart metrics Oura already delivers. RHR is the day's minimum (an artefact —
   *  a false high — must not move it), HRV the day's mean. Both null when the day has none. */
  resting_heart_rate: number | null; hrv_sdnn: number | null;
  /** T11b: Oura's readiness for the day, its **latest** sample (Oura publishes one score per day,
   *  and a re-run is a correction — the newest one is the day's). Null when the day has none. */
  readiness_score: number | null;
  /** Where each metric on the row came from: the source's `health_sources.kind` and the latest
   *  contributing `end_time`. A metric with no observation has no key (Sol audit, T11a). */
  provenance: Record<string, { kind: string; end: string }>;
};

export type DailyHealthResponse = {
  days: DailyHealthRow[];
  sources: Array<{ id: string; kind: string; device_label: string | null;
                   last_received_at: string | null; revoked: boolean }>;
};

export type OuraPullResponse = { users: number; sources: number;
  results: Array<{ user_id: string; inserted: number; updated: number; skipped: number; error?: string }>;
  /** Set when the run stopped at its time budget; the next fire of the day resumes after it. */
  incomplete?: true;
  /** Set when another run held today's pass; this one did nothing. */
  busy?: true };

export type JobResponse = { ok: boolean; ran: number; skipped: number };

export type NormalizedSample = {
  type: SampleType; value: number; unit: string; start_time: string; end_time: string;
  vendor_sample_id?: string; vendor_updated_at?: string; device_label?: string; tz: string;
  /** The joined `health_sources.kind` behind this sample. Carried per sample (not via a label map)
   *  so two sources that share a `device_label` can never swap provenance (Sol audit, T11a). */
  source_kind?: string;
};

export type NormalizeResult = { samples: NormalizedSample[]; rejected: Array<{ index: number; reason: string }> };

export type OauthTokens = { access_token: string; refresh_token: string; expires_at: string; scope: string };
