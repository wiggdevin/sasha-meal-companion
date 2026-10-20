"use client";

import { useState, type Dispatch } from "react";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import Notice from "@/components/ui/Notice";
import { saveSummary, TITLE_MAX, type BuildAction, type BuildState } from "@/lib/shopping/build-flow";
import { shoppingRange } from "@/lib/shopping/labels";
import PlanDaysEditor from "./PlanDaysEditor";

export type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "partial"; failed: string[] }
  | { kind: "error"; message: string };

/**
 * Step 5, Save (UI makeover §7.3): the list's title (default "Weekly shop"), its dates and meals,
 * and "18 items · 9 meals · 2 stores". Changing the dates or meals plans the meals again, so the
 * list saved is always the plan that was shown ("Plan meals" when the user chose "Save just your
 * foods"). Save list is the flow's only write.
 */
export default function StepSave({ state, dispatch, mealCount, status, onSave }: {
  state: BuildState;
  dispatch: Dispatch<BuildAction>;
  mealCount: number;
  status: SaveStatus;
  onSave: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const saving = status.kind === "saving";
  const partial = status.kind === "partial";

  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-body font-semibold text-charcoal">Save your list</h3>
      <Field id="build-title" label="List name" value={state.title} maxLength={TITLE_MAX} disabled={saving || partial}
        onChange={(event) => dispatch({ type: "title", title: event.target.value })} />
      {!editing ? (
        <div className="flex items-center justify-between gap-2">
          <p className="m-0 min-w-0 truncate text-body text-charcoal">
            {shoppingRange(state.draft.startDate, state.draft.endDate)}
          </p>
          {!partial && <Button variant="ghost" onClick={() => setEditing(true)}
            disabled={saving}>{state.meals.skipped ? "Plan meals" : "Change days"}</Button>}
        </div>
      ) : (
        <PlanDaysEditor draft={state.draft} mealCount={mealCount} onCancel={() => setEditing(false)}
          onPlan={(draft) => { setEditing(false); dispatch({ type: "edit-plan", draft }); }} />
      )}
      <p className="m-0 text-body font-semibold text-charcoal">{saveSummary(state)}</p>
      {state.stores.length > 0 && (
        <p className="m-0 truncate text-caption text-muted">{state.stores.map((store) => store.name).join(", ")}</p>
      )}
      {status.kind === "error" && <Notice tone="error" title={status.message} />}
      {partial && (
        <Notice tone="attention" title="Your list is saved, but a few things did not finish.">
          {status.failed.filter((name) => name !== "title").length > 0
            ? `Not added yet: ${status.failed.filter((name) => name !== "title").join(", ")}.` : "The name did not save yet."}
        </Notice>
      )}
      {!editing && (
        <Button variant="primary" size="lg" block onClick={onSave} status={saving ? "pending" : undefined}
          disabled={saving}>{partial ? "Finish saving" : "Save list"}</Button>
      )}
    </div>
  );
}
