/**
 * Oura v2 documents → canonical samples (spec §7). vendor_sample_id is the document id plus the
 * metric, so a re-pull of the same day lands on the same dedupe key and changes nothing
 * (acceptance criterion 7).
 */
import { DEFAULT_TZ, type NormalizedSample, type SampleType } from "@/lib/health/contract";
import { toCanonical } from "@/lib/health/units";

export const OURA_DEVICE_LABEL = "Oura";
/** Anchor tz for the synthetic `${day}T00:00:00Z`-style windows below (daily_activity, and the
 *  daily_readiness fallback with no real timestamp) — these are placeholders for Oura's own `day`
 *  label, not real instants, so they must stay tagged 'UTC' to keep recovering that same day. */
const OURA_SYNTHETIC_DAY_TZ = "UTC";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sample(id: string, type: SampleType, value: number, unit: string, start: string,
    end: string, tz: string, updatedAt?: string): NormalizedSample {
  return { type, ...toCanonical(type, value, unit), start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(), vendor_sample_id: `${id}:${type}`,
    vendor_updated_at: updatedAt, device_label: OURA_DEVICE_LABEL, tz };
}

/** usercollection/sleep — the sleep-period document; daily_sleep carries only a score. */
export function ouraSleepToSamples(doc: unknown): NormalizedSample[] {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d.id !== "string") return [];
  const start = typeof d.bedtime_start === "string" ? d.bedtime_start : null;
  const end = typeof d.bedtime_end === "string" ? d.bedtime_end : null;
  if (!start || !end) return [];

  const out: NormalizedSample[] = [];
  const asleep = num(d.total_sleep_duration);
  if (asleep !== null) out.push(sample(d.id, "sleep_asleep", asleep, "s", start, end, DEFAULT_TZ));
  const inBed = num(d.time_in_bed);
  if (inBed !== null) out.push(sample(d.id, "sleep_in_bed", inBed, "s", start, end, DEFAULT_TZ));
  const rhr = num(d.lowest_heart_rate);
  if (rhr !== null) out.push(sample(d.id, "resting_heart_rate", rhr, "bpm", start, end, DEFAULT_TZ));
  const hrv = num(d.average_hrv);
  if (hrv !== null) out.push(sample(d.id, "hrv_sdnn", hrv, "ms", start, end, DEFAULT_TZ));
  return out;
}

/** usercollection/daily_activity — steps and active energy over the whole local day. */
export function ouraActivityToSamples(doc: unknown): NormalizedSample[] {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d.id !== "string" || typeof d.day !== "string") return [];
  const start = `${d.day}T00:00:00Z`;
  const end = `${d.day}T23:59:59Z`;

  const out: NormalizedSample[] = [];
  const steps = num(d.steps);
  if (steps !== null) out.push(sample(d.id, "step_count", steps, "count", start, end, OURA_SYNTHETIC_DAY_TZ));
  const kcal = num(d.active_calories);
  if (kcal !== null) out.push(sample(d.id, "active_energy", kcal, "kcal", start, end, OURA_SYNTHETIC_DAY_TZ));
  return out;
}

/** usercollection/daily_readiness — one score, stored as an instantaneous sample. */
export function ouraReadinessToSamples(doc: unknown): NormalizedSample[] {
  const d = doc as Record<string, unknown> | null;
  if (!d || typeof d.id !== "string" || typeof d.day !== "string") return [];
  const score = num(d.score);
  if (score === null) return [];
  const hasRealTimestamp = typeof d.timestamp === "string";
  const at = hasRealTimestamp ? (d.timestamp as string) : `${d.day}T00:00:00Z`;
  const tz = hasRealTimestamp ? DEFAULT_TZ : OURA_SYNTHETIC_DAY_TZ;
  return [sample(d.id, "readiness_score", score, "score", at, at, tz)];
}
