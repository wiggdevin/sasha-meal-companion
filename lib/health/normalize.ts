/**
 * Two untrusted payload shapes in, canonical samples out (spec §7). Nothing here touches the
 * database; a malformed entry becomes a `rejected` row and its neighbours still apply (spec §5,
 * acceptance criterion 5).
 */
import { healthIngestSampleSchema, type NormalizedSample, type NormalizeResult,
  type SampleType } from "@/lib/health/contract";
import { localDateOf } from "@/lib/health/daily";
import { toCanonical } from "@/lib/health/units";

/**
 * Health Auto Export metric names → our sample types. An unlisted metric is rejected, not guessed.
 * basal_energy_burned is deliberately absent: contract.ts's INGEST_SAMPLE_TYPES excludes
 * basal_energy from every phone payload — it is Oura-only — so a phone-sourced reading is
 * rejected here rather than silently stored under the same type Oura's own measurement uses.
 */
export const HAE_METRIC_TYPES: Record<string, SampleType> = {
  step_count: "step_count", active_energy: "active_energy",
  "weight_&_body_mass": "body_mass", weight_body_mass: "body_mass",
  resting_heart_rate: "resting_heart_rate",
  heart_rate_variability: "hrv_sdnn", sleep_analysis: "sleep_asleep",
};

/** HAE writes "2026-09-15 13:00:00 -0400", which Date.parse does not accept on every runtime. */
function haeInstant(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})$/.exec(raw.trim());
  const iso = m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function finite(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function hourAfter(iso: string): string {
  return new Date(Date.parse(iso) + 3_600_000).toISOString();
}

const HAE_ADDITIVE_TYPES = new Set<SampleType>(["step_count", "active_energy"]);

/** One day's sample and the payload rows folded into it. */
type FoldedDay = { sample: NormalizedSample; rows: number[] };

/** Which of two same-day samples the fold keeps, or their sum for an additive type. */
function foldPair(prior: NormalizedSample, sample: NormalizedSample): NormalizedSample {
  if (HAE_ADDITIVE_TYPES.has(sample.type)) {
    const earliest = Date.parse(sample.start_time) < Date.parse(prior.start_time) ? sample : prior;
    return { ...earliest, value: prior.value + sample.value,
      start_time: earliest.start_time,
      end_time: Date.parse(sample.end_time) > Date.parse(prior.end_time)
        ? sample.end_time : prior.end_time };
  }
  if (sample.type === "sleep_asleep" || sample.type === "sleep_in_bed") {
    return sample.value > prior.value ? sample : prior;
  }
  return Date.parse(sample.start_time) >= Date.parse(prior.start_time) ? sample : prior;
}

/**
 * HAE correction identity is daily, so reduce every payload to that same daily grain before apply.
 * Each day keeps the payload rows it was folded from, so a rejection of the day can name them.
 */
function foldHealthAutoExportDays(entries: Array<{ sample: NormalizedSample; row: number }>):
    FoldedDay[] {
  const folded = new Map<string, FoldedDay>();
  for (const { sample, row } of entries) {
    const key = sample.vendor_sample_id!;
    const prior = folded.get(key);
    folded.set(key, prior
      ? { sample: foldPair(prior.sample, sample), rows: [...prior.rows, row] }
      : { sample, rows: [row] });
  }
  return [...folded.values()];
}

/** The HAE result plus, for each folded sample, the payload row indexes it came from (A012). */
export type HaeNormalizeResult = NormalizeResult & { rows: number[][] };

export function normalizeHealthAutoExport(
  payload: unknown,
  tz: string,
  receivedAt: Date = new Date(),
): NormalizeResult {
  const { samples, rejected } = normalizeHealthAutoExportRows(payload, tz, receivedAt);
  return { samples, rejected };
}

/**
 * `normalizeHealthAutoExport` with the payload rows behind each folded sample. Row indexes count
 * every data row across metrics, the space every `rejected` entry uses.
 */
export function normalizeHealthAutoExportRows(
  payload: unknown,
  tz: string,
  receivedAt: Date = new Date(),
): HaeNormalizeResult {
  const metrics = (payload as { data?: { metrics?: unknown } })?.data?.metrics;
  if (!Array.isArray(metrics)) {
    return { samples: [], rows: [],
      rejected: [{ index: -1, reason: "not a Health Auto Export payload" }] };
  }

  const samples: Array<{ sample: NormalizedSample; row: number }> = [];
  const rejected: NormalizeResult["rejected"] = [];
  let index = 0;

  for (const metric of metrics) {
    const m = metric as { name?: unknown; units?: unknown; data?: unknown };
    const type = typeof m.name === "string" ? HAE_METRIC_TYPES[m.name] : undefined;
    const rows = Array.isArray(m.data) ? m.data : [];
    if (!type) {
      rejected.push({ index, reason: `unknown metric ${String(m.name)}` });
      index += Math.max(rows.length, 1);
      continue;
    }
    const unit = typeof m.units === "string" ? m.units : "";

    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const at = haeInstant(r.date);
      if (!at) { rejected.push({ index, reason: "bad timestamp" }); index += 1; continue; }
      const device = typeof r.source === "string" ? r.source : undefined;

      if (type === "sleep_asleep") {
        const start = haeInstant(r.sleepStart) ?? at;
        const end = haeInstant(r.sleepEnd) ?? at;
        // One sample per row: the asleep total is the primary reading, in-bed time is the
        // fallback when the export omits it. Downstream never sees two samples for one row.
        const asleep = finite(r.asleep);
        const sleepType: SampleType = asleep !== null ? "sleep_asleep" : "sleep_in_bed";
        const hours = asleep ?? finite(r.inBed);
        if (hours !== null) {
          const localDay = localDateOf(start, tz);
          samples.push({ row: index, sample: { type: sleepType,
            ...toCanonical(sleepType, hours, unit || "hr"),
            start_time: start, end_time: end, device_label: device, tz,
            vendor_sample_id: `hae:${sleepType}:${localDay}`,
            vendor_updated_at: receivedAt.toISOString() } });
        } else {
          rejected.push({ index, reason: "no sleep value" });
        }
        index += 1;
        continue;
      }

      const qty = r.qty;
      if (typeof qty !== "number" || !Number.isFinite(qty)) {
        rejected.push({ index, reason: "value is not a number" }); index += 1; continue;
      }
      try {
        const end = type === "body_mass" ? at : hourAfter(at);
        const localDay = localDateOf(at, tz);
        samples.push({ row: index, sample: { type, ...toCanonical(type, qty, unit),
          start_time: at, end_time: end, device_label: device, tz,
          vendor_sample_id: `hae:${type}:${localDay}`, vendor_updated_at: receivedAt.toISOString() } });
      } catch (e) {
        rejected.push({ index, reason: e instanceof Error ? e.message : "bad sample" });
      }
      index += 1;
    }
  }

  const days = foldHealthAutoExportDays(samples);
  return { samples: days.map((d) => d.sample), rows: days.map((d) => d.rows), rejected };
}

