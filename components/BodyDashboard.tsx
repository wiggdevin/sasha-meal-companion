"use client";

/**
 * `/body` — the metric sparklines, the three TDEE lines and the source list (T11a/T11b).
 *
 * Sol audit finding 5: the page hands this two windows of the same fetch. `response.days` is the
 * 15-day window the TDEE lines read (so a weigh-in 8–14 days old still counts), `chart` is the
 * latest 7 of it — what the sparklines plot. Sol audit finding 11: the series construction, the
 * TDEE panel and the sources panel are separate functions, so no one function here runs long.
 * Third round: readiness joins the sparkline set — Oura stores it, the roll-up and the view carry
 * it, and nothing showed it (Sol audit, T11b finding 3).
 */
import HealthMetricCard from "@/components/HealthMetricCard";
import { Button, EmptyState } from "@/components/ui";
import ProfileReadAlert from "@/components/ProfileReadAlert";
import ProposalCard from "@/components/ProposalCard";
import TdeeLines from "@/components/TdeeLines";
import WeightTrend from "@/components/WeightTrend";
import { sleepText } from "@/components/BodyTodayCard";
import { visibleProposal, type Fresh } from "@/lib/estimator-client";
import { formatWeight, kgToLb as kilogramsToPounds, lbToKg, type WeightUnit }
  from "@/lib/health/units";
import { loadStore } from "@/lib/store";
import type { DailyHealthResponse, DailyHealthRow } from "@/lib/health/contract";
import { PROFILE_UNAVAILABLE, type ProfileState } from "@/lib/tdee";
import type { ExpenditureResponse, ProposalSummary } from "@/lib/api-types";
import type { ActivityContextV1 } from "@/lib/activity/summary";
import { lastSeen } from "@/lib/health/last-seen";
import type { EstimateStatus } from "@/lib/health/body-page";
import Notice from "@/components/ui/Notice";

/** Storage is kilograms; this compatibility export converts one value to pounds. */
export function kgToLb(kg: number): number {
  return kilogramsToPounds(kg);
}

export function formatMetric(value: number | null, unit: string): string {
  if (value === null) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-US")} ${unit}`;
}

export function daysWithData(points: (number | null)[]): number {
  return points.filter((p) => p !== null).length;
}

export { lastSeen } from "@/lib/health/last-seen";

/* DESIGN.md's fixed per-macro gauge colours, by token rather than by literal: calories orange,
   protein blue, carbs olive, fat gold. They belong to the four macro cards and are never
   reassigned; the heart and readiness series are not macros, so they stroke in the neutral
   secondary text token (split audit, finding 1 — a fifth and sixth use of the macro palette read
   as a macro). */
const GAUGE = { calories: "var(--color-gauge-calories)", protein: "var(--color-gauge-protein)",
  carbs: "var(--color-gauge-carbs)", fat: "var(--color-gauge-fat)" };
const NEUTRAL_STROKE = "var(--color-text-secondary)";
const PANEL_TITLE = "text-title text-section";
const MUTED = "text-tiny font-normal text-muted";

/** One sparkline's data — the card shells are identical, so only the series is named here. */
export type MetricCardSpec = { key: string; eyebrow: string; value: string;
  points: (number | null)[]; stroke: string; footnote: string };

function latest<T>(points: (T | null)[]): T | null {
  for (let i = points.length - 1; i >= 0; i -= 1) if (points[i] !== null) return points[i];
  return null;
}

