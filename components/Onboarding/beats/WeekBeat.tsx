"use client";

/**
 * Onboarding v2 question set §1b/§3: "Which days do you usually work out?" and "Outside of
 * workouts, how much do you move on a normal day?" — both optional — then the activity level they
 * imply, shown as a chip the person can change (`inferActivity`, lib/profile/activity-infer.ts).
 * Never saved silently: the chip is on screen before Next. Skip leaves every day a rest day and
 * activity sedentary, and the plan card names both.
 */
import { useState } from "react";
import Button from "@/components/ui/Button";
import { DisclosurePanel } from "@/components/ui/Disclosure";
import ChoiceChips from "@/components/Onboarding/beats/ChoiceChips";
import { BeatNote, BeatQuestion } from "@/components/Onboarding/beats/BeatQuestion";
import { activityFor, activityLabel, type WeekAnswer } from "@/components/Onboarding/v2/plan-answers";
import type { DailyMovement } from "@/lib/profile/activity-infer";
import type { ActivityLevel } from "@/lib/types";

const WEEKDAYS = [
  { value: 0, label: "Sun" }, { value: 1, label: "Mon" }, { value: 2, label: "Tue" },
  { value: 3, label: "Wed" }, { value: 4, label: "Thu" }, { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
] as const;
const MOVEMENT: { value: DailyMovement; label: string }[] = [
  { value: "mostly_sitting", label: "Mostly sitting" },
  { value: "feet_some", label: "On my feet some" },
  { value: "feet_most", label: "On my feet most of the day" },
  { value: "hard_work", label: "Hard physical work" },
];
const LEVELS: ActivityLevel[] = ["sedentary", "light", "moderate", "active", "very_active"];

export default function WeekBeat({ initial, onDone }: {
  initial: WeekAnswer | null;
  onDone: (answer: WeekAnswer) => void;
}) {
  const [days, setDays] = useState<number[]>(initial?.trainingWeekdays ?? []);
  const [none, setNone] = useState(initial?.noWorkouts ?? false);
  const [movement, setMovement] = useState<DailyMovement | null>(initial?.dailyMovement ?? null);
  const [override, setOverride] = useState<ActivityLevel | null>(initial?.activityOverride ?? null);
  const [editing, setEditing] = useState(false);
  const draft: WeekAnswer = {
    trainingWeekdays: none ? [] : days, noWorkouts: none, dailyMovement: movement,
    activityOverride: override, skipped: false,
  };
  const level = activityFor(draft);
  const answered = none || days.length > 0 || movement !== null;

  function toggleDay(day: number) {
    setNone(false);
    setOverride(null);
    setDays((current) => current.includes(day) ? current.filter((d) => d !== day) : [...current, day]);
  }

  return <div className="flex w-full flex-col gap-5" data-testid="week-beat">
    <div className="flex flex-col gap-3">
      <BeatQuestion>Which days do you usually work out?</BeatQuestion>
      <ChoiceChips label="Workout days" multiple options={WEEKDAYS}
        value={none ? [] : days} onChange={toggleDay} />
      <ChoiceChips label="No workouts" multiple
        options={[{ value: "none", label: "I don’t work out right now" }]}
        value={none ? ["none"] : []}
        onChange={() => { setNone((current) => !current); setDays([]); setOverride(null); }} />
    </div>
    <div className="flex flex-col gap-3">
      <BeatQuestion>Outside of workouts, how much do you move on a normal day?</BeatQuestion>
      <ChoiceChips label="Daily movement" block options={MOVEMENT} value={movement}
        onChange={(value) => { setMovement(value); setOverride(null); }} />
    </div>
    {answered && <div className="flex flex-col gap-2" data-testid="activity-chip">
      <BeatNote live>
        Activity: <strong className="font-medium text-charcoal">{activityLabel(level)}</strong>
        {override ? "" : " — from your answers."}
      </BeatNote>
      <Button variant="tertiary" size="sm" className="min-h-11 self-start" aria-expanded={editing}
        aria-controls="activity-levels" onClick={() => setEditing((open) => !open)}>
        Change activity
      </Button>
      <DisclosurePanel id="activity-levels" open={editing} keepMounted={false}>
        <ChoiceChips label="Activity level" options={LEVELS.map((value) => ({ value, label: activityLabel(value) }))}
          value={level} onChange={(value) => setOverride(value)} />
      </DisclosurePanel>
    </div>}
    <div className="flex flex-col gap-2">
      <Button variant="primary" size="lg" block disabled={!answered} onClick={() => onDone(draft)}>
        Next
      </Button>
      <Button variant="ghost" size="sm" className="min-h-11"
        onClick={() => onDone({ trainingWeekdays: [], noWorkouts: false, dailyMovement: null,
          activityOverride: null, skipped: true })}>
        Skip this
      </Button>
    </div>
  </div>;
}
