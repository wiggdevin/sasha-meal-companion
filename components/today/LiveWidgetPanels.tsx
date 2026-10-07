"use client";

import Button from "@/components/ui/Button";
import type { ReactNode } from "react";
import Ring from "@/components/today/island/Ring";
import LiquidRings, { type RingDatum } from "@/components/today/island/LiquidRings";
import ringStyles from "@/components/today/island/LiquidRings.module.css";
import { RebalanceBubble, RebalanceCompact, RebalanceFull, rebalanceSpoken }
  from "@/components/today/RebalancePanelFace";
import { GRAM_MACROS, MACRO_SPEC, formatMacro, type MacroKey } from "@/components/nutrition/spec";
import { balanceBound, boundWords, eatenBound, withBound } from "@/lib/nutrition-display";
import { formatWater, formatWaterOf, waterNumber } from "@/lib/water-units";
import type { OrbitWater } from "@/lib/today/health-orbit";
import type { RebalancePanel } from "@/lib/rebalance/panel";
import type { WidgetPanel } from "@/lib/today/widget-prefs";
import type { Macros, SlotId } from "@/lib/types";
import styles from "@/components/today/island/Island.module.css";

export type PanelData = {
  targets: Macros; consumed: Macros;
  /** A partly measured recipe serving in the day: left is "at most", eaten "at least" (#21). */
  partial: boolean;
  water?: OrbitWater;
  onAddCup?: () => void;
  /** Phase 19 R2: the "Rebalance my day" panel, gated off by default (lib/rebalance/panel-client.ts). */
  rebalance?: RebalancePanel;
  /** UI-owned: takes the user to a card's slot on Today. Never a writer. */
  onOpenSlot?: (slot: SlotId) => void;
};

const FIELD: Record<MacroKey, keyof Macros> = { kcal: "kcal", protein: "protein", carbs: "carbs", fat: "fat" };

/** What is left of one target, or how far past it the day has gone. */
export function balance(key: MacroKey, { targets, consumed }: Pick<PanelData, "targets" | "consumed">) {
  const diff = Math.round(targets[FIELD[key]] - consumed[FIELD[key]]);
  return { amount: Math.abs(diff), over: diff < 0 };
}

export const share = (value: number, target: number) => (target > 0 ? Math.max(0, Math.min(1, value / target)) : 0);

/** The rings a rings view draws, outermost first: calories and the three macros, or the macros only. */
export function ringKeys(panel: "rings" | "macroRings"): MacroKey[] {
  return panel === "rings" ? ["kcal", ...GRAM_MACROS] : [...GRAM_MACROS];
}
const ringData = (panel: "rings" | "macroRings", data: PanelData): RingDatum[] =>
  ringKeys(panel).map((key) => ({ key, share: share(data.consumed[FIELD[key]], data.targets[FIELD[key]]) }));

/** One ring in words: "1,500 kcal left" or "90 grams protein left". */
function ringSpoken(key: MacroKey, data: PanelData): string {
  const { amount, over } = balance(key, data);
  const bound = balanceBound(data.partial, over);
  return key === "kcal"
    ? `${withBound(`${formatMacro(amount)} kcal`, bound)} ${over ? "over" : "left"}`
    : `${withBound(`${formatMacro(amount)} grams`, bound)} ${MACRO_SPEC[key].label.toLowerCase()} ${over ? "over" : "left"}`;
}

/** The island's glow: under target, within the last tenth of it, or past it. */
export function dayMood({ targets, consumed }: Pick<PanelData, "targets" | "consumed">): "under" | "near" | "over" {
  if (consumed.kcal > targets.kcal) return "over";
  return targets.kcal > 0 && consumed.kcal >= targets.kcal * 0.9 ? "near" : "under";
}

const eatenWords = (partial: boolean) => (partial ? boundWords(eatenBound(true)) : "");

