"use client";

import { useState, type Dispatch } from "react";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { canSwapMeals, deckCounter, deckDone, MAX_MEAL_ROUNDS, noMeals, yesIngredients, type BuildAction,
  type BuildState, type MealCard } from "@/lib/shopping/build-flow";
import PlanDaysEditor from "./PlanDaysEditor";
import YesNoDeck from "./YesNoDeck";

const SLOT_LABEL: Record<string, string> = { "meal-1": "Meal 1", "meal-2": "Meal 2", "meal-3": "Meal 3",
  "meal-4": "Meal 4", "meal-5": "Meal 5", "meal-6": "Meal 6" };

export function mealDay(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(parsed);
}

/** "Tue 21 Oct · Meal 3 · 520 kcal · P 32 g"; an unknown number is left out, never shown as 0. */
export function mealMeta(card: MealCard): string {
  const parts = [mealDay(card.date), SLOT_LABEL[card.slotId] ?? card.slotId];
  if (card.kcal !== null) parts.push(`${Math.round(card.kcal)} kcal`);
  if (card.proteinG !== null) parts.push(`P ${Math.round(card.proteinG)} g`);
  return parts.join(" · ");
}

/**
 * Step 3, Meals (UI makeover §7.3): the planner's preview (nothing saved), one card per meal.
 * The No answers are swapped in one re-preview and only the new meals are walked; after
 * MAX_MEAL_ROUNDS swaps "Keep these" is the way on. When the planner refuses these days, the
 * reason shows with two ways on: change the days or meals, or save just the foods.
 */
export default function StepMeals({ state, dispatch, mealCount }: {
  state: BuildState; dispatch: Dispatch<BuildAction>; mealCount: number;
}) {
  const meals = state.meals;
  const [editing, setEditing] = useState(false);
  if (meals.status === "loading" || meals.status === "idle") {
    return <p role="status" className="m-0 text-caption text-muted">
      {meals.rounds > 0 ? "Finding other meals…" : "Planning meals for these days…"}</p>;
  }
  if (meals.status === "error") {
    const foods = yesIngredients(state).length;
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="attention" title="Meals couldn't be planned.">{meals.error}</Notice>
        {editing ? (
          <PlanDaysEditor draft={state.draft} mealCount={mealCount} onCancel={() => setEditing(false)}
            onPlan={(draft) => { setEditing(false); dispatch({ type: "edit-plan", draft }); }} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => dispatch({ type: "foods-only" })}>Save just your foods</Button>
            <Button variant="tertiary" onClick={() => setEditing(true)}>Change days or meals</Button>
            <Button variant="ghost" onClick={() => dispatch({ type: "retry-preview" })}>Try again</Button>
          </div>
        )}
        <p className="m-0 text-caption text-muted">
          {foods === 0 ? "No foods picked yet. The list starts empty." : `${foods} ${foods === 1 ? "food" : "foods"} go on the list.`}
        </p>
      </div>
    );
  }
  const card = meals.cards[meals.index];
  const no = noMeals(state).length;
  const done = deckDone(meals);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-body font-semibold text-charcoal">Meals for these days</h3>
      {meals.cards.length === 0 ? (
        <p className="m-0 text-body text-muted">No meals fit these days yet. Your foods still go on the list.</p>
      ) : (
        <YesNoDeck label="Meals for these days" name={card?.name ?? ""} counter={deckCounter(meals)}
          finished={done} title={card?.name} meta={card ? mealMeta(card) : undefined}
          onYes={() => dispatch({ type: "answer", answer: "yes" })}
          onNo={() => dispatch({ type: "answer", answer: "no" })}
          onYesToRest={() => dispatch({ type: "yes-to-rest" })}
          done={<p className="m-0 text-body text-charcoal">
            {no === 0 ? `All ${meals.cards.length} meals planned.` : `${no} of ${meals.cards.length} meals marked No.`}
          </p>} />
      )}
      {done && no === 0 && (
        <Button variant="primary" className="self-start" onClick={() => dispatch({ type: "next" })}>Next: stores</Button>
      )}
      {done && no > 0 && (
        <div className="flex flex-col gap-2">
          {canSwapMeals(state)
            ? <p className="m-0 text-caption text-muted">Swap {no === 1 ? "it" : "them"} for other meals, or keep these.</p>
            : meals.rounds >= MAX_MEAL_ROUNDS
              ? <p className="m-0 text-caption text-muted">
                No more swaps after {MAX_MEAL_ROUNDS} rounds. These meals stay on the plan.</p>
              : <p className="m-0 text-caption text-muted">
                {no === 1 ? "That meal is" : "Those meals are"} also on a day you kept, so {no === 1 ? "it stays" : "they stay"}.</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="tertiary" onClick={() => dispatch({ type: "keep-these" })}>Keep these</Button>
            {canSwapMeals(state) && (
              <Button variant="primary" onClick={() => dispatch({ type: "swap-no-meals" })}>Find other meals</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
