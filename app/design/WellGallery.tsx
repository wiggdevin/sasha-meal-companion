"use client";

import { useState, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import CompanionCard, { type CompanionPreview } from "@/components/today/overview/CompanionCard";
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

const SAMPLES: { title: string; data: PanelData; preview: CompanionPreview }[] = [
  { title: "Midday, on track — Sprout thrives", data: day(1020, 80, 110, 34, 4), preview: { hour: 13.5, open: true } },
  { title: "Afternoon, behind — Sprout still fine", data: day(320, 14, 40, 10, 1), preview: { hour: 17, open: true } },
  { title: "Evening, near target — collapsed", data: day(1850, 132, 200, 60, 7), preview: { hour: 19 } },
  { title: "Over target — collapsed", data: day(2350, 150, 260, 82, 8), preview: { hour: 20 } },
  { title: "Sprout's pond, midday", data: day(1020, 80, 110, 34, 4), preview: { hour: 13.5, open: true, pond: true } },
  { title: "Sprout's pond, at night", data: day(1980, 148, 215, 68, 8), preview: { hour: 22.5, open: true, pond: true } },
  { title: "Night — Sprout asleep", data: day(1980, 148, 215, 68, 8), preview: { hour: 22.5, open: true } },
];

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2">
    <h2 className="m-0 text-caption font-semibold text-muted">{title}</h2>
    {children}
  </section>;
}

/** One sample that answers its own taps: a cup or a snack moves only this card's numbers. */
function Live({ data, preview }: { data: PanelData; preview: CompanionPreview }) {
  const [state, setState] = useState(data);
  const addCup = () => setState((d) => ({ ...d, water: d.water && { ...d.water, cups: d.water.cups + 1 } }));
  const eat = () => setState((d) => ({ ...d, consumed: {
    kcal: d.consumed.kcal + SNACK.kcal, protein: d.consumed.protein + SNACK.protein,
    carbs: d.consumed.carbs + SNACK.carbs, fat: d.consumed.fat + SNACK.fat } }));
  return <>
    <CompanionCard data={{ ...state, when: "today" }} mascot="sprout" active preview={preview} />
    <div className="flex gap-2 pt-2">
      <Button variant="secondary" size="sm" onClick={addCup}>Add a cup</Button>
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

/** Every state of the companion row, and the pond's moments, for design review (UI makeover W3). */
export default function WellGallery() {
  return <main className="mx-auto flex max-w-[420px] flex-col gap-6 px-4 py-8">
    <h1 className="m-0 text-title text-charcoal">Companion</h1>
    <Moments />
    {SAMPLES.map((sample) => <Card key={sample.title} title={sample.title}>
      <Live data={sample.data} preview={sample.preview} />
    </Card>)}
  </main>;
}
