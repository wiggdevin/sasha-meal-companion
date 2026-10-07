"use client";
/**
 * The nutrition graph forms (owner, 2026-10-04), every one drawn from components/nutrition/spec.ts so
 * a macro keeps its hue in every shape: a donut (the split of a serving's calories, or calories against
 * a target), bars (horizontal or vertical) and half-circle gauges. Fills use the gauge hue; figures use
 * the readable ink. Lengths spring to new values on the container spring; reduced motion jumps.
 */
import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import { GRAM_MACROS, MACRO_SPEC, energySplit, formatMacro, spokenMacro, type MacroKey, type MacroValues }
  from "@/components/nutrition/spec";

const ratio = (value: number | null, target: number | null | undefined) =>
  value === null || !target ? 0 : Math.max(0, Math.min(1, value / target));

/**
 * A ring. `split`: protein, carbs and fat as arcs by their share of the calories, the calorie figure in
 * the middle. `progress`: one calorie arc against `target`. Spoken as its figures, never as a picture.
 */
export function MacroDonut({ values, target, size = 64, thickness = 7, center }: {
  values: MacroValues; target?: number | null; size?: number; thickness?: number; center?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const move = reduce ? INSTANT : SPRINGS.smooth;
  const split = target === undefined ? energySplit(values) : null;
  const gap = split ? Math.min(3, c * 0.012) : 0;
  let start = 0;
  const arcs = target !== undefined
    ? [{ key: "kcal" as MacroKey, length: ratio(values.kcal, target) * c, offset: 0 }]
    : GRAM_MACROS.map((key) => {
      const length = Math.max(0, (split?.[key] ?? 0) * c - gap);
      const arc = { key: key as MacroKey, length, offset: start };
      start += (split?.[key] ?? 0) * c;
      return arc;
    });
  return <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={thickness} className="stroke-current text-charcoal/8" />
      {arcs.map((arc) => <motion.circle key={arc.key} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={thickness}
        strokeLinecap={split ? "butt" : "round"} className={`${MACRO_SPEC[arc.key].fill} stroke-current`}
        initial={false} animate={{ strokeDasharray: `${arc.length} ${c}`, strokeDashoffset: -arc.offset }} transition={move} />)}
    </svg>
    <span className="absolute inset-0 grid place-items-center text-center leading-none">
      {center ?? <span className="flex flex-col items-center gap-0.5">
        <span className="kcal text-body-md font-semibold tabular-nums">{values.kcal === null ? "—" : formatMacro(values.kcal)}</span>
        <span className="text-overline uppercase tracking-[0.08em] text-muted">kcal</span>
      </span>}
    </span>
  </span>;
}

/** One nutrient's bar: `amount` from 0 to 1, in the nutrient's gauge hue on a quiet track. */
export function MacroMeter({ macro, amount }: { macro: MacroKey; amount: number }) {
  const reduce = useReducedMotion();
  return <span aria-hidden="true" className="block h-1.5 w-full overflow-hidden rounded-full bg-charcoal/8">
    <motion.span className={`block h-full rounded-full bg-current ${MACRO_SPEC[macro].fill}`} initial={false}
      animate={{ width: `${Math.max(0, Math.min(1, amount)) * 100}%` }} transition={reduce ? INSTANT : SPRINGS.smooth} />
  </span>;
}

/**
 * Bars. Without `targets` each gram macro's bar is its share of the calories; with `targets` every
 * nutrient's bar is its value against its target. Horizontal rows read label · bar · figure; vertical
 * columns stand side by side with the figure on top.
 */
export function MacroBars({ values, targets, orientation = "horizontal", only = GRAM_MACROS, height = 56 }: {
  values: MacroValues; targets?: Partial<Record<MacroKey, number | null>> | null;
  orientation?: "horizontal" | "vertical"; only?: readonly MacroKey[]; height?: number;
}) {
  const reduce = useReducedMotion();
  const move = reduce ? INSTANT : SPRINGS.smooth;
  const split = energySplit(values);
  const amount = (key: MacroKey) => targets ? ratio(values[key], targets[key]) : key === "kcal" ? 1 : split?.[key as Exclude<MacroKey, "kcal">] ?? 0;
  if (orientation === "vertical") {
    return <span className="flex items-end gap-3">
      {only.map((key) => <span key={key} className="flex flex-col items-center gap-1">
        <span className="sr-only">{spokenMacro(key, values[key])}</span>
        <span aria-hidden="true" className={`text-tiny font-semibold tabular-nums ${MACRO_SPEC[key].ink}`}>
          {values[key] === null ? "—" : `${formatMacro(values[key]!)}${key === "kcal" ? "" : "g"}`}</span>
        <span aria-hidden="true" className="flex w-3 items-end overflow-hidden rounded-full bg-charcoal/8" style={{ height }}>
          <motion.span className={`block w-full rounded-full bg-current ${MACRO_SPEC[key].fill}`} initial={false}
            animate={{ height: `${amount(key) * 100}%` }} transition={move} />
        </span>
        <span aria-hidden="true" className="text-overline tracking-[0.08em] text-muted">{MACRO_SPEC[key].abbr}</span>
      </span>)}
    </span>;
  }
  return <span className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1.5">
    {only.map((key) => <span key={key} className="contents">
      <span className="sr-only">{spokenMacro(key, values[key])}</span>
      <span aria-hidden="true" className="text-overline tracking-[0.08em] text-muted">{MACRO_SPEC[key].abbr}</span>
      <MacroMeter macro={key} amount={amount(key)} />
      <span aria-hidden="true" className={`text-tiny font-semibold tabular-nums ${MACRO_SPEC[key].ink}`}>
        {values[key] === null ? "—" : `${formatMacro(values[key]!)}${key === "kcal" ? "" : "g"}`}</span>
    </span>)}
  </span>;
}

/** A half-circle gauge: one nutrient against its target, the figure under the arc's opening. */
export function MacroGauge({ macro, value, target, size = 64 }: {
  macro: MacroKey; value: number | null; target: number | null; size?: number;
}) {
  const reduce = useReducedMotion();
  const thickness = Math.max(5, size / 10);
  const r = (size - thickness) / 2;
  const half = Math.PI * r;
  const h = size / 2 + thickness / 2;
  const d = `M ${thickness / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - thickness / 2} ${size / 2}`;
  return <span className="inline-flex flex-col items-center">
    <span className="sr-only">{spokenMacro(macro, value)}{target ? ` of ${formatMacro(target)}` : ""}</span>
    <span aria-hidden="true" className="relative" style={{ width: size, height: h }}>
      <svg width={size} height={h} viewBox={`0 0 ${size} ${h}`}>
        <path d={d} fill="none" strokeWidth={thickness} strokeLinecap="round" className="stroke-current text-charcoal/8" />
        <motion.path d={d} fill="none" strokeWidth={thickness} strokeLinecap="round"
          className={`${MACRO_SPEC[macro].fill} stroke-current`} initial={false}
          animate={{ strokeDasharray: `${ratio(value, target) * half} ${half}` }} transition={reduce ? INSTANT : SPRINGS.smooth} />
      </svg>
      <span className={`absolute inset-x-0 bottom-0 text-center text-tiny font-semibold leading-none tabular-nums ${MACRO_SPEC[macro].ink}`}>
        {value === null ? "—" : formatMacro(value)}</span>
    </span>
    <span aria-hidden="true" className="mt-1 text-overline tracking-[0.08em] text-muted">{MACRO_SPEC[macro].abbr}</span>
  </span>;
}

/** One bar split by each gram macro's share of the calories (the meal card's divider bar). */
export function MacroSplit({ values, className = "" }: { values: MacroValues; className?: string }) {
  const split = energySplit(values);
  return <span aria-hidden="true" className={`flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full ${className}`.trim()}>
    {GRAM_MACROS.map((key) => <span key={key} className={`block h-full rounded-full bg-current ${MACRO_SPEC[key].fill}`}
      style={{ flexGrow: split?.[key] ?? 1, flexBasis: 0 }} />)}
  </span>;
}

/**
 * One nutrient's progress toward its target, the one meaning a nutrition bar has (Kimi review
 * 2026-10-04: bars that sometimes meant share of calories and sometimes progress were misread).
 * `base`, when given, is what is already eaten, drawn in a lighter fill; `add` (one serving) sits on top
 * in the full hue. Past the target the bar stays full and the caller says "over" in words, never by
 * switching hue.
 */
export function TargetMeter({ macro, add, base = 0, target }: {
  macro: MacroKey; add: number | null; base?: number | null; target: number | null;
}) {
  const reduce = useReducedMotion();
  const move = reduce ? INSTANT : SPRINGS.smooth;
  const baseShare = ratio(base ?? 0, target);
  const addShare = Math.max(0, Math.min(1 - baseShare, ratio(add, target)));
  return <span aria-hidden="true" className="relative block h-1.5 w-full overflow-hidden rounded-full bg-charcoal/8">
    <motion.span className={`absolute inset-y-0 left-0 rounded-full bg-current opacity-40 ${MACRO_SPEC[macro].fill}`}
      initial={false} animate={{ width: `${baseShare * 100}%` }} transition={move} />
    <motion.span className={`absolute inset-y-0 rounded-full bg-current ${MACRO_SPEC[macro].fill}`}
      initial={false} animate={{ left: `${baseShare * 100}%`, width: `${addShare * 100}%` }} transition={move} />
  </span>;
}
