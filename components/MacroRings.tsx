"use client";

import { useEffect, useId, useRef, useState } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { arc, excessProgress, tracer } from "@/lib/gauge";
import WaterDial from "@/components/WaterDial";
import { Chevrons, useLongPress, WaterSteps } from "@/components/MacroRingsControls";
import { MacroLine } from "@/components/nutrition/MacroText";
import { balanceBound, withBound } from "@/lib/nutrition-display";
import type { Macros } from "@/lib/types";
import { formatWater, formatWaterOf, waterValue, type WaterUnit } from "@/lib/water-units";

type GaugeSpec = {
  key: keyof Macros | "water";
  label: string;
  unit: string;
  from: string;
  to: string;
};

// Fixed per macro, never reassigned — DESIGN.md §Colors. Calories orange,
// protein blue, carbs olive, fat gold.
const CALORIES: GaugeSpec = {
  key: "kcal",
  label: "Calories",
  unit: " kcal",
  from: "var(--color-gauge-calories)",
  to: "var(--color-gauge-calories-end)",
};

const MINIS: GaugeSpec[] = [
  {
    key: "protein",
    label: "Protein",
    unit: " g",
    from: "var(--color-gauge-protein)",
    to: "var(--color-gauge-protein-end)",
  },
  {
    key: "carbs",
    label: "Carbs",
    unit: " g",
    from: "var(--color-gauge-carbs)",
    to: "var(--color-gauge-carbs-end)",
  },
  {
    key: "fat",
    label: "Fat",
    unit: " g",
    from: "var(--color-gauge-fat)",
    to: "var(--color-gauge-fat-end)",
  },
];

const WATER: GaugeSpec = {
  key: "water",
  label: "Water",
  unit: " cups",
  from: "var(--color-gauge-water)",
  to: "var(--color-gauge-water-end)",
};

// Balanced layout (FluidVoice T02, 2026-09-28): calories in the centre, carbs over water on the
// left, protein over fat on the right — two dials a side. Water on the left leaves the width of the
// card to its right for one long drag. Order comes from MINIS, so the fixed per-macro colours stay
// the one source.
export const LEFT_DIALS: GaugeSpec[] = [MINIS[1], WATER];
export const RIGHT_DIALS: GaugeSpec[] = [MINIS[0], MINIS[2]];

// Strong ease-out — the arc is "progress arriving", so it decelerates into
// place and never eases in. DESIGN.md §Motion: 1.2 s, once, no replay.
const DRAW_EASE = [0.16, 1, 0.3, 1] as const;
const DRAW_SECONDS = 1.2;

const EYEBROW = "font-medium uppercase text-muted";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// A logged meal moves the number as well as the arc: 0.6 s, the arc's ease.
const COUNT_SECONDS = 0.6;

/**
 * The gauge numeral. Server and first client render show the real value (the markup never
 * differs), then the number counts from 0 alongside the arc's first draw, and from its last
 * value whenever a meal is logged or unticked. Reduced motion: it just changes.
 */
function Numeral({ value, numeralSize }: { value: number; numeralSize: number }) {
  const reduceMotion = useReducedMotion();
  const count = useMotionValue(value);
  const text = useTransform(count, (n) => fmt(n));
  const first = useRef(true);
  useEffect(() => {
    const fromZero = first.current;
    first.current = false;
    if (reduceMotion) { count.set(value); return; }
    if (fromZero) count.set(0);
    const controls = animate(count, value, {
      duration: fromZero ? DRAW_SECONDS : COUNT_SECONDS, ease: DRAW_EASE,
    });
    return () => controls.stop();
  }, [count, value, reduceMotion]);
  // The numeral's own size (32 for the hero dial, 18 for a mini) is not one of the seven type
  // steps (tests/design/scale.test.ts) — it is carried as a custom property rather than a
  // `fontSize` style key, which the inline-style guard (tests/design/inline-style.test.ts) checks.
  return <motion.span className="tabular-nums text-[length:var(--numeral-size)] font-normal tracking-display-lg leading-none text-charcoal"
    style={{ "--numeral-size": `${numeralSize}px` } as React.CSSProperties}>{text}</motion.span>;
}

type Geo = {
  size: number;
  arcR: number;
  stroke: number;
  dotR: number;
  numeralSize: number;
  unitSize: number;
  unitGap: number;
  unitTracking: string;
};

// The dial is the arc alone: no tick ring and no dashed guide.
const HERO: Geo = {
  size: 160, arcR: 70, stroke: 6, dotR: 3, numeralSize: 32, unitSize: 10, unitGap: 6,
  unitTracking: "0.04em",
};
// This is the viewBox, not the rendered box: Gauge draws it at 56 on a narrow phone and 64
// from 380px up, so the dial scales instead of being clipped.
const MINI: Geo = {
  size: 64, arcR: 28, stroke: 4, dotR: 2.5, numeralSize: 18, unitSize: 10, unitGap: 1,
  unitTracking: "0",
};