/** The panel's one line: what the collapsed widget says, and what a screen reader hears for it. */
export function panelSpoken(panel: WidgetPanel, data: PanelData): string {
  const kcal = balance("kcal", data);
  switch (panel) {
    case "kcalLeft":
      return `${withBound(`${formatMacro(kcal.amount)} kcal`, balanceBound(data.partial, kcal.over))} ${kcal.over ? "over" : "left of"} ${formatMacro(data.targets.kcal)}`;
    case "kcalEaten":
      return `${withBound(`${formatMacro(data.consumed.kcal)} kcal`, data.partial ? eatenBound(true) : undefined)} eaten of ${formatMacro(data.targets.kcal)}`;
    case "macros":
      return GRAM_MACROS.map((key) => {
        const { amount, over } = balance(key, data);
        return `${withBound(`${formatMacro(amount)} grams`, balanceBound(data.partial, over))} ${MACRO_SPEC[key].label.toLowerCase()} ${over ? "over" : "left"}`;
      }).join(", ");
    case "rings":
    case "macroRings":
      return ringKeys(panel).map((key) => ringSpoken(key, data)).join(", ");
    case "water":
      return data.water ? `Water: ${formatWaterOf(data.water.cups, data.water.goal, data.water.unit ?? "cups")}` : "Water: loading";
    case "rebalance":
      return rebalanceSpoken(data.rebalance);
  }
}

/** Collapsed: the panel's headline beside the orb. */
export function CompactPanel({ panel, data }: { panel: WidgetPanel; data: PanelData }) {
  const kcal = balance("kcal", data);
  switch (panel) {
    case "rings":
    case "kcalLeft": {
      const bound = boundWords(balanceBound(data.partial, kcal.over));
      return <span className={styles.compactLine}>
        {bound && <span className={styles.word}>{bound}</span>}
        <span className={`${styles.numeral} macro-ink-kcal`}>{formatMacro(kcal.amount)}</span>
        <span className={styles.word}>kcal {kcal.over ? "over" : "left"}</span>
      </span>;
    }
    case "kcalEaten":
      return <span className={styles.compactLine}>
        {data.partial && <span className={styles.word}>{eatenWords(true)}</span>}
        <span className={`${styles.numeral} macro-ink-kcal`}>{formatMacro(data.consumed.kcal)}</span>
        <span className={styles.word}>kcal eaten</span>
      </span>;
    case "macroRings":
    case "macros": {
      // Collapsed, the one macro the plan never moves: protein (AGENTS.md). Open, all three.
      const protein = balance("protein", data);
      const bound = boundWords(balanceBound(data.partial, protein.over));
      return <span className={styles.compactLine}>
        {bound && <span className={styles.word}>{bound}</span>}
        <span className={`${styles.numeral} ${MACRO_SPEC.protein.ink}`}>{formatMacro(protein.amount)}g</span>
        <span className={styles.abbr}>{MACRO_SPEC.protein.abbr}</span>
        <span className={styles.word}>{protein.over ? "over" : "left"}</span>
      </span>;
    }
    case "water":
      return <span className={styles.compactLine}>
        <span className={styles.numeral}>{data.water ? waterNumber(data.water.cups, data.water.unit ?? "cups") : "…"}</span>
        <span className={styles.word}>{data.water ? `of ${formatWater(data.water.goal, data.water.unit ?? "cups")}` : "water"}</span>
      </span>;
    case "rebalance":
      return <RebalanceCompact panel={data.rebalance} />;
  }
}

/** A bubble beside the island: the panel at a glance, as a ring. */
export function BubbleFace({ panel, data }: { panel: WidgetPanel; data: PanelData }) {
  switch (panel) {
    case "kcalLeft":
    case "kcalEaten":
      return <Ring share={share(data.consumed.kcal, data.targets.kcal)} size={46} stroke={3} colorClass={styles.arcOnJelly}>
        <span className={styles.bubbleText}>{Math.round(share(data.consumed.kcal, data.targets.kcal) * 100)}%</span>
        <span className={styles.bubbleSub}>{MACRO_SPEC.kcal.abbr}</span>
      </Ring>;
    case "macros":
      return <Ring share={share(data.consumed.protein, data.targets.protein)} size={46} stroke={3}
        colorClass={styles.arcOnJelly}>
        <span className={styles.bubbleText}>{formatMacro(balance("protein", data).amount)}g</span>
        <span className={styles.bubbleSub}>{MACRO_SPEC.protein.abbr}</span>
      </Ring>;
    case "rings":
    case "macroRings":
      return <LiquidRings rings={ringData(panel, data)} size={38} mini />;
    case "water":
      return <Ring share={data.water ? share(data.water.cups, data.water.goal) : 0} size={46} stroke={3}
        colorClass={styles.arcOnJelly}>
        <span className={styles.bubbleText}>{data.water ? data.water.cups : "…"}</span>
        <span className={styles.bubbleSub}>cups</span>
      </Ring>;
    case "rebalance":
      return <RebalanceBubble panel={data.rebalance} />;
  }
}

