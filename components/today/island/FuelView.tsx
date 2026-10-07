"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useAnimationControls, useMotionValue, useReducedMotionConfig,
  useTransform } from "motion/react";
import Ring from "@/components/today/island/Ring";
import { GRAM_MACROS, MACRO_SPEC, formatMacro, type GramMacro } from "@/components/nutrition/spec";
import { balanceBound, boundWords, eatenBound, withBound } from "@/lib/nutrition-display";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import type { Macros } from "@/lib/types";
import styles from "@/components/today/island/FuelView.module.css";

type FuelData = { targets: Macros; consumed: Macros; partial: boolean };
type Key = "kcal" | GramMacro;

const RING = 76;
/** A backstop only: the goo ends when the beads' layout morph completes; this ends it if none runs. */
const MERGE_MS = 1200;

const left = (key: Key, { targets, consumed }: FuelData) => {
  const diff = Math.round(targets[key] - consumed[key]);
  return { amount: Math.abs(diff), over: diff < 0 };
};
const shareOf = (key: Key, { targets, consumed }: FuelData) =>
  targets[key] > 0 ? Math.max(0, Math.min(1, consumed[key] / targets[key])) : 0;

function spokenFocus(macro: GramMacro, data: FuelData): string {
  const { amount, over } = left(macro, data);
  const eaten = withBound(`${formatMacro(data.consumed[macro])} grams`, eatenBound(data.partial));
  return `${MACRO_SPEC[macro].label}: ${withBound(`${formatMacro(amount)} grams`, balanceBound(data.partial, over))} ${over ? "over" : "left"}, ${eaten} eaten of ${formatMacro(data.targets[macro])}.`;
}

/** A figure that rolls to its new value on the smooth spring, never jumps. */
function Rolling({ value, reduce }: { value: number; reduce: boolean }) {
  const shown = useMotionValue(value);
  const text = useTransform(shown, (v) => formatMacro(v));
  useEffect(() => {
    if (reduce) { shown.set(value); return; }
    const run = animate(shown, value, SPRINGS.smooth);
    return () => run.stop();
  }, [value, reduce, shown]);
  return <motion.span>{text}</motion.span>;
}

/** The figure on top: the calories, or the macro the user opened. */
function Hero({ focus, data, reduce }: { focus: Key; data: FuelData; reduce: boolean }) {
  const { amount, over } = left(focus, data);
  const bound = boundWords(balanceBound(data.partial, over));
  const eaten = boundWords(eatenBound(data.partial));
  const unit = focus === "kcal" ? "kcal" : `g ${MACRO_SPEC[focus].label.toLowerCase()}`;
  // A partly measured day has lower-bound totals on both sides: a share of them would be a guess.
  const ofDay = focus !== "kcal" && !data.partial && data.consumed.kcal > 0
    ? Math.round((data.consumed[focus] * (MACRO_SPEC[focus].kcalPerGram ?? 0) / data.consumed.kcal) * 100) : null;
  return <div className={styles.hero}>
    <span className={styles.heroLine}>
      {bound && <span className={styles.word}>{bound}</span>}
      <span className={`${styles.figure} ${focus === "kcal" ? "macro-ink-kcal" : MACRO_SPEC[focus].ink}`}>
        <Rolling value={amount} reduce={reduce} />
      </span>
      <span className={styles.word}>{unit} {over ? "over" : "left"}</span>
    </span>
    <span className={styles.meta}>
      {eaten ? `${eaten} ` : ""}{formatMacro(data.consumed[focus])}{focus === "kcal" ? "" : " g"} eaten of {formatMacro(data.targets[focus])}{focus === "kcal" ? "" : " g"}
      {ofDay !== null && ` · ${ofDay}% of today's calories`}
    </span>
  </div>;
}

