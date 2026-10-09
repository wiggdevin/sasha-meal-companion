"use client";

import Button from "@/components/ui/Button";
import { MacroLine } from "@/components/nutrition/MacroText";
import AiLabel from "@/components/ui/AiLabel";
import type { ComposedMeal } from "@/lib/coach/compose";
import { mealProvenance } from "@/lib/coach/message-view";
import type { Provenance } from "@/lib/types";
import { CARD_SUMMARY, MEAL_TITLE } from "@/lib/design/meal-type";

/**
 * One meal idea in the Plan flow: a card inside the meal card's tray (E0, a hairline and no shadow
 * inside the meal card's own). Every figure on it is the idea's own. "Put it in" places it on this
 * slot (its dots run while it saves); "Not this" asks for others.
 */
export default function IdeaCard({ meal, label, busy, placing, onPlace, onSkip, provenance }: {
  meal: ComposedMeal; label: string; busy: boolean; placing: boolean;
  onPlace: () => void; onSkip: () => void;
  /** The turn's provenance, for a card that carries none of its own (PR #373). */
  provenance?: Provenance;
}) {
  return <section className="flex flex-col gap-2 rounded-2xl border border-hairline bg-surface p-4">
    <div className="flex min-w-0 items-start justify-between gap-2">
      <h3 className={`m-0 min-w-0 ${MEAL_TITLE.standard}`}>{meal.wish}</h3>
      <AiLabel provenance={mealProvenance(meal, provenance)} className="mt-0.5" />
    </div>
    <p className="m-0 text-caption text-graphite"><MacroLine values={meal.totals} /></p>
    {(meal.sourceNote || meal.prepMinutes !== undefined) && <p className="m-0 text-caption text-graphite">
      {[meal.sourceNote, meal.prepMinutes !== undefined ? `About ${meal.prepMinutes} min` : null]
        .filter(Boolean).join(" · ")}
    </p>}
    <p className={`m-0 ${CARD_SUMMARY}`}>
      {meal.items.map((item) => `${item.name} ${Math.round(item.grams)} g`).join(" · ")}
    </p>
    <div className="flex min-w-0 gap-2">
      <Button variant="primary" disabled={busy} status={placing ? "pending" : undefined} onClick={onPlace}
        className="min-w-0 flex-1">{`Put it in ${label}`}</Button>
      <Button disabled={busy} onClick={onSkip} aria-label={`Not this: ${meal.wish}`}>Not this</Button>
    </div>
  </section>;
}
