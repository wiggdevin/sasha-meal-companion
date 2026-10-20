"use client";
/**
 * The nutrition display system on one page (owner, 2026-10-04): every form a calorie or macro can take
 * (text, icon, graph), the diet badges and recipe facets, and the recipe-card layouts built from them.
 * Development only (app/design/nutrition/page.tsx).
 */
import { useState, type ReactNode } from "react";
import { ArrowLeftRight } from "lucide-react";
import DietBadge from "@/components/nutrition/DietBadge";
import MacroIcon from "@/components/nutrition/MacroIcon";
import RecipeFacets from "@/components/nutrition/RecipeFacets";
import { MacroBars, MacroDonut, MacroGauge, MacroMeter, MacroSplit } from "@/components/nutrition/charts";
import { MacroFigure, MacroLine, ProteinShort } from "@/components/nutrition/MacroText";
import SummaryRow from "@/components/today/overview/SummaryRow";
import { FullPanel } from "@/components/today/LiveWidgetPanels";
import { MACROS, energySplit, type MacroValues } from "@/components/nutrition/spec";
import type { DietFact } from "@/lib/recipes-hub/diet";
import RecipeResultCard from "@/components/RecipeResultCard";
import { GALLERY_RECIPE } from "@/app/design/gallery-fixtures";

const SERVING: MacroValues = { kcal: 508, protein: 51, carbs: 44, fat: 13 };
const EATEN: MacroValues = { kcal: 640, protein: 48, carbs: 70, fat: 20 };
const TARGETS = { kcal: 1891, protein: 195, carbs: 154, fat: 55 };
const DAY: MacroValues = { kcal: 1148, protein: 99, carbs: 114, fat: 33 };
const FACTS: DietFact[] = ["high-protein", "vegetarian", "vegan", "gluten-free", "dairy-free", "contains-gluten", "contains-dairy"];
const FACETS = { cuisine: "American", minutes: 25, servings: 3 };

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-3">
    <div className="flex flex-col gap-0.5 px-1">
      <h2 className="m-0 text-heading-sm font-semibold text-charcoal">{title}</h2>
      {note && <p className="m-0 text-tiny text-muted">{note}</p>}
    </div>
    {children}
  </section>;
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-2">
    <span className="px-1 text-overline uppercase tracking-[0.08em] text-muted">{label}</span>
    <div className="shell"><div className="surface flex flex-col gap-3 p-4">{children}</div></div>
  </div>;
}

function Title({ kcal }: { kcal?: boolean }) {
  return <div className="flex items-start justify-between gap-3">
    <h3 className="m-0 font-display text-heading text-charcoal">Chicken, carrot and quinoa skillet</h3>
    {kcal && <span className="flex shrink-0 flex-col items-end leading-none">
      <span className="kcal font-display text-heading font-medium tabular-nums">508</span>
      <span className="mt-1 text-overline uppercase tracking-[0.1em] text-muted">kcal</span>
    </span>}
  </div>;
}

function Toggle({ day, onToggle, children }: { day: boolean; onToggle: () => void; children: ReactNode }) {
  return <button type="button" aria-pressed={day} onClick={onToggle}
    className="tap flex w-full flex-col gap-2 rounded-2xl bg-fog p-3 text-left">
    <span className="flex w-full items-center justify-between">
      <span className="eyebrow text-muted">{day ? "Your day after this" : "Per serving"}</span>
      <span className="flex items-center gap-1 text-tiny font-medium text-graphite">
        <ArrowLeftRight size={13} strokeWidth={1.6} aria-hidden="true" />{day ? "Per serving" : "Your day"}</span>
    </span>
    {children}
  </button>;
}

/** A: today's strip, tightened — smaller facets, four columns of figure and bar. */
function OptionA() {
  const [day, setDay] = useState(false);
  const values = day ? DAY : SERVING;
  return <Card label="A · Tightened strip">
    <Title />
    <RecipeFacets {...FACETS} />
    <Toggle day={day} onToggle={() => setDay(!day)}>
      <span className="grid w-full grid-cols-4 gap-3">
        {MACROS.map((key) => <span key={key} className="flex min-w-0 flex-col gap-1">
          <MacroFigure macro={key} value={values[key]} label="abbr" className="text-caption" />
          <MacroMeter macro={key} amount={day ? values[key]! / TARGETS[key]
            : key === "kcal" ? 1 : (energySplit(values)?.[key] ?? 0)} />
        </span>)}
      </span>
    </Toggle>
  </Card>;
}

/** B: a donut carries the calories and the split; the three macros sit beside it as bars. */
function OptionB() {
  const [day, setDay] = useState(false);
  return <Card label="B · Donut and bars">
    <Title />
    <div className="flex flex-wrap items-center gap-1.5">
      <RecipeFacets {...FACETS} />
      <DietBadge fact="high-protein" variant="icon" />
    </div>
    <Toggle day={day} onToggle={() => setDay(!day)}>
      <span className="flex w-full items-center gap-4">
        <MacroDonut values={day ? DAY : SERVING} target={day ? TARGETS.kcal : undefined} size={68}
          center={day ? <span className="flex flex-col items-center gap-0.5">
            <span className="kcal text-body-md font-semibold tabular-nums">1,148</span>
            <span className="text-overline text-muted">of 1,891</span></span> : undefined} />
        <MacroBars values={day ? DAY : SERVING} targets={day ? TARGETS : null} />
      </span>
    </Toggle>
  </Card>;
}

