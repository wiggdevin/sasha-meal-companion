"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { barPath, bars, columns, niceCeil, plotBox, round, yOf } from "@/lib/charts/geometry";
import { SPRINGS } from "@/lib/design/motion";
import type { TrendMetric } from "@/lib/trends/series";
import styles from "@/components/charts/Charts.module.css";

/** One column of a trend chart: a day, or a week's mean. */
export type TrendColumn = {
  /** The short axis label ("T", "Oct 6"). */
  label: string;
  /** The column's accessible name and readout ("Tue · 1,840 of 2,000 kcal"). */
  describe: string;
  value: number | null;
  target: number | null;
  partial: boolean;
  training?: boolean;
};

export const CHART_WIDTH = 320;
export const CHART_HEIGHT = 160;
/** Room under the plot for the training dot and the axis label. */
const FOOT = 28;

export const METRIC_CLASS: Record<TrendMetric, string> = {
  kcal: styles.kcal, protein: styles.protein, water: styles.water,
  sleep: styles.sleep, activity: styles.activity, weight: styles.weight,
};

/**
 * The frame every trend chart shares: the SVG is one image with a summary name, the columns are
 * real buttons over it (each at least 44 px), and a visually hidden table carries every value.
 */
export function ChartFrame({ cols, metric, selected, onSelect, summary, caption, valueHeading, children }: {
  cols: TrendColumn[];
  metric: TrendMetric;
  selected: number | null;
  onSelect: (index: number) => void;
  summary: string;
  caption: string;
  valueHeading: string;
  children: ReactNode;
}) {
  const box = plotBox(CHART_WIDTH, CHART_HEIGHT, { top: 8, bottom: FOOT });
  const slots = columns(cols.length, box);
  return <div className={`relative ${METRIC_CLASS[metric]}`}>
    <svg className={styles.chart} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={summary}>
      <line className={styles.baseline} x1={box.left} x2={box.right} y1={box.bottom} y2={box.bottom} />
      {children}
      {cols.map((col, i) => <g key={i}>
        {col.training && <circle className={styles.training} cx={round(slots[i].cx)} cy={box.bottom + 6} r={2.5} />}
        <text className={styles.axisLabel} x={round(slots[i].cx)} y={CHART_HEIGHT - 4} textAnchor="middle">{col.label}</text>
      </g>)}
    </svg>
    <div className={styles.hits}>
      {cols.map((col, i) => <button key={i} type="button" className={`${styles.hit} tap`}
        aria-label={col.describe} aria-pressed={selected === i} onClick={() => onSelect(i)} />)}
    </div>
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">Day</th><th scope="col">{valueHeading}</th></tr></thead>
      <tbody>{cols.map((col, i) => <tr key={i}><th scope="row">{col.label}</th><td>{col.describe}</td></tr>)}</tbody>
    </table>
  </div>;
}

/** Daily or weekly bars, with each column's own target as a dashed rule across it. */
export default function TrendBars({ cols, metric, selected, onSelect, summary, caption, valueHeading }: {
  cols: TrendColumn[];
  metric: TrendMetric;
  selected: number | null;
  onSelect: (index: number) => void;
  summary: string;
  caption: string;
  valueHeading: string;
}) {
  const reduce = useReducedMotion() === true;
  const box = plotBox(CHART_WIDTH, CHART_HEIGHT, { top: 8, bottom: FOOT });
  const max = niceCeil(cols.flatMap((col) => [col.value, col.target])) ?? 1;
  const slots = columns(cols.length, box);
  const drawn = bars(cols.map((col) => col.value), box, max, { fill: 0.56, maxWidth: 28 });
  return <ChartFrame cols={cols} metric={metric} selected={selected} onSelect={onSelect} summary={summary}
    caption={caption} valueHeading={valueHeading}>
    {drawn.map((bar) => {
      const col = cols[bar.index];
      const dim = selected !== null && selected !== bar.index;
      return <motion.path key={`${bar.index}-${metric}`} data-bar={bar.index} data-partial={col.partial || undefined}
        className={`${styles.bar} ${col.partial ? styles.partial : ""} ${dim ? styles.dimmed : ""}`}
        d={barPath(bar)} initial={reduce ? false : { scaleY: 0 }} animate={{ scaleY: 1 }}
        transition={reduce ? { duration: 0 } : SPRINGS.smooth} />;
    })}
    {cols.map((col, i) => col.target === null ? null : <line key={`t${i}`} className={styles.target} data-target={i}
      x1={round(slots[i].x + 2)} x2={round(slots[i].x + slots[i].width - 2)}
      y1={round(yOf(col.target, 0, max, box))} y2={round(yOf(col.target, 0, max, box))} />)}
  </ChartFrame>;
}
