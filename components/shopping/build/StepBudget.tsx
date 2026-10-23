"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Field from "@/components/ui/Field";
import styles from "./build.module.css";

export const CURRENCIES = ["USD", "CAD", "GBP", "EUR", "AUD"] as const;

/** USD only when the account's own stored country is the U.S.; any other country picks its own. */
export function defaultCurrency(countryCode: string | null | undefined): string | null {
  return countryCode === "US" ? "USD" : null;
}

/**
 * Step 1, Budget (UI makeover §7.3): an optional amount and its currency. Prices are not known, so
 * the flow never shows a total against it; the amount only rides on the plan's draft.
 */
export default function StepBudget({ amount, currency, countryCode, onNext, onSkip }: {
  amount: number | null;
  currency: string | null;
  countryCode: string | null;
  onNext: (amount: number | null, currency: string | null) => void;
  onSkip: () => void;
}) {
  const [text, setText] = useState(amount === null ? "" : String(amount));
  const [chosen, setChosen] = useState<string | null>(currency ?? defaultCurrency(countryCode));
  const [error, setError] = useState<string | null>(null);

  function next() {
    const trimmed = text.trim();
    if (!trimmed) { onNext(null, null); return; }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000) { setError("Enter an amount, like 120."); return; }
    if (!chosen) { setError("Pick a currency."); return; }
    onNext(Math.round(value * 100) / 100, chosen);
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-body font-semibold text-charcoal">Budget for this list?</h3>
      <Field id="build-budget" label="Amount" inputMode="decimal" placeholder="Optional"
        className={styles.amount} value={text} error={error}
        onChange={(event) => { setText(event.target.value); setError(null); }} />
      <div className="pill-in flex flex-wrap gap-1" role="group" aria-label="Currency">
        {CURRENCIES.map((code) => (
          <Chip key={code} selected={chosen === code} onClick={() => { setChosen(code); setError(null); }}>{code}</Chip>
        ))}
      </div>
      <p className="m-0 text-caption text-muted">Prices aren&apos;t available yet.</p>
      <div className="flex gap-2">
        <Button variant="tertiary" onClick={onSkip}>Skip</Button>
        <Button variant="primary" onClick={next}>Next</Button>
      </div>
    </div>
  );
}
