"use client";
/**
 * Every Day card Overview face state on static sample data (app/design/day-overview; cards v4, brief
 * 2026-10-08 §4). No network, no device store: each face is mounted with fixture props alone, inside
 * the same shell and ivory surface the Day card gives it, so the states can be reviewed and
 * screenshotted at phone width without an account.
 */
import { useState, type ReactNode } from "react";
import DayOverview from "@/components/today/DayOverview";
import type { PanelData } from "@/components/today/LiveWidgetPanels";
import type { OrbitBody, OrbitWater } from "@/lib/today/health-orbit";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { Macros } from "@/lib/types";

const m = (kcal: number, protein: number, carbs: number, fat: number): Macros => ({ kcal, protein, carbs, fat });
const TARGETS = m(1900, 150, 190, 60);

const ROW: DailyHealthRow = {
  local_date: "2026-10-08", steps: 6400, active_kcal: 420, sleep_minutes: 452, body_mass_kg: null,
  sources: ["oura"], resting_heart_rate: null, hrv_sdnn: null, readiness_score: null, provenance: {},
};
const BODY: Record<"loading" | "off" | "ready" | "offline", OrbitBody> = {
  loading: { capability: "enabled", loading: true, row: null, offline: false, fetchedAt: null },
  off: { capability: "disabled", loading: false, row: null, offline: false, fetchedAt: null },
  ready: { capability: "enabled", loading: false, row: ROW, offline: false, fetchedAt: "2026-10-08T07:00:00Z" },
  offline: { capability: "enabled", loading: false, row: ROW, offline: true, fetchedAt: "2026-10-08T07:00:00Z" },
};

type Fixture = {
  title: string; note: string; consumed: Macros; partial?: boolean;
  water: OrbitWater | undefined; body: OrbitBody | undefined; addCup: boolean;
};

const FIXTURES: Fixture[] = [
  { title: "Fresh day", note: "Nothing eaten: the ring is full. Water at zero, empty bead. Body ready.",
    consumed: m(0, 0, 0, 0), water: { cups: 0, goal: 8 }, body: BODY.ready, addCup: true },
  { title: "Partial day", note: "Some eaten, some water, body ready.",
    consumed: m(1140, 82, 104, 36), water: { cups: 4, goal: 8 }, body: BODY.ready, addCup: true },
  { title: "Over budget", note: "Over, persimmon never red. Water full.",
    consumed: m(2240, 162, 214, 78), water: { cups: 8, goal: 8 }, body: BODY.ready, addCup: true },
  { title: "Partly measured", note: "A partly measured serving: at most left, at least eaten.",
    consumed: m(980, 70, 96, 30), partial: true, water: { cups: 3, goal: 8, unit: "oz" }, body: BODY.ready, addCup: true },
  { title: "Water loading, body loading", note: "Water not read yet; body source still reading.",
    consumed: m(640, 40, 70, 20), water: undefined, body: BODY.loading, addCup: true },
  { title: "Body off", note: "Body data switched off: Off with Connect, never a zero.",
    consumed: m(1140, 82, 104, 36), water: { cups: 2, goal: 8 }, body: BODY.off, addCup: true },
  { title: "Body ready, offline", note: "A reading from before the phone went offline.",
    consumed: m(1140, 82, 104, 36), water: { cups: 5, goal: 8 }, body: BODY.offline, addCup: true },
  { title: "No writer", note: "A past day: no Add a cup.",
    consumed: m(1820, 140, 180, 58), water: { cups: 6, goal: 8 }, body: BODY.ready, addCup: false },
];

function Block({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <section aria-label={title} data-gallery-card={title} className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5 px-1">
      <h2 className="m-0 text-heading-sm font-semibold text-charcoal">{title}</h2>
      <p className="m-0 text-tiny text-muted">{note}</p>
    </div>
    {children}
  </section>;
}

function GalleryFace({ fixture }: { fixture: Fixture }) {
  const [water, setWater] = useState(fixture.water);
  const data: PanelData = {
    targets: TARGETS, consumed: fixture.consumed, partial: fixture.partial ?? false, water,
    onAddCup: fixture.addCup && water ? () => setWater({ ...water, cups: water.cups + 1 }) : undefined,
  };
  return <div className="shell"><div className="surface">
    <DayOverview data={data} body={fixture.body} />
  </div></div>;
}

export default function DayOverviewGallery() {
  return <main className="harvest-ground mx-auto flex min-h-dvh w-full max-w-md flex-col gap-8 px-4 py-6">
    <h1 className="m-0 font-display text-heading text-charcoal">Day overview</h1>
    {FIXTURES.map((fixture) => <Block key={fixture.title} title={fixture.title} note={fixture.note}>
      <GalleryFace fixture={fixture} />
    </Block>)}
  </main>;
}
