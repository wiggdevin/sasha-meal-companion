"use client";

import Sparkline from "@/components/Sparkline";

/**
 * One observation card. Values are read off the mockups: the metric at 22 px/300/-0.025em
 * (ArenaRings.dc.html), the eyebrow at 11 px/500/0.1em uppercase #6d705f, the footnote at
 * 12 px/300 #6d705f (Main.dc.html).
 */
export default function HealthMetricCard({ eyebrow, value, points, stroke, footnote }: {
  eyebrow: string; value: string; points: (number | null)[]; stroke: string; footnote: string;
}) {
  return (
    <section className="shell">
      <div className="surface flex flex-col gap-3 p-4">
        <span className="text-tiny font-semibold uppercase tracking-widest text-muted">
          {eyebrow}
        </span>
        <span className="tabular-nums text-heading font-light tracking-display-md text-charcoal">
          {value}
        </span>
        <Sparkline points={points} stroke={stroke} label={`${eyebrow}, last seven days`} />
        <span className="text-tiny font-normal text-muted">{footnote}</span>
      </div>
    </section>
  );
}
