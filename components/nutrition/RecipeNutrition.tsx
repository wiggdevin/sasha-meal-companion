"use client";
/**
 * A recipe's nutrition panel (owner + two Kimi K3 review rounds, 2026-10-04). The serving's calories sit
 * in the title row (ServingKcal), so the panel holds the same three macro columns in both views; the
 * switch changes what they are measured against, never the layout. Every bar means one thing, progress
 * toward the day's target: per serving, the serving's share of the day; "Your day", what is already
 * eaten (light) with the serving on top (full), each figure the day's total after it and its note what
 * is left. The header carries the recipe's diet badges per serving and the day's calories in the day
 * view. Without a target revision there is nothing to measure against: the bars show each macro's
 * share of the serving's calories and say so.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FADES, INSTANT, SPRINGS, SWAP } from "@/lib/design/motion";
import { MacroMeter, TargetMeter } from "@/components/nutrition/charts";
import { GRAM_MACROS, MACRO_SPEC, energySplit, formatMacro, type MacroKey, type MacroValues }
  from "@/components/nutrition/spec";
import { dayEaten } from "@/lib/recipes-hub/day-after";
import { onAccountReady } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { TARGETS_CHANGED_EVENT } from "@/lib/sync/outbox";
import { todayIso } from "@/lib/settings/date";

type Mode = "serving" | "day";
type Day = ReturnType<typeof dayEaten>;

/** The day's eaten totals and targets from the phone's store, read after mount (the server has no
 *  store) and again whenever the account loads, a sync lands or the targets change. */
function useDay(date: string): Day | null {
  const [day, setDay] = useState<Day | null>(null);
  useEffect(() => {
    const read = () => { try { setDay(dayEaten(date)); } catch { setDay(null); } };
    read();
    const ready = onAccountReady(read);
    window.addEventListener(SYNCED_EVENT, read);
    window.addEventListener(TARGETS_CHANGED_EVENT, read);
    return () => { ready(); window.removeEventListener(SYNCED_EVENT, read); window.removeEventListener(TARGETS_CHANGED_EVENT, read); };
  }, [date]);
  return day;
}

function Column({ macro, figure, note, spoken, bar }: {
  macro: MacroKey; figure: number | null; note: string; spoken: string; bar: React.ReactNode;
}) {
  const spec = MACRO_SPEC[macro];
  return <li data-macro={macro} className="flex min-w-0 flex-col gap-1">
    <span className="sr-only">{spoken}</span>
    <span aria-hidden="true" className="flex items-baseline gap-1 whitespace-nowrap tabular-nums">
      <span className={`text-caption font-semibold ${figure === null ? "text-muted" : spec.ink}`}>
        {figure === null ? "—" : `${formatMacro(figure)}${spec.unit === "g" ? "g" : ""}`}</span>
      <span className="text-overline tracking-[0.08em] text-muted">{spec.abbr === "kcal" ? "KCAL" : spec.abbr}</span>
    </span>
    {bar}
    <span aria-hidden="true" className="truncate text-tiny text-muted tabular-nums">{note}</span>
  </li>;
}

function Switch({ mode, onChange, panel }: { mode: Mode; onChange: (mode: Mode) => void; panel: string }) {
  const reduce = useReducedMotion();
  const lens = useId();
  return <div role="tablist" aria-label="Nutrition view" className="ml-auto flex h-7 shrink-0 items-center rounded-full bg-charcoal/6 p-0.5">
    {(["serving", "day"] as const).map((value) => <button key={value} type="button" role="tab"
      aria-selected={mode === value} aria-controls={panel} onClick={() => onChange(value)}
      className={`relative h-6 whitespace-nowrap rounded-full px-2.5 text-tiny font-medium before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-[''] ${
        mode === value ? "text-on-primary" : "text-graphite"}`}>
      {mode === value && <motion.span layoutId={lens} className="absolute inset-0 rounded-full bg-primary"
        transition={reduce ? INSTANT : SPRINGS.snappy} />}
      <span className="relative">{value === "serving" ? "Per serving" : "Your day"}</span>
    </button>)}
  </div>;
}

