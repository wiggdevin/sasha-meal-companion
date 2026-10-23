"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Field from "@/components/ui/Field";
import { draftProblem, type ShoppingDraft } from "@/lib/shopping/contracts";
import { planDraftProblem } from "@/lib/shopping/build-flow";

/**
 * The days and meals the build plans (UI makeover §7.3), on the Meals step when a plan is refused
 * and on the Save step. "Plan these days" previews again; nothing is written. At most 31 days, the
 * planner's span.
 */
export default function PlanDaysEditor({ draft: start, mealCount, onCancel, onPlan }: {
  draft: ShoppingDraft;
  mealCount: number;
  onCancel: () => void;
  onPlan: (draft: ShoppingDraft) => void;
}) {
  const [draft, setDraft] = useState(start);
  const problem = draftProblem(draft) ?? planDraftProblem(draft);
  const slots = Array.from({ length: Math.min(6, Math.max(1, mealCount)) }, (_, index) => `meal-${index + 1}`);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Field id="build-from" label="From" type="date" value={draft.startDate}
          onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} />
        <Field id="build-to" label="Through" type="date" value={draft.endDate}
          onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} />
      </div>
      <div className="pill-in flex flex-wrap gap-1" role="group" aria-label="Meals to plan">
        {slots.map((slot, index) => {
          const on = draft.mealCoverage.includes(slot);
          return <Chip key={slot} selected={on} onClick={() => setDraft({ ...draft, mealCoverage: on
            ? draft.mealCoverage.filter((value) => value !== slot) : [...draft.mealCoverage, slot].sort() })}>
            Meal {index + 1}</Chip>;
        })}
      </div>
      {problem && <p className="m-0 text-caption text-alert">{problem}</p>}
      <div className="flex gap-2">
        <Button variant="tertiary" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={problem !== null} onClick={() => onPlan(draft)}>Plan these days</Button>
      </div>
    </div>
  );
}
