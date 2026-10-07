"use client";

import Button from "@/components/ui/Button";
import Ring from "@/components/today/island/Ring";
import LiquidOrb from "@/components/today/island/LiquidOrb";
import { GRAM_MACROS, MACRO_SPEC, formatMacro } from "@/components/nutrition/spec";
import { balance, dayMood, share, type PanelData } from "@/components/today/LiveWidgetPanels";
import { balanceBound, boundWords, eatenBound, withBound } from "@/lib/nutrition-display";
import { orbitNodes, type OrbitBody } from "@/lib/today/health-orbit";
import { formatWater, formatWaterOf, waterNumber } from "@/lib/water-units";
import ring from "@/components/today/island/Island.module.css";
import styles from "@/components/today/DayOverview.module.css";

/**
 * The Day card's Overview face (owner, 2026-10-05: "completely redesign … get rid of all of the images
 * or icons … viewed as if we were looking at it through liquid glass", then "more alive"; KIT §15).
 * It replaced the health orbit. Glass wells on the ivory card, read top to bottom: the day's calories
 * as a ring around what was eaten, with what is left; protein, carbs and fat as three rings; water as a
 * living liquid bead with Add a cup; active burn and recovery, which say "Off" and offer to connect
 * when the body source is off — never an unmeasured zero — and say when a reading is from before the
 * phone went offline. The rings draw on the bouncy spring and the bead breathes, like the island.
 */
export default function DayOverview({ data, body }: { data: PanelData; body?: OrbitBody }) {
  const { targets, consumed, partial, water, onAddCup } = data;
  const kcal = balance("kcal", data);
  const nodes = orbitNodes({ targets, consumed, water, body, partial });
  const health = nodes.filter((node) => node.key === "activity" || node.key === "recovery");
  const eatenWord = partial ? boundWords(eatenBound(true)) : "";
  const leftWord = boundWords(balanceBound(partial, kcal.over));
  const unit = water?.unit ?? "cups";
  return <div className={styles.overview}>
    <section className={`glass-well ${styles.well} ${styles.kcalWell}`} aria-label="Calories" data-mood={dayMood(data)}>
      <span className="sr-only">{`${withBound(`${formatMacro(consumed.kcal)} kcal`, partial ? eatenBound(true) : undefined)} eaten of ${formatMacro(targets.kcal)}. ${withBound(`${formatMacro(kcal.amount)} kcal`, balanceBound(partial, kcal.over))} ${kcal.over ? "over" : "left"}.`}</span>
      <Ring share={share(consumed.kcal, targets.kcal)} size={112} stroke={9} colorClass={ring.arcKcal} onLight>
        <span aria-hidden="true" className={styles.ringStack}>
          {eatenWord && <span className={styles.word}>{eatenWord}</span>}
          <span className={`${styles.hero} macro-ink-kcal`}>{formatMacro(consumed.kcal)}</span>
          <span className={styles.label}>Eaten</span>
        </span>
      </Ring>
      <span aria-hidden="true" className={styles.kcalSide}>
        <span className={styles.label}>{kcal.over ? "Over" : "Left"}</span>
        <span className={styles.big}>{leftWord && <span className={styles.word}>{leftWord} </span>}{formatMacro(kcal.amount)}</span>
        <span className={styles.word}>of {formatMacro(targets.kcal)} kcal</span>
      </span>
    </section>

    <section className={`glass-well ${styles.well}`} aria-label="Protein, carbs and fat">
      <ul className={styles.macros}>
        {GRAM_MACROS.map((key) => {
          const { over } = balance(key, data);
          const word = partial ? boundWords(eatenBound(true)) : "";
          return <li key={key} className={styles.macro}>
            <span className="sr-only">{`${MACRO_SPEC[key].label}: ${withBound(`${formatMacro(consumed[key])} grams`, partial ? eatenBound(true) : undefined)} of ${formatMacro(targets[key])}${over ? ", over" : ""}`}</span>
            <Ring share={share(consumed[key], targets[key])} size={72} stroke={6} onLight
              colorClass={`${MACRO_SPEC[key].fill} ${ring.arcCurrent}`}>
              <span aria-hidden="true" className={`${styles.figure} ${MACRO_SPEC[key].ink}`}>{formatMacro(consumed[key])}</span>
            </Ring>
            <span aria-hidden="true" className={styles.label}>{MACRO_SPEC[key].label}</span>
            <span aria-hidden="true" className={styles.word}>{word ? `${word} · ` : ""}of {formatMacro(targets[key])}g</span>
          </li>;
        })}
      </ul>
    </section>

    <section className={`glass-well ${styles.well} ${styles.waterWell}`} aria-label="Water">
      <span className="sr-only">{water ? `Water: ${formatWaterOf(water.cups, water.goal, unit)}` : "Water: loading"}</span>
      <span className={styles.waterBead} data-water="">
        <LiquidOrb share={water ? share(water.cups, water.goal) : 0} mood="water" size={56} />
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={styles.label}>Water</span>
        <span className={styles.macroLine}>
          <span className={styles.big}>{water ? waterNumber(water.cups, unit) : "…"}</span>
          {water && <span className={styles.word}>of {formatWater(water.goal, unit)}</span>}
        </span>
      </span>
      {onAddCup && <Button variant="secondary" size="sm" onClick={onAddCup} className="shrink-0">Add a cup</Button>}
    </section>

    <div className={styles.healthRow}>
      {health.map((node) => <section key={node.key} className={`glass-well ${styles.well} ${styles.healthWell}`}
        aria-label={node.name} data-state={node.state}>
        <span className="sr-only">{`${node.spoken}${node.state === "ready" && body?.offline ? ", from before you went offline" : ""}`}</span>
        <span aria-hidden="true" className={styles.label}>{node.label}</span>
        <span aria-hidden="true" className={`${styles.big} ${node.state === "ready" ? "" : styles.quiet}`}>{node.amount}</span>
        {node.state === "ready" && body?.offline && <span aria-hidden="true" className={styles.word}>Saved earlier</span>}
        {node.state === "off" && <a href="/settings" className={`tap ${styles.connect}`}>Connect health</a>}
      </section>)}
    </div>
  </div>;
}