/** The six metric series, from the chart window — one builder, so the cards only draw them. */
export function bodyMetricSeries(
  days: readonly DailyHealthRow[],
  weightUnit: WeightUnit = "lb",
): MetricCardSpec[] {
  const spec = (eyebrow: string, points: (number | null)[], stroke: string,
      unit: string, formatValue?: (value: number | null) => string): MetricCardSpec => ({
    key: eyebrow, eyebrow, points, stroke,
    value: formatValue ? formatValue(latest(points)) : formatMetric(latest(points), unit),
    footnote: `${daysWithData(points)} of ${days.length} days with data` });
  return [
    spec("Weight", days.map((d) => d.body_mass_kg === null ? null
      : Math.round((weightUnit === "lb" ? kgToLb(d.body_mass_kg) : d.body_mass_kg) * 10) / 10),
    GAUGE.protein, weightUnit, (value) => value === null ? "—"
      : formatWeight(weightUnit === "lb" ? lbToKg(value) : value, weightUnit)),
    /* Body's h:mm sleep reading — not the generic `formatMetric`, which would print raw minutes
       with a spurious tenths digit. */
    spec("Sleep", days.map((d) => d.sleep_minutes), GAUGE.carbs, "min",
      (value) => (value === null ? "—" : sleepText(value))),
    spec("Steps", days.map((d) => d.steps), GAUGE.fat, "steps"),
    spec("Device active energy estimate", days.map((d) => d.active_kcal), GAUGE.calories, "kcal"),
    /* T11b: RHR and HRV. A row cached by a build from before T11b has no key at all, and
       undefined would reach the gauge as NaN (same reasoning as T11a's provenance repair). */
    spec("Resting heart rate", days.map((d) => d.resting_heart_rate ?? null), NEUTRAL_STROKE, "bpm"),
    spec("HRV", days.map((d) => d.hrv_sdnn ?? null), NEUTRAL_STROKE, "ms"),
    /* T11b finding 3: readiness is stored by the Oura pull and was dropped by the roll-up, the
       dashboard, MCP and the export. A null (`?? null`) is a day with no score, never a zero. */
    spec("Readiness", days.map((d) => d.readiness_score ?? null), NEUTRAL_STROKE, "score"),
  ];
}

export type MovementPattern = { label: string; currentCoverage: string; baselineCoverage: string };

export function movementPattern(context?: ActivityContextV1): MovementPattern {
  const labels: Record<ActivityContextV1["band"], string> = {
    lower: "Lower than usual", usual: "Near usual", higher: "Higher than usual",
    insufficient: "Keep syncing",
  };
  return {
    label: context ? labels[context.band] : labels.insufficient,
    currentCoverage: `${context?.currentDays ?? 0} of 7 recent days`,
    baselineCoverage: `${context?.baselineDays ?? 0} of 28 usual-range days`,
  };
}

function MovementPanel({ context }: { context?: ActivityContextV1 }) {
  const pattern = movementPattern(context);
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-2 p-4">
        <h2 className={`m-0 ${PANEL_TITLE}`}>Movement pattern</h2>
        <p className="m-0 text-caption font-normal text-charcoal">{pattern.label}</p>
        <p className={`m-0 ${MUTED}`}>
          {pattern.currentCoverage} · {pattern.baselineCoverage}
        </p>
      </div>
    </section>
  );
}

function MetricCards({ series }: { series: MetricCardSpec[] }) {
  return (
    <>
      {series.map((card) => (
        <HealthMetricCard key={card.key} eyebrow={card.eyebrow} value={card.value}
          points={card.points} stroke={card.stroke} footnote={card.footnote} />
      ))}
    </>
  );
}

/** Before the estimate lands, or when its read failed with nothing cached, the panel says which,
 *  instead of drawing a heading over nothing (UI audit 2026-10-18). */
function EstimatePending({ status, onRetry }: { status: EstimateStatus; onRetry?: () => void }) {
  if (status === "error") {
    return <Notice tone="error" title="Couldn't load your burn estimate"
      action={onRetry ? { label: "Try again", onClick: onRetry } : undefined} />;
  }
  return <p role="status" className={`m-0 ${MUTED}`}>Loading your burn estimate…</p>;
}

function TdeePanel({ estimate, status, onRetry, profile, days }: {
    estimate: ExpenditureResponse | null; status: EstimateStatus; onRetry?: () => void;
    profile: ProfileState; days: DailyHealthRow[] }) {
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 p-4">
        <h2 className={`m-0 ${PANEL_TITLE}`}>What you burn</h2>
        {estimate === null ? <EstimatePending status={status} onRetry={onRetry} />
          : <TdeeLines estimate={estimate} profile={profile} days={days} />}
      </div>
    </section>
  );
}