export default function RecipeNutrition({ serving, estimated = {}, date, badges }: {
  serving: MacroValues;
  /** Which serving values are estimates; said aloud, never drawn as a sign (owner: no "≈"). */
  estimated?: Partial<Record<MacroKey, boolean>>;
  /** The recipe's diet badges, shown at the head of the per-serving view. */
  badges?: ReactNode;
  /** The day the meal would be eaten on; today when the caller has none. */
  date?: string;
}) {
  const reduce = useReducedMotion();
  const panel = useId();
  const [mode, setMode] = useState<Mode>("serving");
  const loaded = useDay(date ?? todayIso());
  const eaten = loaded?.eaten ?? { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const targets = loaded?.targets ?? null;
  const split = energySplit(serving);
  const shown = mode === "day" && targets ? "day" : "serving";
  const dayKcal = serving.kcal === null ? null : eaten.kcal + serving.kcal;
  const head = shown === "day"
    ? <span className="whitespace-nowrap text-tiny tabular-nums">
      <span className="sr-only">{dayKcal === null ? "Calories unknown" : `${formatMacro(dayKcal)} of ${formatMacro(targets!.kcal)} calories today after this serving`}</span>
      <span aria-hidden="true"><span className="kcal text-caption font-semibold">{dayKcal === null ? "—" : formatMacro(dayKcal)}</span>
        <span className="text-muted"> of {formatMacro(targets!.kcal)} kcal</span></span></span>
    : badges ?? <span className="eyebrow whitespace-nowrap text-muted">{targets ? "Nutrition" : "Share of calories"}</span>;
  return <section aria-label="Nutrition" className="flex flex-col gap-2.5 rounded-2xl bg-fog p-3">
    {/* The badges and the toggle share a row while both fit; when they do not, the toggle drops to its
        own line rather than sliding over the badges (owner, 2026-10-04: "No overlapping text"). */}
    <div data-nutrition-head="" className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">{head}</span>
      {targets && <Switch mode={mode} onChange={setMode} panel={panel} />}
    </div>
    <AnimatePresence mode="wait" initial={false}>
      <motion.ul key={shown} id={panel} role="tabpanel" initial={SWAP.hidden} animate={SWAP.shown} exit={SWAP.hidden}
        transition={reduce ? INSTANT : FADES.quick}
        className="m-0 grid list-none grid-cols-3 gap-3 p-0">
        {GRAM_MACROS.map((key) => {
          const spec = MACRO_SPEC[key];
          const unit = spec.unit === "g" ? "g" : "";
          const add = serving[key];
          const target = targets?.[key] ?? null;
          if (shown === "day") {
            const total = add === null ? null : eaten[key] + add;
            const over = total !== null && target !== null && total > target;
            const note = target === null || total === null ? ""
              : over ? `${formatMacro(total - target)}${unit} over` : `${formatMacro(target - total)}${unit} left`;
            return <Column key={key} macro={key} figure={total} note={note}
              spoken={`${spec.label}: ${total === null ? "unknown" : `${formatMacro(total)} ${spec.unit}`} after this serving${
                target === null ? "" : ` of ${formatMacro(target)} ${spec.unit}${over ? ", over target" : ""}`}`}
              bar={<TargetMeter macro={key} base={eaten[key]} add={add} target={target} />} />;
          }
          const est = estimated[key] ? ", estimated" : "";
          if (add === null) {
            return <Column key={key} macro={key} figure={null} note="unknown" spoken={`${spec.label} unknown`}
              bar={<MacroMeter macro={key} amount={0} />} />;
          }
          if (!targets) {
            const share = split?.[key as Exclude<MacroKey, "kcal">] ?? null;
            const pct = share === null ? null : Math.round(share * 100);
            return <Column key={key} macro={key} figure={add} note={pct === null ? "" : `${pct}% of kcal`}
              spoken={`${spec.label}: ${formatMacro(add)} grams${est}${pct === null ? "" : `, ${pct}% of calories`}`}
              bar={<MacroMeter macro={key} amount={share ?? 0} />} />;
          }
          const pct = !target ? null : Math.round((add / target) * 100);
          return <Column key={key} macro={key} figure={add} note={pct === null ? "" : `${pct}% of day`}
            spoken={`${spec.label}: ${formatMacro(add)} grams${est}${pct === null ? "" : `, ${pct}% of your day`}`}
            bar={<TargetMeter macro={key} add={add} target={target} />} />;
        })}
      </motion.ul>
    </AnimatePresence>
  </section>;
}

/** The serving's calories for a title row: the serif persimmon numeral the meal card uses, its unit
 *  under it. Always one serving; the day view never repeats a figure here (Kimi review, blocker 1). */
export function ServingKcal({ kcal }: { kcal: number | null }) {
  if (kcal === null) return null;
  return <span className="flex shrink-0 flex-col items-end leading-none">
    <span className="sr-only">{formatMacro(kcal)} calories per serving</span>
    <span aria-hidden="true" className="kcal font-display text-heading font-medium tabular-nums">{formatMacro(kcal)}</span>
    <span aria-hidden="true" className="mt-1 text-overline uppercase tracking-[0.1em] text-muted">kcal</span>
  </span>;
}
