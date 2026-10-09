"use client";

import { APP_NAME } from "@/lib/brand";
import { useRef, useState } from "react";
import Button from "@/components/ui/Button";
import TourDemo from "@/components/tour/TourDemos";
import TourLayer, { type TourOpening } from "@/components/tour/TourLayer";
import { TOUR_STEPS } from "@/components/tour/tour-steps";

/** The overview opened as Today opens it, then each step's demo playing and as its still frame. */
export default function TourGallery() {
  const [opening, setOpening] = useState<TourOpening | null>(null);
  const seq = useRef(0);
  const open = (target: HTMLElement | null) => setOpening({
    origin: target?.getBoundingClientRect() ?? null, returnFocusTo: target, seq: ++seq.current,
  });
  return <main className="mx-auto flex max-w-[420px] flex-col gap-6 px-4 py-8">
    <h1 className="m-0 text-title text-charcoal">{`How ${APP_NAME} works`}</h1>
    <Button variant="primary" className="self-start" onClick={(e) => open(e.currentTarget)}>Open the overview</Button>
    {TOUR_STEPS.map((step) => <section key={step.id} aria-label={step.title} className="flex flex-col gap-2">
      <h2 className="m-0 text-caption font-semibold text-muted">{step.title}</h2>
      <TourDemo kind={step.id} reduce={false} />
      <h3 className="m-0 text-tiny text-muted">Still frame (reduced motion)</h3>
      <TourDemo kind={step.id} reduce />
    </section>)}
    <TourLayer opening={opening} onClose={() => setOpening(null)} />
  </main>;
}
