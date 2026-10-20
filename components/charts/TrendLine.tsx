"use client";

import { motion, useReducedMotion } from "motion/react";
import { columns, linePaths, paddedRange, plotBox, round, yOf } from "@/lib/charts/geometry";
import { fade } from "@/lib/design/motion";
import type { TrendMetric } from "@/lib/trends/series";
import { CHART_HEIGHT, CHART_WIDTH, ChartFrame, type TrendColumn } from "@/components/charts/TrendBars";
import styles from "@/components/charts/Charts.module.css";

/**
 * Points joined by a line (weight). The scale hugs the values, since 0 is nowhere near them; a gap
 * longer than `maxGap` columns is never bridged, and a lone point stays a point.
 */
export default function TrendLine({ cols, metric, selected, onSelect, summary, caption, valueHeading, maxGap }: {
  cols: TrendColumn[];
  metric: TrendMetric;
  selected: number | null;
  onSelect: (index: number) => void;
  summary: string;
  caption: string;
  valueHeading: string;
  maxGap: number;
}) {
  const reduce = useReducedMotion() === true;
  const box = plotBox(CHART_WIDTH, CHART_HEIGHT, { top: 16, bottom: 32 });
  const values = cols.map((col) => col.value);
  const [min, max] = paddedRange(values) ?? [0, 1];
  const slots = columns(cols.length, box);
  const paths = linePaths(values, box, min, max, maxGap);
  return <ChartFrame cols={cols} metric={metric} selected={selected} onSelect={onSelect} summary={summary}
    caption={caption} valueHeading={valueHeading}>
    <text className={styles.axisLabel} x={box.left} y={box.top - 4}>{max}</text>
    <text className={styles.axisLabel} x={box.left} y={box.bottom - 4}>{min}</text>
    {paths.map((d, i) => <motion.path key={`${metric}-${i}`} className={styles.line} d={d} data-line={i}
      initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={fade("base", reduce)} />)}
    {cols.map((col, i) => col.value === null ? null : <circle key={i} data-point={i}
      className={`${styles.dot} ${selected !== null && selected !== i ? styles.dimmed : ""}`}
      cx={round(slots[i].cx)} cy={round(yOf(col.value, min, max, box))} r={selected === i ? 5 : 4} />)}
  </ChartFrame>;
}
