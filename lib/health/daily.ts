/**
 * The §3.5 merge rules, pure. The daily_health view is a plain aggregate; these rules are where the
 * contract is actually met, and lib/server/health-daily.ts is the only caller in production, so the
 * dashboard, the MCP tool and Phase 6 all read the same numbers (spec §4).
 */
import type { DailyHealthRow, NormalizedSample } from "@/lib/health/contract";
import { unionNonOverlappingDetail, type Interval } from "@/lib/health/intervals";
import { LB_PER_KG, toCanonical } from "@/lib/health/units";

export function localDateOf(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not an ISO 8601 timestamp: ${iso}`);
  // en-CA formats as YYYY-MM-DD; Intl applies the zone's offset for that instant, DST included.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit",
    day: "2-digit" }).format(new Date(ms));
}

export function emptyDay(localDate: string): DailyHealthRow {
  return { local_date: localDate, steps: null, active_kcal: null, sleep_minutes: null,
    body_mass_kg: null, resting_heart_rate: null, hrv_sdnn: null, readiness_score: null,
    sources: [], provenance: {} };
}

export function isWatch(deviceLabel?: string): boolean {
  return typeof deviceLabel === "string" && /watch/i.test(deviceLabel);
}

function isOura(deviceLabel?: string): boolean {
  return typeof deviceLabel === "string" && /oura/i.test(deviceLabel);
}

function intervalsFor(samples: NormalizedSample[]): Interval[] {
  return samples.map((s) => ({ start: Date.parse(s.start_time), end: Date.parse(s.end_time),
    value: s.value, preferred: isWatch(s.device_label) }));
}

/** Same device vocabulary as `sources`: a sample with no label is "unknown", never dropped. */
export function origin(deviceLabel?: string): string {
  return deviceLabel ?? "unknown";
}

/** The provenance of ONE observation: its source and its own `end_time`. Both fields come from the
 *  same sample, so the card can never name a source that did not produce the reading (T11a). */
function sourceOf(sample: NormalizedSample): { kind: string; end: string } {
  return { kind: sample.source_kind ?? origin(sample.device_label), end: sample.end_time };
}

/** The newest sample by `end_time` — the representative when a metric has no value rule. */
function latestByEnd(samples: NormalizedSample[]): NormalizedSample {
  let best = samples[0];
  for (const sample of samples) {
    if (Date.parse(sample.end_time) > Date.parse(best.end_time)) best = sample;
  }
  return best;
}

/** The max-value sample, ties broken by the newest end — sleep's winner. */
function maxValueWinner(samples: NormalizedSample[]): NormalizedSample {
  let best = samples[0];
  for (const sample of samples) {
    if (sample.value > best.value
      || (sample.value === best.value && Date.parse(sample.end_time) > Date.parse(best.end_time))) {
      best = sample;
    }
  }
  return best;
}

/** The min-value sample, ties broken by the newest end — the resting heart rate's winner. */
function minValueWinner(samples: NormalizedSample[]): NormalizedSample {
  let best = samples[0];
  for (const sample of samples) {
    if (sample.value < best.value
      || (sample.value === best.value && Date.parse(sample.end_time) > Date.parse(best.end_time))) {
      best = sample;
    }
  }
  return best;
}

/** Steps and active energy: the union, plus the newest sample that actually added to it. A sample
 *  entirely covered by a preferred source contributed nothing and is never named (T11a). */
function unionAttribution(samples: NormalizedSample[]): { value: number; source: {
    kind: string; end: string } } {
  const union = unionNonOverlappingDetail(intervalsFor(samples));
  const contributors = samples.filter((_, index) => union.contributing[index]);
  const named = contributors.length > 0 ? contributors : samples;
  return { value: union.total, source: sourceOf(latestByEnd(named)) };
}

/**
 * The heart and readiness block of a day (T11b), each value on the rule its own data demands and
 * each naming the sample it stands on: resting heart rate is the day's **minimum** (a single false
 * high — a walk to the bathroom — must not move it), HRV the day's **mean** (a summary by
 * definition, naming the newest sample behind it), and readiness the day's **latest** sample (Oura
 * publishes one score per day and a re-run corrects it).
 *
 * A PATCH, not a mutation of the caller's row (seventh-round finding 3): `rollUpDay` merges it into
 * the row it is building, so the block can never write to a row it does not own.
 *
 * Eighth round (finding 4): these three are the numbers a watch reports fractionally, and the SQL
 * `daily_health` view returns them at full precision — `min(value)`, `avg(value)`, the latest score.
 * Rounding here made TypeScript and SQL disagree about the same day (47 against 47.4), so the
 * roll-up keeps the value it was given and the RENDERER rounds (components/BodyDashboard.tsx).
 */
function heartAndReadiness(ordered: NormalizedSample[]): {
  values: Partial<DailyHealthRow>;
  provenance: DailyHealthRow["provenance"];
} {
  const values: Partial<DailyHealthRow> = {};
  const provenance: DailyHealthRow["provenance"] = {};

  const rhr = ordered.filter((s) => s.type === "resting_heart_rate");
  if (rhr.length > 0) {
    const winner = minValueWinner(rhr);
    values.resting_heart_rate = winner.value;
    provenance.resting_heart_rate = sourceOf(winner);
  }

  const hrv = ordered.filter((s) => s.type === "hrv_sdnn");
  if (hrv.length > 0) {
    values.hrv_sdnn = hrv.reduce((sum, s) => sum + s.value, 0) / hrv.length;
    provenance.hrv_sdnn = sourceOf(latestByEnd(hrv));
  }

  const readiness = ordered.filter((s) => s.type === "readiness_score");
  if (readiness.length > 0) {
    const winner = latestByEnd(readiness);
    values.readiness_score = winner.value;
    provenance.readiness_score = sourceOf(winner);
  }
  return { values, provenance };
}

export function rollUpDay(samples: NormalizedSample[], tz: string): DailyHealthRow {
  if (samples.length === 0) throw new Error("rollUpDay needs at least one sample");

  const ordered = [...samples].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  const row = emptyDay(localDateOf(ordered[0].start_time, tz));

  const steps = ordered.filter((s) => s.type === "step_count");
  if (steps.length > 0) {
    const rolled = unionAttribution(steps);
    row.steps = Math.round(rolled.value);
    row.provenance.step_count = rolled.source;
  }

  const energy = ordered.filter((s) => s.type === "active_energy");
  if (energy.length > 0) {
    const rolled = unionAttribution(energy);
    row.active_kcal = Math.round(rolled.value);
    row.provenance.active_energy = rolled.source;
  }

  const sleep = ordered.filter((s) => s.type === "sleep_asleep");
  if (sleep.length > 0) {
    const oura = sleep.filter((s) => isOura(s.device_label));
    const winning = oura.length > 0 ? oura : sleep;
    const winner = maxValueWinner(winning);
    row.sleep_minutes = Math.round(winner.value);
    row.provenance.sleep_asleep = sourceOf(winner);
  }

  const weighIns = ordered.filter((s) => s.type === "body_mass");
  if (weighIns.length > 0) {
    // T8 §2: a scale beats a number the user typed. A manual row is written when the user taps Save, which is
    // usually AFTER the watch has synced the morning's reading, so "latest wins" alone would let the
    // rounded number the user read off the scale overwrite the scale's own. A sample with no source kind
    // is an ingest sample: only `health_weigh_in` writes 'manual'.
    const ingest = weighIns.filter((s) => s.source_kind !== "manual");
    const winning = ingest.length > 0 ? ingest : weighIns;
    const latest = winning[winning.length - 1];
    // Never trust `latest.value` is already canonical kg (finding #53) — a legacy-migrated or
    // otherwise non-normalized row can carry unit "lb" with the raw pounds value.
    const canonical = toCanonical("body_mass", latest.value, latest.unit);
    row.body_mass_kg = Math.round(canonical.value * 1000) / 1000;
    row.provenance.body_mass = sourceOf(latest);
  }

  // T11b: RHR, HRV and readiness, extracted so neither this function nor that block runs long. It
  // returns a patch; this row is the one rollUpDay is building, and nothing else may write to it.
  const heart = heartAndReadiness(ordered);
  Object.assign(row, heart.values);
  Object.assign(row.provenance, heart.provenance);

  row.sources = [...new Set(ordered.map((s) => s.device_label ?? "unknown"))].sort();
  return row;
}

/** Which kind of source the day's weight came from, or null when the day has no weight. */
export type BodyMassSource = "ingest" | "manual" | null;

/**
 * The source behind a day's `body_mass_kg`, from the provenance the roll-up already recorded.
 * `/api/health/daily` puts provenance on the wire, so no new field is needed to tell the two apart.
 *
 * Null means "not known": either the day has no weight, or the row was cached before provenance
 * existed. Callers read that as a device reading, because nothing could write a manual sample then.
 */
export function bodyMassSource(day: DailyHealthRow | undefined): BodyMassSource {
  const kind = day?.provenance?.body_mass?.kind;
  if (day?.body_mass_kg === null || day?.body_mass_kg === undefined || !kind) return null;
  return kind === "manual" ? "manual" : "ingest";
}

/**
 * The header pill's number for one day (T8 §2), in pounds to one decimal, or null for no pill.
 *
 * Precedence, highest first:
 *
 *   1. an INGEST sample for the day — a scale beats anything typed;
 *   2. the value typed on this device for the day;
 *   3. the synced manual sample;
 *   4. nothing.
 *
 * 2 over 3 is the part that is easy to get backwards. The synced manual sample is a COPY of
 * something the user typed, and the copy can never be newer than the original: typing writes the local
 * store first and only then posts. Preferring any numeric `body_mass_kg` therefore pinned the pill
 * to the last SYNCED number — the user corrects 170 to 171, and the pill keeps saying 170 until the next
 * health fetch lands. An unknown source is treated as ingest (see `bodyMassSource`).
 */
export function pillWeightLb(
  bodyMassKg: number | null | undefined, source: BodyMassSource | undefined,
  localLb: number | undefined,
): number | null {
  const kg = typeof bodyMassKg === "number" ? bodyMassKg : null;
  const lb = kg !== null && source !== "manual" ? kg * LB_PER_KG
    : typeof localLb === "number" ? localLb
      : kg !== null ? kg * LB_PER_KG
        : null;
  return lb === null ? null : Math.round(lb * 10) / 10;
}
