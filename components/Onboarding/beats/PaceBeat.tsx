"use client";

/**
 * Onboarding v2 question set §2c–§2d: the pace screen, on a lose or build-muscle goal that is not
 * held. The chips are `paceChoices` (lib/profile/pace.ts): lb a week AFTER the 20 % below-burn cap
 * and the account's minimum, duplicates dropped, slowest first, Steady pre-selected when distinct.
 * One tap on the pre-selected chip confirms it. One chip left is a statement with Next. The
 * direction guard (`kind: "minimum"`) shows no chips and no date.
 *
 * The optional goal weight is never stored; it only gives the "about Month YYYY" line, and only
 * when the chosen pace moves toward it (`impliedDate`).
 */
import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import ChoiceChips from "@/components/Onboarding/beats/ChoiceChips";
import { BeatNote, BeatQuestion } from "@/components/Onboarding/beats/BeatQuestion";
import { FIELD_CLASS } from "@/components/Onboarding/facts/FactQuestion";
import { APP_NAME } from "@/lib/brand";
import {
  chipForRequestedPace, impliedDate, type PaceChoice, type PaceChoices,
} from "@/lib/profile/pace";
import type { Goal } from "@/lib/types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

export function paceText(choice: Pick<PaceChoice, "lbPerWeek" | "underTenth">): string {
  return choice.underTenth ? "less than 0.1 lb a week" : `about ${choice.lbPerWeek.toFixed(1)} lb a week`;
}

