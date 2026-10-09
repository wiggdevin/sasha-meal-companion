"use client";

import { Flame, Moon, Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import AutoHeight from "@/components/ui/AutoHeight";
import Ring from "@/components/today/island/Ring";
import LiquidOrb from "@/components/today/island/LiquidOrb";
import { GRAM_MACROS, MACRO_SPEC, formatMacro } from "@/components/nutrition/spec";
import { balance, dayMood, share, type PanelData } from "@/components/today/LiveWidgetPanels";
import { balanceBound, boundLabel, boundWords, eatenBound, withBound } from "@/lib/nutrition-display";
import { orbitNodes, type OrbitBody } from "@/lib/today/health-orbit";
import { formatWater, formatWaterOf, waterNumber } from "@/lib/water-units";
import styles from "@/components/today/DayOverview.module.css";

/** Each gauge's arc in its ink sibling on the ivory well (brief 2026-10-08 §2.3): scoped here only. */
const ARC: Record<(typeof GRAM_MACROS)[number], string> = {
  protein: styles.arcProtein, carbs: styles.arcCarbs, fat: styles.arcFat,
};

/**
 * The Day card's Overview face, cards v4 (brief 2026-10-08 §4, "Remaining Wheel"). Two glass wells on
 * the ivory card. The hero well answers "how much do I have left": a ring that is full on a fresh
 * day and drains as the day is eaten, the calories left (or over) inside it, and what was eaten one
 * tier down. The quiet well holds the rest at one rank: protein, carbs and fat as small gauges; water
 * as a living bead (truly empty at zero) with an icon-only Add a cup; active burn and recovery, which
 * say "Off" and offer to connect when the body source is off — never an unmeasured zero — and say
 * when a reading is from before the phone went offline. The rings draw on the bouncy spring.
 */
export default function DayOverview({ data, body }: { data: PanelData; body?: OrbitBody }) {
  const { targets, consumed, partial, water, onAddCup } = data;
  const kcal = balance("kcal", data);
  const nodes = orbitNodes({ targets, consumed, water, body, partial });
  const health = nodes.filter((node) => node.key === "activity" || node.key === "recovery");
  const eatenWord = partial ? boundLabel(eatenBound(true)) : "";
  const leftWord = boundLabel(balanceBound(partial, kcal.over));
  const left = kcal.over ? 0 : share(kcal.amount, targets.kcal);
  const unit = water?.unit ?? "cups";
  const waterEmpty = !water || water.cups <= 0;
  return <div className={styles.overview}>
    <section className={`glass-well ${styles.well} ${styles.heroWell}`} aria-label="Calories" data-mood={dayMood(data)}>
      <span className="sr-only">{`${withBound(`${formatMacro(consumed.kcal)} kcal`, partial ? eatenBound(true) : undefined)} eaten of ${formatMacro(targets.kcal)}. ${withBound(`${formatMacro(kcal.amount)} kcal`, balanceBound(partial, kcal.over))} ${kcal.over ? "over" : "left"}.`}</span>
      <span className={styles.heroRing} data-testid="overview-kcal-ring" data-share={left}>
        <Ring share={left} size={128} stroke={10} colorClass={styles.arcKcal} onLight>
          <span aria-hidden="true" className={styles.ringStack}>
            {leftWord && <span className={styles.bound}>{leftWord}</span>}
            <span className={styles.hero} data-testid="overview-hero">{formatMacro(kcal.amount)}</span>
            <span className={styles.label} data-testid="overview-hero-label">{kcal.over ? "Over" : "Left"}</span>
          </span>
        </Ring>
      </span>
      <span aria-hidden="true" className={styles.heroSide}>
        <span className={styles.caption}>of {formatMacro(targets.kcal)} kcal</span>
        <span className={styles.eaten} data-testid="overview-eaten">
          {eatenWord && <span className={styles.eatenWord}>{eatenWord} </span>}
          <span className={styles.eatenFigure}>{formatMacro(consumed.kcal)}</span> eaten
        </span>
      </span>
    </section>

    <section className={`glass-well ${styles.well} ${styles.quietWell}`} aria-label="Macros, water and body">
      <ul className={styles.macros}>
        {GRAM_MACROS.map((key) => {
          const { over } = balance(key, data);
          return <li key={key} className={styles.macro}>
            <span className="sr-only">{`${MACRO_SPEC[key].label}: ${withBound(`${formatMacro(consumed[key])} grams`, partial ? eatenBound(true) : undefined)} of ${formatMacro(targets[key])}${over ? ", over" : ""}`}</span>
            <span className={styles.gauge}>
              <Ring share={share(consumed[key], targets[key])} size={32} stroke={4} onLight colorClass={ARC[key]} />
            </span>
            <span aria-hidden="true" className={styles.stack}>
              <span className={styles.macroValue}>
                <span className={MACRO_SPEC[key].ink}>{formatMacro(consumed[key])}</span>
                <span className={styles.of}> / {formatMacro(targets[key])}g</span>
              </span>
              <span className={styles.label}>{MACRO_SPEC[key].label}</span>
              {partial && <span className={styles.note}>{boundWords(eatenBound(true))}</span>}
            </span>
          </li>;
        })}
      </ul>

      <div className={styles.waterRow}>
        <span className="sr-only">{water ? `Water: ${formatWaterOf(water.cups, water.goal, unit)}` : "Water: loading"}</span>
        <span className={styles.waterBead} data-water="" data-empty={waterEmpty || undefined}>
          <LiquidOrb share={water ? share(water.cups, water.goal) : 0} mood="water" size={36} />
        </span>
        <span aria-hidden="true" className={`${styles.stack} ${styles.grow}`}>
          <span className={styles.value} data-testid="overview-water">
            {water ? `${waterNumber(water.cups, unit)} / ${formatWater(water.goal, unit)}` : "…"}
          </span>
          <span className={styles.label}>Water</span>
        </span>
        {onAddCup && <Button variant="ghost" size="sm" shape="circle" aria-label="Add a cup of water" onClick={onAddCup}
          className="shrink-0">
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        </Button>}
      </div>

      <div className={styles.healthRow}>
        {health.map((node) => {
          const Icon = node.key === "activity" ? Flame : Moon;
          const offline = node.state === "ready" && body?.offline;
          return <section key={node.key} className={styles.health} aria-label={node.name} data-state={node.state}>
            <span className="sr-only">{`${node.spoken}${offline ? ", from before you went offline" : ""}`}</span>
            <span aria-hidden="true" className={styles.chip}><Icon size={18} strokeWidth={1.8} /></span>
            <AutoHeight spring="gentle" className={styles.grow}>
              <span className={styles.stack}>
                <span aria-hidden="true" className={`${styles.value} ${node.state === "ready" ? "" : styles.quiet}`}>{node.amount}</span>
                <span aria-hidden="true" className={styles.label}>{node.label}</span>
                {node.state === "off" && <a href="/settings" aria-label="Connect health" className={`tap ${styles.connect}`}>
                  <span className={styles.connectPill}>Connect</span>
                </a>}
                {offline && <span aria-hidden="true" className={styles.note}>Saved earlier</span>}
              </span>
            </AutoHeight>
          </section>;
        })}
      </div>
    </section>
  </div>;
}
