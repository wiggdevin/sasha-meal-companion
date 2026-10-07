"use client";

/**
 * Pure body-summary view and formatting helpers retained for the full Body experience and its
 * tests. Today now presents these signals through HealthOrbit instead of mounting this card.
 */
import type { TdeeLine } from "@/components/TdeeLines";
import KcalText from "@/components/ui/KcalText";
import { sourceLabel } from "@/lib/health/today-card";
import SourceGlyph from "@/components/BodySourceGlyph";
import { lastSeen } from "@/components/BodyDashboard";
import type { DailyHealthRow } from "@/lib/health/contract";
import { LB_PER_KG } from "@/lib/health/units";

export type TodayCardRow = { key: string; label: string; value: string; source: string;
  asOf: string | null; meta: string | null };

const LABEL = "text-tiny font-normal text-muted";
const VALUE = "text-caption font-normal text-charcoal";
/* DESIGN.md type scale `body-sm` over the muted token — the same 12 px muted the other cards use. */
const META = "text-tiny font-normal text-muted";

function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "444" → "7:24" — the ticket's `h:mm`, minutes zero-padded. */
export function sleepText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Local wall-clock time for a contribution's `end_time`; "—" when it cannot be parsed. */
export function asOfText(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(ms);
}

/** A pre-T11 row can still arrive without `provenance`; never index a map that may be absent. */
function provenanceOf(day: DailyHealthRow | null): DailyHealthRow["provenance"] {
  return day?.provenance ?? {};
}

/** Viewed-day steps first, then device energy, sleep and weight. Missing observations are omitted. */
export function todayCardRows(day: DailyHealthRow | null): TodayCardRow[] {
  const metrics: Array<[string, string, string | null, string | null]> = [
    ["step_count", "Steps", day?.steps == null ? null : `${int(day.steps)} steps`, null],
    ["active_energy", "Device active energy",
      day?.active_kcal == null ? null : `${int(day.active_kcal)} kcal`,
      "Device estimate · not added to your food target"],
    ["sleep_asleep", "Sleep",
      day?.sleep_minutes == null ? null : sleepText(day.sleep_minutes), null],
    ["body_mass", "Weight", day?.body_mass_kg == null ? null
      : `${(Math.round(day.body_mass_kg * LB_PER_KG * 10) / 10).toLocaleString("en-US")} lb`, null],
  ];
  return metrics.flatMap(([key, label, value, meta]) => {
    if (value === null) return [];
    const origin = provenanceOf(day)[key];
    return [{ key, label, value, source: sourceLabel(origin?.kind ?? "unknown"),
      asOf: origin?.end ?? null, meta }];
  });
}

export default function BodyTodayCardView({ day, tdeeKcal = null, tdeeLine = null,
  profileError = false, offline = false, fetchedAt = null, stale = false,
  loading = false }: {
  day: DailyHealthRow | null; tdeeKcal?: number | null; tdeeLine?: TdeeLine | null;
  /** The profile read failed (T11b finding 6): this card says so instead of "still learning". */
  profileError?: boolean;
  /** gap-body-dashboard-11: `fetchDaily`'s own flags for `day` — a cached row served because the
   *  live request failed, and when it was written. */
  offline?: boolean; fetchedAt?: string | null;
  /** gap-body-dashboard-11: `fetchExpenditure`'s flag for the burn line — a cached estimate served
   *  because the live request failed. */
  stale?: boolean;
  /** The fetch is still in flight: a neutral line, never the "no source connected" claim
   *  (Sol audit gap-body-dashboard-10) — that claim is reserved for the settled, genuinely-empty
   *  case. */
  loading?: boolean;
}) {
  const rows = todayCardRows(day);
  const showsStaleData = offline || stale;

  return (
    <section className="shell">
      <a href="/body" className="tap surface flex flex-col gap-2 px-5 py-4 no-underline">
        <span className="flex items-center justify-between gap-2">
          <span className={LABEL}>Body</span>
          <span aria-hidden="true" className={LABEL}>View</span>
        </span>

        {loading ? (
          <span className={LABEL}>Loading…</span>
        ) : (
          <>
            {showsStaleData && (
              <span className={LABEL}>
                {fetchedAt ? `Offline — last synced ${lastSeen(fetchedAt)}.`
                  : "Offline — showing your last saved data."}
              </span>
            )}

            {rows.length === 0 ? (
              <span className={LABEL}>No body data yet — connect a source in Settings.</span>
            ) : (
              <span className="flex flex-col">
                {rows.map((row, index) => (
                  <span key={row.key}
                    className={`flex items-center justify-between gap-3 py-2 ${index === 0 ? "" : "border-t border-hairline"}`}>
                    <span className={`flex items-center gap-2 ${LABEL}`}>
                      <SourceGlyph kind={provenanceOf(day)[row.key]?.kind ?? "unknown"} />
                      {row.label}
                    </span>
                    <span className="flex flex-col items-end">
                      <span className={`tabular-nums ${VALUE}`}><KcalText text={row.value} /></span>
                      <span className={META}>{row.meta ?? `${row.source} · as of ${asOfText(row.asOf)}`}</span>
                    </span>
                  </span>
                ))}
              </span>
            )}
          </>
        )}

        <span className={LABEL}>{tdeeLine !== null ? <KcalText text={tdeeLineText(tdeeLine)} />
          : tdeeKcal !== null ? <KcalText text={`Burns about ${int(tdeeKcal)} kcal a day`} />
            : profileError ? "Couldn't read your profile — open Body" : "Still learning your burn"}</span>
      </a>
    </section>
  );
}

/** The one line, in the card's words, naming the line the number came from. */
export function tdeeLineText(line: TdeeLine): string {
  return `${line.label} · ${line.value}`;
}
