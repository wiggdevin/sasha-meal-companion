"use client";

import { accountHandle } from "@/lib/device/account";
import Disclosure from "@/components/ui/Disclosure";
import { useEffect, useId, useRef, useState } from "react";
import Sheet from "@/components/Sheet";
import { connectOura, disconnectOura, issueToken, revokeToken } from "@/lib/health-client";
import type { DailyHealthResponse } from "@/lib/health/contract";
import { APP_NAME } from "@/lib/brand";
import Notice from "@/components/ui/Notice";
import Button, { buttonClasses } from "@/components/ui/Button";
import { lastSeen } from "@/lib/health/last-seen";
import { useOnline } from "@/lib/use-online";

type CopyStatus = "idle" | "copied" | "error";
type AppleSourceKind = "apple_health_shortcut" | "health_auto_export";
type IssuedCode = { kind: AppleSourceKind; token: string };

const SHORTCUT_SAMPLE_JSON = JSON.stringify({
  source_kind: "apple_health_shortcut",
  sent_at: "2026-09-20T08:15:00-06:00",
  tz: "America/Denver",
  samples: [
    { type: "step_count", value: 6241, unit: "count",
      start_time: "2026-09-19T00:00:00-06:00", end_time: "2026-09-20T00:00:00-06:00",
      vendor_sample_id: "shortcut:step_count:2026-09-19",
      vendor_updated_at: "2026-09-20T08:15:00-06:00", device_label: "Apple Watch" },
    { type: "active_energy", value: 386, unit: "kcal",
      start_time: "2026-09-19T00:00:00-06:00", end_time: "2026-09-20T00:00:00-06:00",
      vendor_sample_id: "shortcut:active_energy:2026-09-19",
      vendor_updated_at: "2026-09-20T08:15:00-06:00", device_label: "Apple Watch" },
    { type: "body_mass", value: 57.7, unit: "kg",
      start_time: "2026-09-19T07:12:00-06:00", end_time: "2026-09-19T07:12:00-06:00",
      vendor_sample_id: "shortcut:body_mass:2026-09-19",
      vendor_updated_at: "2026-09-20T08:15:00-06:00", device_label: "Apple Health" },
  ],
}, null, 2);

/** Awaits the clipboard write instead of firing it and forgetting it, so a denied or
 *  rejected write is reported back rather than looking identical to a success. */
export async function copyIssuedToken(token: string): Promise<CopyStatus> {
  try {
    await navigator.clipboard.writeText(token);
    return "copied";
  } catch {
    return "error";
  }
}

/** Presentational split (mirrors WaterCard/WaterCardView) so each status label is
 *  checkable without a DOM. The button confirms in itself ("Copied", DESIGN.md §Buttons); a failed
 *  copy says what to do on its own line, because a one-time code must not be lost to a short label. */
export function CopyTokenButton({ status, onCopy }: {
  status: CopyStatus; onCopy: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      <Button size="sm" status={status === "copied" ? "success" : status === "error" ? "error" : "idle"}
        confirmLabel="Copied" errorLabel="Try again" onClick={onCopy}>
        Copy
      </Button>
      {status === "error" && <p role="alert" className="m-0 text-tiny text-alert">
        Couldn&apos;t copy — select and copy manually.
      </p>}
    </div>
  );
}

export function healthSourceLabel(source: DailyHealthResponse["sources"][number]): string {
  const label = source.kind === "apple_health_shortcut" ? "Apple Health Shortcut"
    : source.kind === "health_auto_export" ? "Health Auto Export"
    : source.device_label ?? source.kind;
  return `${label}${source.revoked ? " · revoked" : ""}`;
}

/** The issued code, shown in the section whose button made it: scrolled into view and focused
 *  when it appears, and announced, so a tap never looks like it did nothing (UI audit 2026-10-18). */
function IssuedCodeBlock({ token }: { token: string }) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    node.focus({ preventScroll: true });
  }, [token]);
  return (
    <div ref={ref} tabIndex={-1} role="group" aria-labelledby={headingId}
      className="flex flex-col gap-2 border-t border-hairline pt-3 outline-none">
      <span id={headingId} role="status" className="text-tiny font-medium uppercase tracking-widest text-muted">
        Copy this connection code now — it is shown once
      </span>
      <code className="break-all text-tiny text-charcoal">{token}</code>
      <CopyTokenButton status={copyStatus}
        onCopy={() => { void copyIssuedToken(token).then(setCopyStatus); }} />
    </div>
  );
}

function IssueCodeButton({ kind, busy, online, issued, onIssue }: {
  kind: AppleSourceKind;
  busy: boolean;
  online: boolean;
  issued: IssuedCode | null;
  onIssue: (kind: AppleSourceKind) => void;
}) {
  const mine = issued?.kind === kind ? issued.token : null;
  // Once a code is out, a second tap would make a second source and hide the first code.
  return (
    <>
      <Button disabled={busy || !online || mine !== null} onClick={() => onIssue(kind)}>
        {mine !== null ? "Code created, copy it below" : "Create connection code"}
      </Button>
      {mine !== null && <IssuedCodeBlock key={mine} token={mine} />}
    </>
  );
}

