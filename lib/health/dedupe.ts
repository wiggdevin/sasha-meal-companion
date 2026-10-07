/**
 * The dedupe key must be byte-identical to health_samples.dedupe_key, the stored generated column in
 * supabase/migrations/20261013090200_fix_health_dedupe_key.sql. That column casts a numeric epoch to
 * bigint, and a numeric-to-bigint cast in Postgres ROUNDS — so this rounds too, rather than truncating.
 *
 * type is always folded in, even when a source supplies its own vendor_sample_id (audit #91): two
 * different sample types that happen to reuse one vendor id (e.g. sleep_asleep/sleep_in_bed derived
 * from one exported record) must not collide and silently corrupt each other's type. device_label is
 * folded into the computed branch (audit #19): two devices in one Health Auto Export payload reporting
 * the same type in the same hour must not collide and silently drop one device's reading.
 */
export function epochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not an ISO 8601 timestamp: ${iso}`);
  return Math.round(ms / 1000);
}

export function dedupeKey(s: { vendor_sample_id?: string; type: string; start_time: string;
                               end_time: string; device_label?: string }): string {
  const rest = typeof s.vendor_sample_id === "string" && s.vendor_sample_id.length > 0
    ? s.vendor_sample_id
    : `${epochSeconds(s.start_time)}|${epochSeconds(s.end_time)}|${s.device_label ?? ""}`;
  return `${s.type}:${rest}`;
}
