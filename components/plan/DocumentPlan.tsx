"use client";
/**
 * What the Plan panel shows after an uploaded meal plan: a compact preview of its days and meals,
 * the meal matched to this slot with the foods that will be placed and the ones left out (never
 * guessed), and one "Use for this meal" button. Nothing writes until that tap. A plan with more
 * than one day says a whole-plan import is coming. Shown in place, inside the panel.
 */
import type { DocumentPlanResult } from "@/lib/plan/document-types";
import { MacroLine } from "@/components/nutrition/MacroText";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";
import AiLabel from "@/components/ui/AiLabel";
import { PLAN_CARD } from "@/components/plan/IdeaCard";
import type { Provenance } from "@/lib/types";
import { CARD_SECTION, MEAL_TITLE } from "@/lib/design/meal-type";

const PREVIEW_DAYS = 3;

export function DocumentOther({ provenance }: { provenance?: Provenance }) {
  return <Notice tone="neutral" title="I couldn’t find a meal plan, recipe or menu in that file.">
    Try another one.<AiLabel provenance={provenance} className="ml-1.5 align-middle" />
  </Notice>;
}

export default function DocumentPlan({ result, label, busy, placing, onUse }: {
  result: DocumentPlanResult & { provenance?: Provenance }; label: string; busy: boolean; placing: boolean; onUse: () => void;
}) {
  const { days, match } = result;
  const meal = match ? days[match.day]?.meals[match.meal] : undefined;
  return <section aria-label="Meal plan"
    className={PLAN_CARD}>
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <h3 className={`m-0 min-w-0 ${MEAL_TITLE.standard}`}>{result.title ?? "Your meal plan"}</h3>
        <AiLabel provenance={result.provenance} className="mt-0.5" />
      </div>
      <ul aria-label="Plan days" className="m-0 flex list-none flex-col gap-1 p-0">
        {days.slice(0, PREVIEW_DAYS).map((day, index) => <li key={`${day.label}-${index}`}
          className="text-caption text-graphite">
          <span className="font-medium text-charcoal">{day.label}:</span>{" "}
          {day.meals.map((m) => m.time ? `${m.name} ${m.time}` : m.name).join(" · ")}
        </li>)}
      </ul>
      {days.length > PREVIEW_DAYS && <p className="m-0 text-tiny text-muted">
        and {days.length - PREVIEW_DAYS} more {days.length - PREVIEW_DAYS === 1 ? "day" : "days"}</p>}
    </div>
    {match && meal ? <div className="flex flex-col gap-2">
      <h4 className={`m-0 ${CARD_SECTION}`}>For {label}: {match.title}
        {days.length > 1 ? ` (${days[match.day].label})` : ""}</h4>
      {match.items.length > 0 ? <>
        <p className="m-0 text-caption text-graphite">About <MacroLine values={match.totals} /></p>
        <p className="m-0 text-tiny text-muted">
          {match.items.map((item) => `${item.name} ${Math.round(item.grams)} g`).join(" · ")}</p>
      </> : <Notice tone="attention" title="None of this meal’s foods could be matched." />}
      {match.left.length > 0 && <div aria-label="Left out" className="flex flex-col gap-1">
        <p className="m-0 text-tiny font-medium text-charcoal">Left out</p>
        {match.left.map((food, index) => <p key={`${food.name}-${index}`} className="m-0 text-tiny text-muted">
          {food.amount ? `${food.name} (${food.amount})` : food.name}: {food.reason}</p>)}
      </div>}
      <Button variant="primary" block disabled={busy || match.items.length === 0}
        status={placing ? "pending" : undefined} onClick={onUse}>Use for this meal</Button>
    </div> : <Notice tone="neutral" title={`No meal in this plan matches ${label}.`} />}
    {days.length > 1 && <Notice tone="info" title="Importing a whole plan is coming." />}
  </section>;
}