/** A destructive action that asks twice: the first tap arms it for a few seconds and says what the
 *  second tap does, so a stray tap while scrolling cannot break the sync (UI audit 2026-10-18). */
export function ConfirmButton({ label, confirmLabel, disabled, className = "", ariaLabel, onConfirm }: {
  label: string; confirmLabel: string; disabled: boolean; className?: string;
  /** Names what the button acts on when several rows share a label. */
  ariaLabel?: (armed: boolean) => string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  // Busy elsewhere disarms it, so one tap after that action ends cannot confirm.
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (wasDisabled !== disabled) {
    setWasDisabled(disabled);
    if (disabled && armed) setArmed(false);
  }
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button variant="danger" size="sm" className={`shrink-0 whitespace-nowrap ${className}`.trim()}
      disabled={disabled} aria-label={ariaLabel?.(armed)}
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        onConfirm();
      }}>
      {armed ? confirmLabel : label}
    </Button>
  );
}

export function HealthSourceRecipes({ shortcutUrl, busy, online, issued = null, onIssue }: {
  shortcutUrl: string | null;
  busy: boolean;
  online: boolean;
  issued?: IssuedCode | null;
  onIssue: (kind: AppleSourceKind) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <section className="well flex flex-col gap-3 p-4">
        <h3 className="m-0 text-caption font-medium">
          Free (Shortcut) · needs your phone unlocked at the sync time
        </h3>
        <IssueCodeButton kind="apple_health_shortcut" busy={busy} online={online}
          issued={issued} onIssue={onIssue} />
        {shortcutUrl ? (
          // A link keeps link semantics, so it wears the secondary recipe through buttonClasses.
          <a href={shortcutUrl} target="_blank" rel="noreferrer"
            className={buttonClasses({ className: "self-start" })}>
            Add Shortcut
          </a>
        ) : (
          <>
            <p className="m-0 text-caption">The ready-made Shortcut is not published yet</p>
            <Disclosure variant="row" title="Set up the Shortcut manually">
              <ol className="m-0 flex flex-col gap-3 pl-5 text-caption leading-5">
                <li>Create a shortcut named <strong>Send Health to {APP_NAME}</strong>. Add
                  <strong> Text</strong>, paste the one-time connection code, then add
                  <strong> Set Variable</strong> named <strong>Connection Code</strong>.</li>
                <li>Add <strong>Date</strong> at <strong>Current Date</strong> and name it
                  <strong> Now</strong>. Add <strong>Format Date</strong> twice: custom
                  <code> yyyy-MM-dd&apos;T&apos;HH:mm:ssXXX</code> as <strong>Sent At</strong>, then
                  custom <code>VV</code> as <strong>Time Zone</strong>.</li>
                <li>Add <strong>Adjust Date</strong> with <strong>Get Start of Day</strong> from
                  Now as <strong>End</strong>. Add another <strong>Adjust Date</strong> subtracting
                  one day as <strong>Start</strong>. Format Start as <code>yyyy-MM-dd</code> and
                  name it <strong>Local Day</strong>.</li>
                <li>For Steps, add <strong>Find Health Samples</strong> between Start and End from
                  Apple Watch when available, otherwise iPhone. Add
                  <strong> Get Details of Health Sample</strong> → Value,
                  <strong> Get Numbers from Input</strong>, and
                  <strong> Calculate Statistics</strong> → Sum. Wrap it in <strong>If</strong> so
                  an empty result adds nothing.</li>
                <li>Repeat step 4 for <strong>Active Energy</strong>. If there is no Watch reading,
                  omit it; never insert zero.</li>
                <li>For weight, add <strong>Find Health Samples</strong> with Type
                  <strong> Body Mass</strong>, the same window, Latest First, Limit 1. Get its Value
                  and wrap it in <strong>If</strong>; use the latest value, not a sum.</li>
                <li>For each present metric, add a <strong>Dictionary</strong>, then
                  <strong> Add to Variable</strong> named <strong>Samples</strong>. Use
                  <code> shortcut:&lt;type&gt;:&lt;Local Day&gt;</code> for
                  <code> vendor_sample_id</code> and Sent At for <code>vendor_updated_at</code>.</li>
                <li>Add a top-level <strong>Dictionary</strong>, then <strong>URL</strong> ending in
                  <code> /api/health/ingest</code>, then <strong>Get Contents of URL</strong>: POST,
                  JSON, Authorization <code>Bearer &lt;Connection Code&gt;</code>, Content-Type
                  <code> application/json</code>. Add <strong>Show Result</strong> for the first run.</li>
                <li>Run once, allow Health access, and confirm <code>status: applied</code>. In
                  Automation choose <strong>Time of Day</strong>, <strong>Run Shortcut</strong>,
                  this shortcut, then <strong>Run Immediately</strong>.</li>
              </ol>
            </Disclosure>
          </>
        )}
        <Disclosure variant="row" title="Sample Shortcut JSON">
          <pre className="m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words text-tiny">
            {SHORTCUT_SAMPLE_JSON}
          </pre>
        </Disclosure>
        <p className="m-0 text-caption">
          Apple may delay this while your phone is locked. Open Shortcuts and run it once if sync gets old.
        </p>
      </section>

      <section className="well flex flex-col gap-3 p-4">
        <h3 className="m-0 text-caption font-medium">
          Most reliable (Health Auto Export, paid app)
        </h3>
        <p className="m-0 text-caption">
          Premium is $1.99/month, $6.99/year, or $24.99 lifetime.
        </p>
        <IssueCodeButton kind="health_auto_export" busy={busy} online={online}
          issued={issued} onIssue={onIssue} />
        <ol className="m-0 flex flex-col gap-2 pl-5 text-caption leading-5">
          <li>Install Health Auto Export and Premium. Grant Steps, Active Energy,
            Weight &amp; Body Mass, and Sleep Analysis.</li>
          <li>Automations → Add Automation → REST API. Use <code>/api/health/ingest</code>, POST,
            JSON, and Authorization <code>Bearer &lt;Connection Code&gt;</code>.</li>
          <li>Choose Health Metrics and only those four metrics. Turn Summarize Data on, choose Day,
            Previous 7 Days, and turn Batch Requests off.</li>
          <li>Schedule it while your phone is normally unlocked or charging. Run Manual Export once
            and confirm <code>status: applied</code>.</li>
        </ol>
      </section>
    </div>
  );
}

