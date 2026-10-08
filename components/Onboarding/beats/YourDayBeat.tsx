"use client";

/**
 * Onboarding v2 question set §1b/§3 "Your day": meals per day and the first meal time on one
 * screen, both optional and pre-filled with the plan's own defaults ("3 meals: 8:00 AM, 12:30 PM,
 * 6:30 PM. Looks right?"), so one tap accepts. Times are US 12-hour. The visible, pre-selected
 * "I'm in the U.S." chip sits here too (ruling docs/decisions/2026-10-08-us-default-country.md):
 * the person's own editable choice, never inferred.
 */
import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import Reveal from "@/components/Onboarding/beats/Reveal";
import ChoiceChips from "@/components/Onboarding/beats/ChoiceChips";
import { BeatNote, BeatQuestion } from "@/components/Onboarding/beats/BeatQuestion";
import { FIELD_CLASS } from "@/components/Onboarding/facts/FactQuestion";
import { clock12, type DayAnswer } from "@/components/Onboarding/v2/plan-answers";
import { resolveSlotTimes, shiftForFirstMeal } from "@/lib/plan";

type MealsChoice = number | "auto";
const MEALS: { value: MealsChoice; label: string }[] = [
  { value: 2, label: "2" }, { value: 3, label: "3" }, { value: 4, label: "4" },
  { value: 5, label: "5" }, { value: 6, label: "6" }, { value: "auto", label: "Pick for me" },
];
const FIRST_TIMES = ["06:30", "07:30", "08:00", "09:00", "10:00"] as const;

/** The day's meal times for a count and a first meal, the planner's own way (`resolveSlotTimes`). */
export function dayTimes(count: number, firstMealTime: string | null): string[] {
  const shift = firstMealTime ? shiftForFirstMeal(firstMealTime, { mealsPerDay: count }) ?? 0 : 0;
  return resolveSlotTimes("rest", { slotTimes: {}, shiftMinutes: shift, mealsPerDay: count })
    .map((slot) => slot.time);
}

export default function YourDayBeat({ derivedCount, initial, onDone }: {
  /** The meal count "Pick for me" gives for this plan's calories (`mealCountFor`). */
  derivedCount: number;
  initial: DayAnswer | null;
  onDone: (answer: DayAnswer) => void;
}) {
  const otherId = useId();
  const [meals, setMeals] = useState<MealsChoice>(initial?.mealsPerDay ?? "auto");
  const [first, setFirst] = useState<string | null>(initial?.firstMealTime ?? null);
  const [other, setOther] = useState(() =>
    !!initial?.firstMealTime && !(FIRST_TIMES as readonly string[]).includes(initial.firstMealTime));
  const [inUs, setInUs] = useState(initial?.inUs ?? true);
  const count = meals === "auto" ? derivedCount : meals;
  const times = dayTimes(count, first);
  const shownFirst = times[0];

  return <div className="flex w-full flex-col gap-5" data-testid="your-day-beat">
    <div className="flex flex-col gap-2">
      <BeatQuestion>Your day</BeatQuestion>
      <BeatNote live>
        {count} meals: {times.map(clock12).join(", ")}. Looks right?
      </BeatNote>
    </div>
    <div className="flex flex-col gap-3">
      <p className="m-0 text-body text-charcoal">How many times a day do you like to eat?</p>
      <ChoiceChips label="Meals a day" options={MEALS} value={meals} onChange={setMeals} />
    </div>
    <div className="flex flex-col gap-3">
      <p className="m-0 text-body text-charcoal">When do you usually eat first?</p>
      <ChoiceChips label="First meal" value={other ? "other" : (first ?? shownFirst)}
        options={[...FIRST_TIMES.map((time) => ({ value: time as string, label: clock12(time) })),
          { value: "other", label: "Other" }]}
        onChange={(value) => {
          if (value === "other") { setOther(true); return; }
          setOther(false);
          setFirst(value === shownFirst && first === null ? null : value);
        }} />
      <Reveal id="first-meal-other" open={other}>
        <div className="flex flex-col gap-1">
          <label htmlFor={otherId} className="text-caption text-graphite">First meal time</label>
          <input id={otherId} type="time" value={first ?? shownFirst} step={900}
            onChange={(event) => setFirst(event.target.value || null)} className={FIELD_CLASS} />
        </div>
      </Reveal>
    </div>
    <div className="flex flex-col gap-2 border-t border-hairline pt-5">
      <ChoiceChips label="Country" multiple options={[{ value: "US", label: "I’m in the U.S." }]}
        value={inUs ? ["US"] : []} onChange={() => setInUs((on) => !on)} />
      <BeatNote>This helps us suggest foods people here eat. Change it any time in Settings.</BeatNote>
    </div>
    <Button variant="primary" size="lg" block
      onClick={() => onDone({ mealsPerDay: meals === "auto" ? null : meals, firstMealTime: first, inUs })}>
      Looks right
    </Button>
  </div>;
}
