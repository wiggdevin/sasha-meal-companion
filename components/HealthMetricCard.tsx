"use client";

import Sparkline from "@/components/Sparkline";
import CardFrame from "@/components/ui/CardFrame";

/**
 * One observation card, compact (UI makeover §2.2): the metric's name, its latest figure, the
 * seven-day line and one footnote. Two sit side by side on `/body`.
 */
export default function HealthMetricCard({ eyebrow, value, points, stroke, footnote }: {
  eyebrow: string; value: string; points: (number | null)[]; stroke: string; footnote: string;
}) {
  return (
    <CardFrame as="section" size="sm" title={eyebrow}>
      <span className="tabular-nums text-heading font-light tracking-display-md text-charcoal">
        {value}
      </span>
      <Sparkline points={points} stroke={stroke} label={`${eyebrow}, last seven days`} />
      <span className="text-tiny font-normal text-muted">{footnote}</span>
    </CardFrame>
  );
}