export function normalizeShortcut(payload: unknown, tz: string): NormalizeResult {
  const raw = Array.isArray(payload) ? payload : (payload as { samples?: unknown })?.samples;
  const sentAt = Array.isArray(payload) ? undefined
    : (payload as { sent_at?: unknown })?.sent_at;
  if (!Array.isArray(raw)) {
    return { samples: [], rejected: [{ index: -1, reason: "not a Shortcut payload" }] };
  }

  const samples: NormalizedSample[] = [];
  const rejected: NormalizeResult["rejected"] = [];

  raw.forEach((entry, index) => {
    const parsed = healthIngestSampleSchema.safeParse(entry);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.join(".") ?? "sample";
      rejected.push({ index, reason: `schema: ${path}` });
      return;
    }
    const s = parsed.data;
    if (Date.parse(s.end_time) < Date.parse(s.start_time)) {
      rejected.push({ index, reason: "end_time before start_time" });
      return;
    }
    try {
      const localDay = localDateOf(s.start_time, tz);
      samples.push({ type: s.type, ...toCanonical(s.type, s.value, s.unit),
        start_time: s.start_time, end_time: s.end_time,
        vendor_sample_id: s.vendor_sample_id ?? `shortcut:${s.type}:${localDay}`,
        vendor_updated_at: s.vendor_updated_at
          ?? (typeof sentAt === "string" ? sentAt : undefined),
        device_label: s.device_label, tz });
    } catch (e) {
      rejected.push({ index, reason: e instanceof Error ? e.message : "bad sample" });
    }
  });

  return { samples, rejected };
}