/** A jelly tube the day fills like a glass: calories by default, the opened macro when one is open. */
function Tube({ focus, data, reduce, ripple }: { focus: Key; data: FuelData; reduce: boolean; ripple: number }) {
  const share = shareOf(focus, data);
  const over = data.consumed[focus] > data.targets[focus] && data.targets[focus] > 0;
  return <span aria-hidden="true" className={`${styles.tube} ${focus === "kcal" ? styles.kcal : MACRO_SPEC[focus].fill}`}
    data-over={over || undefined}>
    <motion.span className={styles.fill} initial={false}
      animate={{ width: share > 0 ? `${Math.max(6, share * 100)}%` : "0%" }}
      transition={reduce ? INSTANT : SPRINGS.bouncy}>
      <span className={styles.sheen} data-still={reduce || undefined} />
      {!reduce && ripple > 0 && <motion.span key={ripple} className={styles.ripple}
        initial={{ opacity: 1, scaleX: 0.2 }} animate={{ opacity: 0, scaleX: 1.6 }}
        transition={{ duration: 0.9, ease: "easeOut" }} />}
    </motion.span>
  </span>;
}

/** Light thrown off a ring when what it counts goes up: a few droplets, once. */
function Burst({ count, className }: { count: number; className: string }) {
  return <span aria-hidden="true" className={`${styles.burst} ${className}`}>
    {Array.from({ length: 7 }, (_, i) => {
      const angle = (i / 7) * Math.PI * 2 + count;
      return <motion.span key={`${count}-${i}`} className={styles.spark}
        initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
        animate={{ x: Math.cos(angle) * 54, y: Math.sin(angle) * 54, opacity: 0, scale: 0.3 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }} />;
    })}
  </span>;
}

function MacroRing({ macro, data, focus, onToggle, reduce }: {
  macro: GramMacro; data: FuelData; focus: Key; onToggle: (macro: GramMacro) => void; reduce: boolean;
}) {
  const { amount, over } = left(macro, data);
  const opened = focus === macro;
  const away = focus !== "kcal" && !opened;
  const wobble = useAnimationControls();
  const [burst, setBurst] = useState(0);
  const last = useRef(data.consumed[macro]);
  useEffect(() => {
    const before = last.current;
    last.current = data.consumed[macro];
    if (reduce || data.consumed[macro] <= before) return;
    setBurst((n) => n + 1);
    void wobble.start({ scaleX: [1, 1.12, 0.94, 1.03, 1], scaleY: [1, 0.9, 1.08, 0.98, 1],
      transition: { duration: 0.7, ease: "easeOut" } });
  }, [data.consumed, macro, reduce, wobble]);
  const label = `${MACRO_SPEC[macro].label}: ${withBound(`${formatMacro(amount)} grams`, balanceBound(data.partial, over))} ${over ? "over" : "left"}`;
  return <motion.li layout className={styles.item} data-state={opened ? "open" : away ? "away" : undefined}
    transition={reduce ? INSTANT : SPRINGS.gentle}>
    <motion.button type="button" className={`tap ${styles.ringButton}`} aria-pressed={opened}
      aria-label={`${label}. ${opened ? "Back to all three" : "Show details"}`} tabIndex={away ? -1 : 0}
      onClick={(event: MouseEvent) => { event.stopPropagation(); onToggle(macro); }}
      initial={false} animate={{ scale: opened ? 1.32 : away ? 0.3 : 1, opacity: away ? 0 : 1 }}
      transition={reduce ? INSTANT : { scale: SPRINGS.bouncy, opacity: away ? FADES.quick : { ...FADES.base, delay: 0.12 } }}
      whileTap={reduce ? undefined : { scale: opened ? 1.24 : 0.92 }}>
      <motion.span className={styles.wobble} animate={wobble}>
        <Ring share={shareOf(macro, data)} size={RING} stroke={7} colorClass={`${MACRO_SPEC[macro].fill} ${styles.arc}`}>
          {/* Open, the figure above carries the grams; the ring says how much of the target is in. */}
          <span className={`${styles.ringFigure} ${MACRO_SPEC[macro].ink}`}>
            {opened ? <>{Math.round(shareOf(macro, data) * 100)}<span className={styles.gram}>%</span></>
              : <>{formatMacro(amount)}<span className={styles.gram}>g</span></>}
          </span>
        </Ring>
        {burst > 0 && <Burst count={burst} className={MACRO_SPEC[macro].fill} />}
      </motion.span>
      <span className={styles.abbr} data-over={over || undefined}>{over ? "over" : MACRO_SPEC[macro].abbr}</span>
    </motion.button>
  </motion.li>;
}