/**
 * Issue, copy once, revoke, connect, disconnect (spec §6). Every action needs a round trip that
 * cannot be replayed safely, so offline they are disabled with a plain reason rather than queued.
 */
export default function HealthSourcesSheet({ sources, onClose, onChanged, appleOnly = false }: {
  sources: DailyHealthResponse["sources"]; onClose: () => void; onChanged: () => void;
  appleOnly?: boolean;
}) {
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();
  const oura = sources.find((s) => s.kind === "oura" && !s.revoked);
  const shortcutUrl = process.env.NEXT_PUBLIC_APPLE_HEALTH_SHORTCUT_URL?.trim() || null;

  // `busy` disables the buttons only after a repaint; a second tap before then must not send twice
  // (two connection codes, one never shown).
  const running = useRef(false);
  async function run(action: () => Promise<void>, notify = true): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (notify) onChanged();
    } catch {
      setError("That did not go through. Try again when you have a connection.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <Sheet title={appleOnly ? "Apple Health setup" : "Health connections"}
      subtitle={appleOnly ? "Send Apple Health data from your iPhone." : "Connect Apple Health or Oura."}
      onClose={onClose}>
      <div className="flex flex-col gap-4">
        {!online && <Notice tone="attention" title="These need a connection." />}

        <HealthSourceRecipes shortcutUrl={shortcutUrl} busy={busy} online={online} issued={issued}
          onIssue={(kind) => { void run(async () => {
            const { token } = await issueToken({ kind,
              device_label: kind === "apple_health_shortcut" ? "Apple Health Shortcut"
                : "Health Auto Export",
              time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
            setIssued({ kind, token });
          }); }} />

        {sources.filter((s) => s.kind !== "oura").map((source) => (
          <div key={source.id} className="flex items-center justify-between gap-3">
            {/* When it last sent is what tells two same-named sources apart (UI audit 2026-10-18). */}
            <span className="flex min-w-0 flex-col">
              <span className="text-caption font-normal text-graphite">{healthSourceLabel(source)}</span>
              {!source.revoked && <span className="text-tiny text-muted">
                last received {lastSeen(source.last_received_at)}</span>}
            </span>
            {!source.revoked && (
              <ConfirmButton label="Revoke" confirmLabel="Tap again to revoke"
                ariaLabel={(armed) => `${armed ? "Tap again to revoke" : "Revoke"} ${healthSourceLabel(source)}`}
                disabled={busy || !online} onConfirm={() => { void run(() => revokeToken(source.id)); }} />
            )}
          </div>
        ))}

        {!appleOnly && (oura ? (
          <ConfirmButton label="Disconnect Oura" confirmLabel="Tap again to disconnect"
            className="self-start" disabled={busy || !online}
            onConfirm={() => { void run(() => disconnectOura()); }} />
        ) : (
          // The start request goes through `run`, so it shows busy and a failure says so; success
          // leaves the page for Oura, so there is nothing to refresh.
          <Button disabled={busy || !online} status={busy ? "pending" : "idle"}
            onClick={() => { void run(() => connectOura(accountHandle()), false); }}>
            Connect Oura
          </Button>
        ))}

        {error && <Notice tone="error" title={error} />}
      </div>
    </Sheet>
  );
}