/** C: calories move up beside the title; one line of icon figures, gauges on the day side. */
function OptionC() {
  const [day, setDay] = useState(false);
  return <Card label="C · Calories in the title row">
    <Title kcal />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <RecipeFacets {...FACETS} variant="line" />
      <DietBadge fact="high-protein" variant="icon" />
    </div>
    <Toggle day={day} onToggle={() => setDay(!day)}>
      {day ? <span className="flex w-full justify-between">
        {MACROS.map((key) => <MacroGauge key={key} macro={key} value={DAY[key]} target={TARGETS[key]} size={58} />)}
      </span> : <span className="flex w-full flex-col gap-2">
        <MacroLine values={SERVING} label="icon" only={["protein", "carbs", "fat"]} className="text-caption" />
        <MacroSplit values={SERVING} />
      </span>}
    </Toggle>
  </Card>;
}

export default function NutritionGallery() {
  return <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 pb-10">
    <h1 className="m-0 text-display font-light leading-none tracking-tight text-charcoal">Nutrition</h1>

    <Block title="Text" note="Figure bold in its ink, unit tight, label quiet. Spoken in full.">
      <Card label="Labels: abbr · word · letter · icon">
        <MacroLine values={SERVING} label="abbr" />
        <MacroLine values={SERVING} label="word" />
        <MacroLine values={SERVING} label="letter" />
        <MacroLine values={SERVING} label="icon" />
      </Card>
      <Card label="Partial counts · at least, at most (#21)">
        <MacroLine values={SERVING} bound="at-least" />
        <span className="text-tiny"><MacroFigure macro="kcal" value={743} bound="at-most" /> left</span>
        <span className="text-tiny"><ProteinShort gap={-12.4} /></span>
      </Card>
      <Card label="Overview · partly measured day">
        <SummaryRow targets={TARGETS} consumed={{ kcal: 1951, protein: 120, carbs: 160, fat: 30 }} partial />
      </Card>
      <Card label="Day widget · partly measured day">
        <div className="matte glass-floor p-2">
          <FullPanel panel="kcalLeft" data={{ targets: TARGETS, consumed: { kcal: 651, protein: 120, carbs: 160, fat: 30 }, partial: true }} />
        </div>
      </Card>
    </Block>

    <Block title="Icons" note="Macros as the orbit's food forms; diet facts as glyphs.">
      <Card label="Macro icons">
        <span className="flex items-center gap-4">{MACROS.map((key) => <MacroIcon key={key} macro={key} size={22} />)}</span>
      </Card>
      <Card label="Diet badges · label and icon">
        <span className="flex flex-wrap gap-1.5">{FACTS.map((fact) => <DietBadge key={fact} fact={fact} />)}</span>
        <span className="flex flex-wrap gap-1.5">{FACTS.map((fact) => <DietBadge key={fact} fact={fact} variant="icon" />)}</span>
      </Card>
    </Block>

    <Block title="Graphs" note="Split of a serving's calories, or progress against the day's targets.">
      <Card label="Donut · split and progress">
        <span className="flex items-center gap-6">
          <MacroDonut values={SERVING} />
          <MacroDonut values={DAY} target={TARGETS.kcal} />
          <MacroDonut values={SERVING} size={44} thickness={6} center={<span />} />
        </span>
      </Card>
      <Card label="Bars · horizontal (split, then day)">
        <MacroBars values={SERVING} />
        <MacroBars values={DAY} targets={TARGETS} only={MACROS} />
      </Card>
      <Card label="Bars · vertical (day)">
        <MacroBars values={DAY} targets={TARGETS} orientation="vertical" only={MACROS} />
      </Card>
      <Card label="Half-circle gauges (day)">
        <span className="flex justify-between">{MACROS.map((key) =>
          <MacroGauge key={key} macro={key} value={DAY[key]} target={TARGETS[key]} />)}</span>
      </Card>
    </Block>

    <Block title="Recipe facets" note="Cuisine olive, time slate, servings rosewood: apart from the macro hues.">
      <Card label="Pill and line">
        <RecipeFacets {...FACETS} />
        <RecipeFacets {...FACETS} variant="line" />
      </Card>
    </Block>

    <Block title="Adopted" note="A + C hybrid after the Kimi K3 review: calories in the title row, facets as one line, three macro columns whose bars all mean progress toward the day.">
      <RecipeResultCard recipe={GALLERY_RECIPE} expanded onExpandedChange={() => {}} />
    </Block>

    <Block title="Recipe card" note="Three ways to lay out the same facts. Tap the nutrition to see the day.">
      <OptionA />
      <OptionB />
      <OptionC />
    </Block>
    <p className="m-0 text-tiny text-muted">Day after this: {EATEN.kcal} eaten + {SERVING.kcal} serving.</p>
  </main>;
}