/** Expanded: the panel's readings inside the island, risen through the glass. `centre` stands in the
 *  middle of a rings view (Sprout). */
export function FullPanel({ panel, data, centre }: { panel: WidgetPanel; data: PanelData; centre?: ReactNode }) {
  const kcal = balance("kcal", data);
  switch (panel) {
    case "kcalLeft":
    case "kcalEaten": {
      const left = panel === "kcalLeft";
      const bound = left ? boundWords(balanceBound(data.partial, kcal.over)) : eatenWords(data.partial);
      return <div className={styles.kcalPanel} aria-hidden="true">
        <Ring share={share(data.consumed.kcal, data.targets.kcal)} size={88} stroke={7} colorClass={styles.arcKcal}>
          <span className={styles.ringPct}>{Math.round(share(data.consumed.kcal, data.targets.kcal) * 100)}%</span>
          <span className={styles.ringSub}>eaten</span>
        </Ring>
        <span className="flex min-w-0 flex-col gap-1">
          <span className={styles.heroLine}>
            {bound && <span className={styles.word}>{bound}</span>}
            <span className={`${styles.hero} macro-ink-kcal`}>{formatMacro(left ? kcal.amount : data.consumed.kcal)}</span>
          </span>
          <span className={styles.word}>{left ? `kcal ${kcal.over ? "over" : "left"}` : "kcal eaten"}</span>
          <span className={styles.meta}>
            {eatenWords(data.partial) ? `${eatenWords(data.partial)} ` : ""}{formatMacro(data.consumed.kcal)} eaten of {formatMacro(data.targets.kcal)}
          </span>
        </span>
      </div>;
    }
    case "macros":
      return <ul className={styles.rings} aria-hidden="true">
        {GRAM_MACROS.map((key) => {
          const { amount, over } = balance(key, data);
          const bound = boundWords(balanceBound(data.partial, over));
          return <li key={key} className={styles.ringItem}>
            <Ring share={share(data.consumed[FIELD[key]], data.targets[FIELD[key]])} size={64} stroke={6}
              colorClass={`${MACRO_SPEC[key].fill} ${styles.arcCurrent}`}>
              <span className={`${styles.figure} ${MACRO_SPEC[key].ink}`}>{formatMacro(amount)}g</span>
            </Ring>
            <span className={styles.abbr}>{MACRO_SPEC[key].abbr}</span>
            <span className={styles.word}>{bound ? `${bound} ` : ""}{over ? "over" : "left"}</span>
          </li>;
        })}
      </ul>;
    case "water": {
      const water = data.water;
      const unit = water?.unit ?? "cups";
      return <div className={styles.waterPanel}>
        <Ring share={water ? share(water.cups, water.goal) : 0} size={72} stroke={6} colorClass={styles.arcWater}>
          <span className={styles.waterFigure} aria-hidden="true">{water ? waterNumber(water.cups, unit) : "…"}</span>
        </Ring>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5" aria-hidden="true">
          <span className={styles.word}>{water ? `of ${formatWater(water.goal, unit)}` : "Water"}</span>
          {water && <span className={styles.meta}>
            {water.cups >= water.goal ? "Goal reached" : `${formatWater(water.goal - water.cups, unit)} to go`}
          </span>}
        </span>
        {data.onAddCup && <Button variant="secondary" size="sm" onClick={data.onAddCup} className={styles.cup}>
          Add a cup
        </Button>}
      </div>;
    }
    case "rings":
    case "macroRings":
      return <div className={ringStyles.ringsPanel}>
        <LiquidRings rings={ringData(panel, data)} size={panel === "rings" ? 232 : 216}>
          {centre && <span className={ringStyles.pet}>{centre}</span>}
        </LiquidRings>
        <ul className={`${ringStyles.rings} ${ringStyles.legend}`} aria-hidden="true">
          {ringKeys(panel).map((key) => {
            const { amount, over } = balance(key, data);
            return <li key={key} data-macro={key} className={ringStyles.legendItem}>
              <span className={ringStyles.legendDot} />
              <span className={ringStyles.legendFigure}>{formatMacro(amount)}{key === "kcal" ? "" : "g"}</span>
              <span>{MACRO_SPEC[key].abbr} {over ? "over" : "left"}</span>
            </li>;
          })}
        </ul>
      </div>;
    case "rebalance":
      return <RebalanceFull panel={data.rebalance} onOpenSlot={data.onOpenSlot} />;
  }
}