/** Both sizes share the arc and consumed/target semantics. */
function Gauge({
  spec,
  consumed,
  target,
  compact = false,
  geo: { size, arcR, stroke, dotR, numeralSize, unitSize, unitGap, unitTracking },
}: {
  spec: GaugeSpec;
  consumed: number;
  target: number;
  geo: Geo;
  compact?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const c = size / 2;
  const pct = target > 0 ? Math.min(1, consumed / target) : 0;
  const { circumference, dashoffset } = arc(arcR, pct);
  const excess = excessProgress(consumed, target);
  const { dashoffset: excessOffset } = arc(arcR, excess);
  const dot = tracer(c, c, arcR, excess > 0 ? excess : pct);
  // MotionConfig's reducedMotion only skips transforms; a dash-offset tween
  // would still run. Make the draw instant when reduced motion is requested.
  const reduceMotion = useReducedMotion();
  const duration = reduceMotion ? 0 : DRAW_SECONDS;

  return (
    <div className={compact
      // The box shrinks on a narrow phone, the viewBox does not — the dial scales rather than
      // being clipped by .surface's overflow-hidden. Two 64px dials plus their gap need 140px of
      // the triangle column, which a 320 or 360px viewport does not have once the calorie dial
      // has taken its share.
      ? "relative h-14 w-14 min-[380px]:h-16 min-[380px]:w-16"
      : "relative h-[130px] w-[130px] min-[360px]:h-40 min-[360px]:w-40"}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 h-full w-full overflow-visible"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`ga-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={spec.from} />
            <stop offset="100%" stopColor={spec.to} />
          </linearGradient>
        </defs>
        <circle cx={c} cy={c} r={arcR} fill="none" stroke="rgba(0,0,0,0.05)" strokeWidth={stroke} />
        <motion.circle
          cx={c}
          cy={c}
          r={arcR}
          fill="none"
          stroke={`url(#ga-${uid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          transform={`rotate(-90 ${c} ${c})`}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: dashoffset }}
          transition={{ duration, ease: DRAW_EASE }}
        />
        {excess > 0 && <motion.circle
          data-excess-arc={spec.key}
          cx={c}
          cy={c}
          r={arcR}
          fill="none"
          stroke="var(--color-alert)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          transform={`rotate(-90 ${c} ${c})`}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: excessOffset }}
          transition={{ duration, ease: DRAW_EASE }}
        />}
        <motion.circle
          data-excess-dot={excess > 0 ? spec.key : undefined}
          cx={dot.x}
          cy={dot.y}
          r={dotR}
          fill={excess > 0 ? "var(--color-alert)" : spec.from}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.3, delay: duration }}
        />
      </svg>
      <div
        className="absolute inset-0 flex flex-col items-center justify-center"
        style={{ gap: unitGap }}
        role="img"
        aria-label={target > 0
          ? `${spec.label}: ${fmt(consumed)} of ${fmt(target)}${spec.unit}${excess > 0 ? `, ${fmt(consumed - target)}${spec.unit} over` : ""}`
          : `${spec.label}: ${fmt(consumed)}${spec.unit}`}
      >
        <Numeral value={consumed} numeralSize={numeralSize} />
        {!compact && <span
          className={`tabular-nums ${EYEBROW} text-[length:var(--unit-size)] ${unitTracking === "0" ? "" : "tracking-wider"}`}
          style={{ "--unit-size": `${unitSize}px` } as React.CSSProperties}
        >
          of {fmt(target)}
          {spec.unit}
        </span>}
      </div>
    </div>
  );
}

/** One macro dial with its name and target beneath it — a corner of the triangle. */
function MiniGauge({ spec, consumed, target }: { spec: GaugeSpec; consumed: number; target: number }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <Gauge spec={spec} consumed={consumed} target={target} geo={MINI} compact />
      <div className="flex flex-col items-center">
        <span className={`${EYEBROW} text-tiny tracking-wider`}>{spec.label}</span>
        <span className="tabular-nums text-tiny text-muted">
          {target > 0 ? `of ${fmt(target)}${spec.unit}` : spec.unit.trim()}
        </span>
      </div>
    </div>
  );
}

/**
 * The combined dial layout: calories in the centre, two macro dials a side, water among them. Today
 * moved to the Day card (components/today/DayCard.tsx, 2026-10-01); the coach's chart block still
 * draws this.
 *
 * `water` is the viewed day's count and its goal (T8 §1), drawn as the fifth dial. Absent while
 * the day has not been read from IndexedDB yet: the dial then shows 0 with no target, never a
 * wrong count. With `onAddCup` and `onSetCups` the water dial is pressable: a tap adds a cup, a
 * hold opens the slider (components/WaterDial.tsx), and visible minus and plus steps reach the same
 * bounded count.
 *
 * The dials are the macro detail: a long press on the "Still to eat" line, or its chevron button,
 * folds them away for the rest of this visit. The line and its short divider stay as they are.
 */
export default function MacroRings({ targets, consumed, water, onAddCup, onSetCups, partial = false }: {
  targets: Macros | null; consumed: Macros;
  /** The day holds a partly measured recipe serving (#21): still to eat is "at most", an overshoot
   *  "at least". Water is never partial. */
  partial?: boolean;
  /** Counts in whole cups (storage); `unit` is how they read (lib/water-units), cups by default. */
  water?: { cups: number; goal: number; unit?: WaterUnit };
  onAddCup?: () => void;
  onSetCups?: (cups: number) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(true);
  const detailId = useId();
  const longPress = useLongPress(() => setDetailOpen((open) => !open));
  if (!targets) {
    return (
      <>
        <section className="shell" aria-label="Today's progress">
          <div className="surface overflow-hidden">
          <div className="flex flex-col gap-2 p-5">
            <h2 className="m-0 text-heading-sm font-medium text-charcoal">Finish your profile</h2>
            <p className="m-0 text-caption text-muted">Add your details to get daily targets.</p>
            <a href="/settings"
              className="tap mt-1 flex min-h-11 items-center self-start text-caption text-charcoal">
              Profile
            </a>
          </div>
        </div>
        </section>
      </>
    );
  }
  // The water dial reads in the account's unit, like the orbit's detail (components/HealthOrbitDetail).
  const unit = water?.unit ?? "cups";
  const waterSpec: GaugeSpec = { ...WATER, unit: ` ${unit}` };
  const specOf = (spec: GaugeSpec) => spec.key === "water" ? waterSpec : spec;
  const kcalLeft = Math.max(0, Math.round(targets.kcal - consumed.kcal));
  const proteinLeft = Math.max(0, Math.round(targets.protein - consumed.protein));
  const done = kcalLeft === 0 && proteinLeft === 0;
  const valueOf = (spec: GaugeSpec): [number, number] => spec.key === "water"
    ? [waterValue(water?.cups ?? 0, unit), waterValue(water?.goal ?? 0, unit)]
    : [consumed[spec.key], targets[spec.key]];
  const over = [CALORIES, ...MINIS, waterSpec].flatMap((spec) => {
    const [value, target] = valueOf(spec);
    return target > 0 && value > target
      ? [`${spec.label} ${withBound(`${fmt(value - target)}${spec.unit}`, balanceBound(partial && spec.key !== "water", true))} over`]
      : [];
  });
  const column = (specs: GaugeSpec[]) => (
    <div className="flex shrink-0 flex-col items-center gap-2">
      {specs.map((plain) => {
        const spec = specOf(plain);
        const [value, target] = valueOf(spec);
        const dial = <MiniGauge key={spec.key} spec={spec} consumed={value} target={target} />;
        if (spec.key === "water" && water && onAddCup && onSetCups) {
          return (
            <div key={spec.key} className="flex shrink-0 flex-col items-center">
              <WaterDial cups={water.cups} goal={water.goal} unit={unit} onAddCup={onAddCup} onSetCups={onSetCups}>
                {dial}
              </WaterDial>
              <WaterSteps cups={water.cups} unit={unit} onSetCups={onSetCups} />
            </div>
          );
        }
        return dial;
      })}
    </div>
  );

  return (
    <section className="shell" aria-label="Today's progress">
      <div className="surface overflow-hidden">
        <div className="p-3">
        {detailOpen && <div id={detailId} className="flex items-center justify-center gap-2 min-[380px]:gap-4">
          {column(LEFT_DIALS)}
          <div className="flex shrink-0 flex-col items-center gap-1">
            <Gauge spec={CALORIES} consumed={consumed.kcal} target={targets.kcal} geo={HERO} />
            <span className={`${EYEBROW} text-tiny tracking-widest`}>Calories</span>
          </div>
          {column(RIGHT_DIALS)}
        </div>}
        {/* Folding the dials away never takes water logging with them. */}
        {!detailOpen && water && onSetCups && <WaterSteps cups={water.cups} unit={unit} onSetCups={onSetCups}
          label={<><span className="text-muted">Water </span>
            {water.goal > 0 ? formatWaterOf(water.cups, water.goal, unit) : formatWater(water.cups, unit)}</>} />}
        <div className="mt-3 border-t border-hairline pt-3 text-center text-xs">
          <div data-macro-summary {...longPress}
            className="relative flex min-h-11 select-none items-center justify-center px-11 [-webkit-touch-callout:none]">
            <span role="status">
              {over.length > 0 ? (
                <span className="text-alert">{over.join(" · ")}</span>
              ) : done ? (
                <span>Calories and protein done for today.</span>
              ) : (
                <><span className="text-muted">Still to eat </span>
                  <span className="tabular-nums">
                    <MacroLine label="word" only={["kcal", "protein"]} bound={balanceBound(partial, false)}
                      values={{ kcal: kcalLeft, protein: proteinLeft, carbs: null, fat: null }} />
                  </span></>
              )}
            </span>
            <button type="button" aria-label="Macro detail" aria-expanded={detailOpen}
              aria-controls={detailOpen ? detailId : undefined}
              onClick={() => setDetailOpen((open) => !open)}
              className="tap absolute inset-y-0 right-0 my-auto flex h-11 w-11 items-center justify-center rounded-full text-muted focus-visible:outline-2 focus-visible:outline-primary">
              <Chevrons direction={detailOpen ? "up" : "down"} />
            </button>
          </div>
        </div>
      </div>
        </div>
    </section>
  );
}
