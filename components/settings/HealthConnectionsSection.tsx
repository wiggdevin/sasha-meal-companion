import type { DailyHealthResponse } from "@/lib/health/contract";
import Link from "next/link";
import { appleHealthConnectionState, type DailyFetch } from "@/lib/health-client";
import SettingsSection from "./Section";
import { CAPTION, ROW_TITLE } from "./settings-styles";

export type HealthConnection = "oura";

function matchesConnection(kind: string, connection: HealthConnection): boolean {
  return kind === connection;
}

function relativeTime(iso: string, now: Date): string {
  const elapsedMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;
  const hours = Math.round(elapsedMinutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

export function healthConnectionStatus(
  connection: HealthConnection,
  sources: DailyHealthResponse["sources"],
  disabled: boolean,
  now = new Date(),
): string {
  if (disabled) return "Not available yet";
  const active = sources.filter(
    (source) => !source.revoked && matchesConnection(source.kind, connection),
  );
  if (active.length === 0) return "Not linked";
  const lastReceived = active
    .map((source) => source.last_received_at)
    .filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  return lastReceived
    ? `Linked · last sync ${relativeTime(lastReceived, now)}`
    : "Linked · waiting for first sync";
}

function unsettledStatus(daily: DailyFetch | null): string | null {
  if (daily === null) return "Checking…";
  if (!daily.disabled && daily.response === null) return "Couldn’t check · try again online";
  return null;
}

function ConnectionRow({
  label,
  status,
  disabled,
  onOpen,
  action,
  detail,
}: {
  label: string;
  status: string;
  disabled: boolean;
  onOpen: () => void;
  action?: string;
  detail?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className="tap flex min-h-14 w-full items-center justify-between gap-4 px-5 py-2 text-left disabled:opacity-60"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={ROW_TITLE}>{label}</span>
        <span className={CAPTION}>{status}</span>
        {detail && <span className={CAPTION}>{detail}</span>}
      </span>
      {action ? (
        <span className="shrink-0 text-caption text-graphite">{action}</span>
      ) : (
        <span aria-hidden="true" className="text-caption text-graphite">→</span>
      )}
    </button>
  );
}

export default function HealthConnectionsSection({
  daily,
  onManage,
}: {
  daily: DailyFetch | null;
  onManage: () => void;
}) {
  const sources = daily?.response?.sources ?? [];
  const unavailable = daily?.disabled === true;
  const unsettled = unsettledStatus(daily);
  const cannotManage = unavailable || daily === null || daily.response === null || daily.offline;
  const apple = appleHealthConnectionState(sources, unavailable);
  return (
    <SettingsSection title="Health connections">
      <div className="shell">
        <div className="surface flex flex-col">
          <ConnectionRow
            label="Apple Health"
            status={unsettled ?? apple.status}
            detail={unsettled ? null : apple.detail}
            action={unsettled ? undefined : apple.action}
            disabled={cannotManage}
            onOpen={onManage}
          />
          <div className="mx-5 border-t border-hairline" />
          <ConnectionRow
            label="Oura"
            status={unsettled ?? healthConnectionStatus("oura", sources, unavailable)}
            disabled={cannotManage}
            onOpen={onManage}
          />
          <div className="mx-5 border-t border-hairline" />
          <Link href="/body" className={`tap flex min-h-14 items-center px-5 ${ROW_TITLE}`}>
            Body dashboard →
          </Link>
        </div>
      </div>
    </SettingsSection>
  );
}
