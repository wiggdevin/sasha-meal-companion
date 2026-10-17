"use client";

import { useState } from "react";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";
import { downloadExport, type ExportKind } from "@/lib/export-client";
import Button from "@/components/ui/Button";
import DateField from "@/components/ui/DateField";
import Notice from "@/components/ui/Notice";
import { useButtonStatus } from "@/components/ui/useButtonStatus";

/** One labeled date field — split out of `ExportCard` so that function stays under 50 lines. */
function DateWell({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-eyebrow-sm uppercase tracking-[0.2em] text-muted">{label}</span>
      <DateField
        label={label}
        value={value}
        onChange={(next) => onChange(next ?? "")}
        allowClear
        placeholder="Any day"
        className="h-12 px-3 text-caption text-charcoal"
      />
    </label>
  );
}

/**
 * CSV export — architecture §4.6, phase-2-real-logging.md. `kind=meals` is one row per logged item
 * with grams, source and source version; `kind=progress` is one row per day with totals, the kcal
 * target and micro coverage. The dates are optional and inclusive; empty means the whole log.
 * Phase 9 slice 1: the download is a fetch for the account this card was rendered for (a plain
 * link sent no account header, so a stale tab could save another account's log).
 *
 * It is the first row of the one Data & account card (U17, 2026-10-04), so it draws no card of its
 * own. Each download confirms in its own button ("Downloaded").
 */
export default function ExportCard() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [account] = useState(currentAccountOrNull);
  const [failed, setFailed] = useState(false);
  const meals = useButtonStatus();
  const progress = useButtonStatus();
  const download = (kind: ExportKind): void => {
    if (account === null || !isCurrent(account)) { setFailed(true); return; }
    setFailed(false);
    void (kind === "meals" ? meals : progress).run(() => downloadExport(account, kind, from, to))
      .then((outcome) => { if (!outcome.ok) setFailed(true); });
  };

  return (
    <section aria-label="Export" className="flex flex-col gap-3 p-4">
      <h3 className="m-0 text-heading-sm text-charcoal">Export</h3>
      <p className="m-0 text-caption font-normal text-graphite">
        Your logged meals and your daily totals, as spreadsheets. Leave the dates empty for the whole log.
      </p>

      <div className="flex gap-2">
        <DateWell label="From" value={from} onChange={setFrom} />
        <DateWell label="To" value={to} onChange={setTo} />
      </div>

      <div className="flex flex-col gap-2">
        <Button variant="secondary" block status={meals.status} confirmLabel="Downloaded"
          onClick={() => download("meals")}>
          Download meals CSV
        </Button>
        <Button variant="tertiary" block status={progress.status} confirmLabel="Downloaded"
          onClick={() => download("progress")}>
          Download daily progress CSV
        </Button>
      </div>
      {failed ? <Notice tone="error" title="Could not download. Try again." /> : null}
    </section>
  );
}