/**
 * The open well's showcase of the day's fuel (owner, 2026-10-06): the calories on top as a rolling
 * figure over a jelly tube the day fills, and the three macro rings below, with no title, no "left"
 * and no pager. Tap a ring and the view melts into that macro: the other two beads are drawn into it
 * like sticky liquid (an SVG goo on a bead layer under the rings, only while they move), the figure
 * and the tube become the macro's own. Tap it again, or anywhere else in the view, and it melts back.
 * When the day's numbers go up the figure rolls, the tube ripples and each ring that grew wobbles and
 * throws a few droplets.
 */
export default function FuelView({ data }: { data: FuelData }) {
  const reduce = useReducedMotionConfig() ?? false;
  const id = useId().replace(/:/g, "");
  const [focus, setFocus] = useState<Key>("kcal");
  const [merging, setMerging] = useState(false);
  const [ripple, setRipple] = useState(0);
  const lastKcal = useRef(data.consumed.kcal);
  useEffect(() => {
    if (!merging) return;
    const timer = setTimeout(() => setMerging(false), MERGE_MS);
    return () => clearTimeout(timer);
  }, [merging, focus]);
  useEffect(() => {
    const before = lastKcal.current;
    lastKcal.current = data.consumed.kcal;
    if (data.consumed.kcal > before) setRipple((n) => n + 1);
  }, [data.consumed.kcal]);

  // The goo holds until every bead's layout morph has landed (the timer above is only a backstop).
  const landed = useRef(0);
  const choose = (next: Key) => { landed.current = 0; setFocus(next); if (!reduce) setMerging(true); };
  const onLanded = () => { landed.current += 1; if (landed.current >= GRAM_MACROS.length) setMerging(false); };
  const toggle = (macro: GramMacro) => choose(focus === macro ? "kcal" : macro);
  const onBackground = (event: MouseEvent) => {
    // Open on one macro, a tap anywhere in the view melts it back (and does not close the well).
    if (focus === "kcal") return;
    event.stopPropagation();
    choose("kcal");
  };

  return <div className={styles.view} data-focus={focus} onClick={onBackground}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div key={focus} className={styles.top} aria-hidden="true"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(6px)", scale: 0.98 }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)", scale: 1, transitionEnd: { filter: "none" } }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(6px)", scale: 0.98 }}
        transition={reduce ? INSTANT : SPRINGS.smooth}>
        <Hero focus={focus} data={data} reduce={reduce} />
      </motion.div>
    </AnimatePresence>
    {/* One settled sentence for a screen reader when a ring opens or closes; the rolling figure stays silent. */}
    <span className="sr-only" aria-live="polite">{focus === "kcal" ? "" : spokenFocus(focus, data)}</span>
    <Tube focus={focus} data={data} reduce={reduce} ripple={ripple} />
    <svg width="0" height="0" aria-hidden="true" className={styles.defs}>
      <filter id={`${id}-goo`}>
        <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
        <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10" />
      </filter>
    </svg>
    <LayoutGroup id={`${id}-fuel`}>
      <div className={styles.stack}>
        {/* The beads: shapes only, merged like liquid while they travel. */}
        <ul aria-hidden="true" className={`${styles.row} ${styles.beads}`} data-focus={focus === "kcal" ? undefined : ""}
          style={{ filter: merging && !reduce ? `url(#${id}-goo)` : undefined }}>
          {GRAM_MACROS.map((macro) => {
            const opened = focus === macro;
            const away = focus !== "kcal" && !opened;
            return <motion.li layout key={macro} className={styles.item}
              data-state={opened ? "open" : away ? "away" : undefined} transition={reduce ? INSTANT : SPRINGS.gentle}
              onLayoutAnimationComplete={onLanded}>
              <motion.span className={`${styles.bead} ${MACRO_SPEC[macro].fill}`} initial={false}
                animate={{ scale: opened ? 1.32 : away ? 0.3 : 1 }} transition={reduce ? INSTANT : SPRINGS.bouncy} />
            </motion.li>;
          })}
        </ul>
        <ul className={styles.row} data-focus={focus === "kcal" ? undefined : ""}>
          {GRAM_MACROS.map((macro) => <MacroRing key={macro} macro={macro} data={data} focus={focus}
            onToggle={toggle} reduce={reduce} />)}
        </ul>
      </div>
    </LayoutGroup>
  </div>;
}
