"use client";

import { useState, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import LiveWidget, { type WidgetPreview } from "@/components/today/LiveWidget";
import PondScene from "@/components/today/scene/PondScene";
import { MOMENT_KEYS, type MomentKey } from "@/components/today/scene/moments";
import type { PanelData } from "@/components/today/LiveWidgetPanels";

const TARGETS = { kcal: 2000, protein: 150, carbs: 220, fat: 70 };
const day = (kcal: number, protein: number, carbs: number, fat: number, cups: number): PanelData => ({
  targets: TARGETS, consumed: { kcal, protein, carbs, fat }, partial: false,
  water: { cups, goal: 8, unit: "cups" as const },
});
/** A sample meal for the gallery's "Eat a snack": the reactions without touching any account. */
const SNACK = { kcal: 240, protein: 18, carbs: 22, fat: 8 };

const SAMPLES: { title: string; data: PanelData; preview: WidgetPreview }[] = [
  { title: "Midday, on track — Sprout thrives", data: day(1020, 80, 110, 34, 4), preview: { hour: 13.5, expanded: true, index: 1 } },
  { title: "Afternoon, behind — Sprout a little low", data: day(320, 14, 40, 10, 1), preview: { hour: 17, expanded: true, index: 0 } },
  { title: "Evening, near target — collapsed", data: day(1850, 132, 200, 60, 7), preview: { hour: 19, expanded: false } },
  { title: "Over target — collapsed", data: day(2350, 150, 260, 82, 8), preview: { hour: 20, expanded: false, index: 0 } },
  { title: "Water panel open, content", data: day(900, 50, 100, 30, 3), preview: { hour: 15, expanded: true, index: 2 } },
  { title: "Sprout's pond, midday", data: day(1020, 80, 110, 34, 4), preview: { hour: 13.5, expanded: true, index: 0, panels: ["rings", "kcalLeft", "water"] } },
  { title: "Sprout's pond, behind (sulking)", data: day(320, 14, 40, 10, 1), preview: { hour: 17, expanded: true, index: 0, panels: ["rings", "kcalLeft", "water"] } },
  { title: "Sprout's pond, at night", data: day(1980, 148, 215, 68, 8), preview: { hour: 22.5, expanded: true, index: 0, panels: ["rings", "kcalLeft", "water"] } },
  { title: "Water nearly at goal", data: day(1500, 110, 160, 50, 7), preview: { hour: 18, expanded: true, index: 2 } },
  { title: "Night — Sprout asleep", data: day(1980, 148, 215, 68, 8), preview: { hour: 22.5, expanded: true, index: 1 } },
];

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2">
    <h2 className="m-0 text-caption font-semibold text-muted">{title}</h2>
    <div className="shell">
      <div className="surface flex flex-col py-3">{children}</div>
    </div>
  </section>;
}

/** One sample that answers its own taps: a cup or a snack moves only this card's numbers. */
function Live({ data, preview }: { data: PanelData; preview: WidgetPreview }) {
  const [state, setState] = useState(data);
  const addCup = () => setState((d) => ({ ...d, water: d.water && { ...d.water, cups: d.water.cups + 1 } }));
  const eat = () => setState((d) => ({ ...d, consumed: {
    kcal: d.consumed.kcal + SNACK.kcal, protein: d.consumed.protein + SNACK.protein,
    carbs: d.consumed.carbs + SNACK.carbs, fat: d.consumed.fat + SNACK.fat } }));
  return <>
    <LiveWidget data={{ ...state, onAddCup: addCup }} preview={preview} />
    <div className="flex gap-2 px-3 pt-2">
      <Button variant="secondary" size="sm" onClick={eat}>Eat a snack</Button>
      <Button variant="ghost" size="sm" onClick={() => setState(data)}>Reset</Button>
    </div>
  </>;
}

/** Sprout's moments at the pond, one chosen at a time and replayed every few seconds. */
function Moments() {
  const [demo, setDemo] = useState<MomentKey>("pebble");
  return <section aria-label="Pond moments" className="flex flex-col gap-2">
    <h2 className="m-0 text-caption font-semibold text-muted">Pond moments</h2>
    <div className="matte overflow-hidden rounded-[24px] bg-charcoal-deep px-[14px] pb-[44px]">
      <PondScene key={demo} demo={demo} data={day(1020, 80, 110, 34, 4)}
        pet={{ mood: "content", vitality: 0.7, line: "Sprout is doing fine." }} />
    </div>
    <div className="flex flex-wrap gap-2">
      {MOMENT_KEYS.map((key) => <Button key={key} variant={key === demo ? "primary" : "secondary"} size="sm"
        onClick={() => setDemo(key)}>{key}</Button>)}
    </div>
  </section>;
}

/** Every state of the glass well on its ivory card, for design review (owner, 2026-10-06). */
export default function WellGallery() {
  return <main className="mx-auto flex max-w-[420px] flex-col gap-6 px-4 py-8">
    <h1 className="m-0 text-title text-charcoal">Glass well</h1>
    <Moments />
    {SAMPLES.map((sample) => <Card key={sample.title} title={sample.title}>
      <Live data={sample.data} preview={sample.preview} />
    </Card>)}
  </main>;
}
