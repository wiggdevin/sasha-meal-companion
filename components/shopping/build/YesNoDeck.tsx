"use client";

import type { ReactNode } from "react";
import Button from "@/components/ui/Button";
import CardFrame from "@/components/ui/CardFrame";
import styles from "./build.module.css";

/**
 * One card at a time, answered Yes or No (UI makeover §7.3): the card, a "3 of 18" counter, two
 * 52 px answers side by side, and "Yes to the rest". When every card is answered the deck shows
 * its `done` content instead. Back is the flow's own button, so it is not repeated here.
 */
export default function YesNoDeck({ label, name, counter, title, meta, detail, onYes, onNo, onYesToRest, done,
  finished, yesLabel = "Yes", noLabel = "No" }: {
  /** What the deck asks ("Foods for your list"). */
  label: string;
  /** The card's subject, for the answers' names ("Yes to Eggs"). */
  name: string;
  counter: string;
  title: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  onYes: () => void;
  onNo: () => void;
  onYesToRest?: () => void;
  finished: boolean;
  done: ReactNode;
  yesLabel?: string;
  noLabel?: string;
}) {
  if (finished) return <>{done}</>;
  return (
    <div className="flex flex-col gap-3" role="group" aria-label={label}>
      <p className="m-0 text-caption text-muted" aria-live="polite">{counter}</p>
      <CardFrame size="sm" title={title} titleAs="h3" meta={meta} className={styles.deckCard}>
        {detail}
      </CardFrame>
      <div className={styles.answers}>
        <Button variant="secondary" size="lg" onClick={onNo} aria-label={`${noLabel} to ${name}`}>{noLabel}</Button>
        <Button variant="primary" size="lg" onClick={onYes} aria-label={`${yesLabel} to ${name}`}>{yesLabel}</Button>
      </div>
      {onYesToRest && (
        <Button variant="ghost" className="self-start" onClick={onYesToRest}>Yes to the rest</Button>
      )}
    </div>
  );
}