function SourcesPanel({ sources, onOpenSources }: {
  sources: DailyHealthResponse["sources"]; onOpenSources: () => void;
}) {
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 p-4">
        <h2 className={`m-0 ${PANEL_TITLE}`}>Sources</h2>
        {sources.length === 0 && (
          <p className={`m-0 ${MUTED}`}>No source yet. Connect your phone in Settings.</p>
        )}
        {sources.map((source) => (
          <div key={source.id} className="flex items-center justify-between gap-3">
            <span className="text-caption font-normal text-graphite">
              {source.device_label ?? source.kind}
            </span>
            <span className={MUTED}>
              {source.revoked ? "revoked" : `last received ${lastSeen(source.last_received_at)}`}
            </span>
          </div>
        ))}
        <Button className="mt-2 self-start" onClick={onOpenSources}>Manage sources</Button>
      </div>
    </section>
  );
}

/**
 * The read-failure half of `/body`'s props (split audit, finding 2). A retry is asked for only when
 * the shared profile read actually failed, so a button that does nothing cannot be built: the
 * handler is required with the flag and forbidden without it. The old `?? (() => {})` fallback let
 * `profileFailed` stand alone, which rendered a "Try again" that went nowhere.
 */
export type ProfileFailureProps =
  | { profileFailed: true; onRetryProfile: () => void }
  | { profileFailed?: false; onRetryProfile?: never };

export type BodyDashboardProps = {
  /** The fetched 15-day window: `response.days` feeds the TDEE lines. */
  response: DailyHealthResponse; chart: DailyHealthRow[]; fetchedAt: string | null;
  offline: boolean; onOpenSources: () => void; estimate?: ExpenditureResponse | null;
  /** The estimate read's state; without it a missing estimate reads as still loading. */
  estimateStatus?: EstimateStatus; onRetryEstimate?: () => void;
  pendingProposal?: Fresh<ProposalSummary[]> | null;
  onProposalDecided?: (decision: "approve" | "reject") => void;
  /** The profile as the shared read left it; `unavailable` when that read failed (finding 5). */
  profile?: ProfileState;
} & ProfileFailureProps;

export default function BodyDashboard({ response, chart, fetchedAt, offline, onOpenSources,
  estimate = null, estimateStatus, onRetryEstimate, pendingProposal = null, onProposalDecided, profile = PROFILE_UNAVAILABLE,
  profileFailed, onRetryProfile }: BodyDashboardProps) {
  const weightUnit = loadStore().settings.weightUnit ?? "lb";
  const proposal = visibleProposal(pendingProposal);
  return (
    <div className="flex flex-col gap-4">
      {profileFailed && <ProfileReadAlert onRetry={onRetryProfile} pad />}
      {offline && fetchedAt && (
        <p className={`px-1 ${MUTED}`}>Offline — last synced {lastSeen(fetchedAt)}.</p>
      )}
      {bodyMetricSeries(chart, weightUnit).every((s) => daysWithData(s.points) === 0) ? (
        <EmptyState title="No health data yet"
          body="Connect a source, or log a weight, and the last seven days appear here."
          action={<Button onClick={onOpenSources}>Connect health sources</Button>} />
      ) : (
        <MetricCards series={bodyMetricSeries(chart, weightUnit)} />
      )}
      {/* Design §8.1/§8.2: the trend line belongs on `/body`, after the metric cards, and it is
          drawn from the stored series the body response now carries. The component keeps its own
          gate (the engine's phase, or 20 weigh-ins on an older row), so an account that has not
          earned the line never sees an empty one. */}
      {estimate && (
        <WeightTrend status={estimate.status} weighInCount={estimate.weighInCount} phase={estimate.phase}
          trendKg={estimate.weightTrendSeriesKg ?? []} unit={weightUnit} />
      )}
      {proposal && onProposalDecided && (
        <ProposalCard proposal={proposal} offline={pendingProposal?.stale ?? false}
          asOf={pendingProposal?.stale ? pendingProposal.asOf : undefined}
          onDecided={onProposalDecided} />
      )}
      {/* Mounted only once the estimate is here: before then "0 of 7 days" would read as a broken
          sync (UI audit 2026-10-18). */}
      {estimate && <MovementPanel context={estimate.activityContext} />}
      <TdeePanel estimate={estimate} profile={profile} days={response.days}
        status={estimateStatus ?? (estimate ? "ready" : "loading")} onRetry={onRetryEstimate} />
      <SourcesPanel sources={response.sources} onOpenSources={onOpenSources} />
    </div>
  );
}
