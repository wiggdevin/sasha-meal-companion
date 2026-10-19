import { barPath, bars, niceCeil, plotBox } from "@/lib/charts/geometry";
import type { TrendMetric } from "@/lib/trends/series";
import { METRIC_CLASS } from "@/components/charts/TrendBars";
import styles from "@/components/charts/Charts.module.css";

const WIDTH = 72;
const HEIGHT = 24;

/**
 * A tiny seven-bar sparkline for the collapsed "Your week" row. Decorative: the row's button names
 * the figure, so the drawing is hidden from assistive tech. A missing day draws nothing; a partial
 * day is drawn outline-only.
 */
export default function MiniTrend({ metric, values, partial }: {
  metric: TrendMetric;
  values: (number | null)[];
  partial?: boolean[];
}) {
  const box = plotBox(WIDTH, HEIGHT, { top: 2 });
  const max = niceCeil(values) ?? 1;
  return <svg className={`${styles.mini} ${METRIC_CLASS[metric]}`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <line className={styles.baseline} x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
    {bars(values, box, max, { fill: 0.6 }).map((bar) => <path key={bar.index} data-mini-bar={bar.index}
      className={`${styles.bar} ${partial?.[bar.index] ? styles.partial : ""}`} d={barPath(bar, 2)} />)}
  </svg>;
}