function monthYear(isoDate: string): string {
  const [year, month] = isoDate.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

function boundLine(choice: PaceChoice, kcalMin: number): string | null {
  if (choice.bound === "rate_cap") {
    return "That’s the fastest pace your plan allows: no more than 20 % below what you burn.";
  }
  if (choice.bound === "kcal_min") {
    return `Your plan won’t go below ${kcalMin.toLocaleString("en-US")} calories a day, so the pace is slower.`;
  }
  return null;
}

function GoalWeightLine({ goal, currentLb, goalLb, heightCm, choice, today }: {
  goal: Goal; currentLb: number; goalLb: number | null; heightCm: number;
  choice: PaceChoice | null; today: string;
}) {
  if (goalLb === null) return null;
  const result = impliedDate({ goal, currentLb, goalLb, heightCm, choice, today });
  if (result.kind === "date" && choice) {
    return <BeatNote live>
      At {paceText(choice)}, you&rsquo;d reach {Math.round(goalLb)} lb about {monthYear(result.date)}.
      It&rsquo;s an estimate. Your plan updates as you log.
    </BeatNote>;
  }
  const line = {
    wrong_side: goal === "lose_fat"
      ? "That goal is above your weight now. You can change your goal in Settings."
      : "That goal is below your weight now. You can change your goal in Settings.",
    minimum_sets_pace: "Your minimum sets the pace, so we won’t guess a date.",
    below_bmi: "We plan toward a steady pace, not that number, so we won’t show a date.",
    too_long: "That’s a long road. We’ll show progress month by month.",
    no_pace: null, no_goal_weight: null,
  }[result.kind === "none" ? result.reason : "no_pace"];
  return line ? <BeatNote live>{line}</BeatNote> : null;
}

export default function PaceBeat({ pace, goal, currentLb, heightCm, today, requestedLb, insulin,
  initialBp, initialGoalLb, onDone }: {
  pace: Extract<PaceChoices, { kind: "choices" | "minimum" }>;
  goal: Goal;
  currentLb: number;
  heightCm: number;
  /** YYYY-MM-DD. */
  today: string;
  /** A pace the opener named ("2 pounds a week"), if any. */
  requestedLb?: number;
  /** Insulin or a sulfonylurea on a loss goal: Gentle is pre-selected, with the referral line. */
  insulin: boolean;
  initialBp: number | null;
  initialGoalLb: number | null;
  onDone: (answer: { bp: number; goalWeightLb: number | null }) => void;
}) {
  const fieldId = useId();
  const choices = pace.kind === "choices" ? pace.choices : [];
  const requested = requestedLb !== undefined ? chipForRequestedPace(choices, requestedLb) : null;
  const start = initialBp ?? (insulin && goal === "lose_fat" && choices[0] ? choices[0].bp
    : requested?.choice.bp ?? (pace.kind === "choices" ? pace.preselectedBp : pace.storeBp));
  const [bp, setBp] = useState<number>(start);
  const [goalText, setGoalText] = useState(initialGoalLb !== null ? String(initialGoalLb) : "");
  const goalLbRaw = Number(goalText);
  const goalLb = goalText.trim() !== "" && Number.isFinite(goalLbRaw) && goalLbRaw >= 50 && goalLbRaw <= 880
    ? goalLbRaw : null;
  const chosen = choices.find((choice) => choice.bp === bp) ?? null;
  const losing = goal === "lose_fat";

  if (pace.kind === "minimum") {
    return <div className="flex w-full flex-col gap-4" data-testid="pace-beat">
      <BeatQuestion>{losing ? "How fast do you want to lose?" : "How fast do you want to gain?"}</BeatQuestion>
      <BeatNote live>
        Your plan stays at your nutrition minimum, about what you burn now. Logging will show what&rsquo;s working.
      </BeatNote>
      <Button variant="primary" size="lg" block onClick={() => onDone({ bp: pace.storeBp, goalWeightLb: null })}>
        Next
      </Button>
    </div>;
  }

  const single = choices.length === 1;
  return <div className="flex w-full flex-col gap-4" data-testid="pace-beat">
    <BeatQuestion>{losing ? "How fast do you want to lose?" : "How fast do you want to gain?"}</BeatQuestion>
    {single
      ? <BeatNote live>
          <strong className="font-medium text-charcoal">{choices[0].label}</strong> · {paceText(choices[0])}.
          That&rsquo;s the pace your plan supports.
        </BeatNote>
      : <ChoiceChips label="Pace" block value={bp} onChange={setBp}
          options={choices.map((choice) => ({ value: choice.bp,
            label: <><span className="font-medium">{choice.label}</span> · {paceText(choice)}</> }))} />}
    {requested?.capped && <BeatNote live>
      {APP_NAME} plans up to {requested.choice.lbPerWeek.toFixed(1)} lb a week for you. That&rsquo;s the fastest pace this plan supports.
    </BeatNote>}
    {chosen && boundLine(chosen, pace.kcalMin) && <BeatNote live>{boundLine(chosen, pace.kcalMin)}</BeatNote>}
    {chosen?.label === "Faster" && !single && <BeatNote live>
      Faster is harder to keep up. Protein stays high, and you can slow down any time in Settings.
    </BeatNote>}
    {insulin && losing && <BeatNote live>
      If you take insulin or a sulfonylurea, check with your clinician before eating less.
    </BeatNote>}
    <div className="flex flex-col gap-2">
      <label htmlFor={fieldId} className="flex flex-col gap-0.5">
        <span className="text-body text-charcoal">Do you have a goal weight in mind?</span>
        <span className="text-caption text-graphite">Optional. We never save it.</span>
      </label>
      <span className="relative flex items-center">
        <input id={fieldId} type="number" inputMode="numeric" enterKeyHint="done" min={50} max={880}
          value={goalText} onChange={(event) => setGoalText(event.target.value)}
          className={`${FIELD_CLASS} pr-10`} />
        <span aria-hidden="true" className="pointer-events-none absolute right-3 text-body text-muted">lb</span>
      </span>
      <GoalWeightLine goal={goal} currentLb={currentLb} goalLb={goalLb} heightCm={heightCm}
        choice={chosen} today={today} />
    </div>
    <Button variant="primary" size="lg" block disabled={!chosen}
      onClick={() => chosen && onDone({ bp: chosen.bp, goalWeightLb: goalLb })}>
      {single ? "Next" : `Use ${chosen?.label ?? "this pace"}`}
    </Button>
  </div>;
}
