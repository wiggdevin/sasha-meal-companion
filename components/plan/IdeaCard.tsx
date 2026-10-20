"use client";

import Button from "@/components/ui/Button";
import { MacroLine } from "@/components/nutrition/MacroText";
import AiLabel from "@/components/ui/AiLabel";
import type { ComposedMeal } from "@/lib/coach/compose";
import { mealProvenance } from "@/lib/coach/message-view";
import type { Provenance } from "@/lib/types";
import { CARD_SUMMARY, MEAL_TITLE } from "@/lib/design/meal-type";

/** A card in the Plan flow, inside the meal card's beige tray: the CardFrame small face at E0 (12 px
 *  padding, 16 px corners, ivory, the card hairline, no drop; UI makeover §3.3). Shared with the
 *  photo and document results. Not a `.surface`: inside the meal card's own surface the legacy
 *  nested-card step would turn it beige on the beige tray, and it must stand off the tray. */
export const PLAN_CARD = "card-sm card-ivory card-e0 flex min-w-0 flex-col border";

/**
 * One meal idea in the Plan flow: a small card inside the meal card's tray (the CardFrame sm face at
 * E0: ivory on the beige tray, the card hairline and no shadow inside the meal card's own). One title,
 * where it came from as its one line, the figures and the portions, two actions. Every figure on it
 * is the idea's own. "Put it in" places it on this slot (its dots run while it saves); "Not this"
 * asks for others.
 */
export default function IdeaCard({ meal, label, busy, placing, onPlace, onSkip, provenance }: {
  meal: ComposedMeal; label: string; busy: boolean; placing: boolean;
  onPlace: () => void; onSkip: () => void;
  /** The turn's provenance, for a card that carries none of its own (PR #373). */
  provenance?: Provenance;
}) {
  return <section className={PLAN_CARD}>
    <div className="flex min-w-0 items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className={`m-0 min-w-0 ${MEAL_TITLE.standard}`}>{meal.wish}</h3>
        {meal.sourceNote && <p className="m-0 truncate text-caption text-muted">{meal.sourceNote}</p>}
      </div>
      <AiLabel provenance={mealProvenance(meal, provenance)} className="mt-0.5" />
    </div>
    <p className="m-0 text-caption text-graphite"><MacroLine values={meal.totals} />
      {meal.prepMinutes !== undefined && ` · About ${meal.prepMinutes} min`}</p>
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
