"use client";

import { useId, type ReactNode } from "react";
import { BodyProfileFieldsView } from "@/components/BodyProfileFields";
import DietaryProfilePicker from "@/components/Onboarding/DietaryProfilePicker";
import { Pill } from "@/components/Sheet";
import Button from "@/components/ui/Button";
import WeightField from "@/components/WeightField";
import Stepper from "@/components/Stepper";
import BodyFatSourceField from "@/components/BodyFatSourceField";
import GoalRateField, { rateClampCopy, rateSentence } from "@/components/GoalRateField";
import { activityFactor, deriveTargets, energyProfileFrom, katchEligible }
  from "@/lib/profile/energy";
import {
  enforcedFlags, missingProfileFields, parsedWeightKg, previewCompletedSettings,
  type OnboardingAction, type OnboardingState, type PreferenceFlag,
} from "@/lib/profile/onboarding-state";
import type { TargetEligibility } from "@/lib/profile/rate-eligibility";
import { todayIso } from "@/lib/settings/date";
import { needsBirthDate } from "@/components/Onboarding/legacy-eligibility";
import type { CookingEffort } from "@/lib/sync/user-settings";
import type { ActivityLevel, Goal, Macros, Settings } from "@/lib/types";
import { kgToLb } from "@/lib/health/units";
import { mealCountFor } from "@/lib/plan";
import Thinking from "@/components/ui/Thinking";
import DietaryTextHint, { type DietaryTextOffer } from "@/components/ui/DietaryTextHint";

const CAPTION = "text-tiny font-normal leading-body-sm text-muted";
const LABEL = "text-caption font-normal";
/** A field's own name over its box, as in components/BodyProfileFields. */
const FIELD_LABEL = "text-caption font-medium text-charcoal";
const FIELD = "text-body font-medium text-charcoal";
/**
 * An option card: one choice among a few, with a line of detail. The beige tray at rest; chosen, the
 * olive wash (`--color-selected-soft`, "a chosen option card") inside a 2 px olive ring. Utilities only:
 * the legacy `button.well` recipe is unlayered, so it overrode the chosen wash and the selection
 * never showed (found 2026-10-04: "Moderate" was pressed and looked like every other row).
 */
const OPTION = "tap flex flex-col justify-center rounded-[16px] px-4 py-2 text-left";
const optionLook = (chosen: boolean) => chosen
  ? "bg-selected-soft shadow-[inset_0_0_0_2px_var(--color-primary)]"
  : "bg-fog shadow-[inset_0_0_0_1px_rgb(var(--ink-rgb)/0.06)]";

type StepProps = {
  state: OnboardingState;
  dispatch: (action: OnboardingAction) => void;
};

export function BodyStep({ state, dispatch }: StepProps) {
  const year = Number(state.body.birthYear);
  const age = Number.isInteger(year) && year >= 1900 && year <= new Date().getFullYear()
    ? new Date().getFullYear() - year : null;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <BodyProfileFieldsView
          drafts={state.body}
          heightUnit={state.heightUnit}
          error={null}
          intro={<p className={`m-0 ${CAPTION}`}>Used to calculate your starting plan.</p>}
          onEdit={(key, value) => dispatch({ type: "edit_body", key, value })}
          onHeightChange={(value) => dispatch({ type: "edit_body", key: "heightCm",
            value: value === null ? "" : String(value) })}
          onHeightUnitChange={(value) => dispatch({ type: "set_height_unit", value })}
          onCommit={() => {}}
          onSex={(value) => {
            if (value === "" || value === "female" || value === "male") {
              dispatch({ type: "set_sex", value });
            }
          }}
          onRetry={() => {}}
        />
        {age !== null && <p className={`m-0 ${CAPTION}`}>Age today: {age}</p>}
      </div>
      <BirthDateField state={state} dispatch={dispatch} />
      {state.body.bodyFatPct.trim() !== "" && (
        <BodyFatSourceField source={state.bodyFatSource} measuredOn={state.bodyFatMeasuredOn}
          onChange={(patch) => dispatch({ type: "set_body_fat_source",
            source: patch.bodyFatSource, measuredOn: patch.bodyFatMeasuredOn })}
          fieldClass="well min-h-11 w-full bg-transparent px-3 text-body text-charcoal outline-none"
          labelClassName={FIELD_LABEL} captionClassName={CAPTION} />
      )}
      <div className="flex flex-col gap-1.5">
        <WeightField valueKg={parsedWeightKg(state)}
          unit={state.weightUnit}
          onChange={(value) => dispatch({ type: "edit_weight", value: value === null ? ""
            : state.weightUnit === "lb"
              ? String(Math.round(kgToLb(value) * 10) / 10)
              : String(value) })}
          onUnitChange={(value) => dispatch({ type: "set_weight_unit", value })} />
        <span className={CAPTION}>Stored in kilograms.</span>
      </div>
    </div>
  );
}

/**
 * The full date of birth, asked only in the year the birth year turns 18 (audit 2026-10-10 A092):
 * a birth year alone counts a 17-year-old whose birthday is still ahead as 18. Next stays off until
 * it is answered; it is never saved (the account keeps its birth year).
 */
function BirthDateField({ state, dispatch }: StepProps) {
  const helpId = useId();
  const today = todayIso();
  const asked = needsBirthDate(state, today) || (!!state.birthDate
    && state.birthDate.slice(0, 4) === state.body.birthYear.trim());
  if (!asked) return null;
  const year = state.body.birthYear.trim();
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL}>Date of birth</span>
        <input type="date" value={state.birthDate ?? ""} min={`${year}-01-01`}
          max={today < `${year}-12-31` ? today : `${year}-12-31`} aria-describedby={helpId}
          onChange={(event) => dispatch({ type: "set_birth_date", value: event.target.value || null })}
          className={`well min-h-11 w-full bg-transparent px-3 outline-none ${FIELD}`} />
      </label>
      <span id={helpId} className={CAPTION}>Plans start at 18, so we check the day you turn 18 this year.</span>
    </div>
  );
}

const ACTIVITIES: { value: ActivityLevel; title: string; detail: string }[] = [
  // Each level describes the whole day — how much you sit or walk AND how often you train — because
  // four sessions a week do not make a desk worker and a warehouse worker equally active. The
  // factors behind them are conservative starting estimates (lib/profile/energy.ts); the estimator
  // replaces them with what your intake and weight show.
  { value: "sedentary", title: "Sedentary", detail: "Mostly seated; little purposeful movement." },
  { value: "light", title: "Light",
    detail: "Mostly seated, but you walk regularly or train 1–3 times a week." },
  { value: "moderate", title: "Moderate",
    detail: "Mixed sitting and walking; you train about 3–5 times a week." },
  { value: "active", title: "Active",
    detail: "On your feet much of the day, or you train hard most days." },
  { value: "very_active", title: "Very active",
    detail: "A physical job, high-volume endurance work, or training twice a day." },
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ActivityStep({ state, dispatch }: StepProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {ACTIVITIES.map((activity) => (
          <button key={activity.value} type="button"
            aria-pressed={state.activityLevel === activity.value}
            onClick={() => dispatch({ type: "set_activity", value: activity.value })}
            className={`${OPTION} min-h-14 ${optionLook(state.activityLevel === activity.value)}`}>
            <span className={LABEL}>{activity.title}</span>
            <span className={CAPTION}>{activity.detail}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className={LABEL}>Training days</span>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((day, value) => (
            <Pill key={day} active={state.trainingWeekdays.includes(value)}
              onClick={() => dispatch({ type: "toggle_weekday", value })}>
              {day}
            </Pill>
          ))}
        </div>
      </div>
    </div>
  );
}

const GOALS: { value: Goal; title: string; detail: string }[] = [
  { value: "lose_fat", title: "Lose fat", detail: "A steady calorie deficit while keeping protein high." },
  { value: "recomp", title: "Recomp", detail: "Keep your weight; trade fat for strength and muscle." },
  { value: "maintain", title: "Maintain", detail: "Hold body weight while supporting training." },
  { value: "gain_muscle", title: "Gain muscle", detail: "A small surplus to support muscle growth." },
];

/** Said in place of the pace once the safety round or a stored answer holds it (G1–G3). */
export const PACE_HELD_NOTE =
  "Your health answers keep your calories about where you burn, so there’s no pace to set.";

export function GoalStep({ state, dispatch, paceHeld = false }: StepProps & {
  /** A hold from the safety round or the account's stored answers: no pace is asked. */
  paceHeld?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {GOALS.map((goal) => (
        <button key={goal.value} type="button" aria-pressed={state.goal === goal.value}
          onClick={() => dispatch({ type: "set_goal", value: goal.value })}
          className={`${OPTION} min-h-16 ${optionLook(state.goal === goal.value)}`}>
          <span className={LABEL}>{goal.title}</span>
          <span className={CAPTION}>{goal.detail}</span>
        </button>
      ))}
      {state.goal !== null && paceHeld && state.goal !== "maintain" && state.goal !== "recomp" && (
        <p role="status" className={`m-0 pt-2 ${CAPTION}`}>{PACE_HELD_NOTE}</p>
      )}
      {state.goal !== null && !paceHeld && (
        <div className="pt-2">
          <GoalRateField goal={state.goal} value={state.goalRateBpWeek} required
            onChange={(value) => dispatch({ type: "set_goal_rate", value })}
            fieldClass="well min-h-11 w-full bg-transparent px-3 outline-none"
            fieldClassName={FIELD} labelClassName={FIELD_LABEL} captionClassName={CAPTION} />
        </div>
      )}
    </div>
  );
}

const FLAG_LABELS: Record<PreferenceFlag, string> = {
  vegetarian: "Vegetarian", vegan: "Vegan", pescatarian: "Pescatarian",
  no_pork: "No pork", no_beef: "No beef", no_shellfish: "No shellfish",
  no_eggs: "No eggs", no_soy: "No soy", no_peanuts: "No peanuts",
  low_fodmap: "Low FODMAP", halal: "Halal", kosher: "Kosher",
};

const COOKING_EFFORT_LABELS: Record<CookingEffort, string> = {
  none: "No cooking",
  minimal: "Minimal cooking",
  full: "Full cooking",
};

export const PREFERENCE_POLICY_COPY =
  "Confirmed preferences filter recipes and meal ideas when the food is verified. Foods we cannot verify are marked Not verified. You can always log what you ate.";

export function toggleCookingEffort(
  current: CookingEffort | null,
  selected: CookingEffort,
): CookingEffort | null {
  return current === selected ? null : selected;
}

function PreferenceGroup({
  title, explanation, flags, state, dispatch,
}: {
  title: string;
  explanation: string;
  flags: PreferenceFlag[];
  state: OnboardingState;
  dispatch: (action: OnboardingAction) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h2 className={`m-0 ${LABEL}`}>{title}</h2>
        <p className={`m-0 ${CAPTION}`}>{explanation}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {flags.map((flag) => (
          <Pill key={flag} active={state.flags.includes(flag)}
            onClick={() => dispatch({ type: "toggle_flag", flag })}>
            {FLAG_LABELS[flag]}
          </Pill>
        ))}
      </div>
    </section>
  );
}

export function PreferencesStep({
  state, dispatch, onBlur, classifying, cookingEffort = null,
  cookingEffortSuggestion = null, onCookingEffortChange = () => {},
  dietaryHintOffer = null, onAddRule,
}: StepProps & {
  onBlur: () => void;
  classifying: boolean;
  cookingEffort?: CookingEffort | null;
  cookingEffortSuggestion?: CookingEffort | null;
  onCookingEffortChange?: (effort: CookingEffort | null) => void;
  /** Phase 18 W5b: the phone's local safety check kept the newest text; null hides the hint. */
  dietaryHintOffer?: DietaryTextOffer | null;
  /** Jumps to the account's own rule editor (More dietary profiles, below), still on this step. */
  onAddRule?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-2">
        <span className={LABEL}>Anything you don&rsquo;t eat, or want more of</span>
        <textarea value={state.prefsText}
          onChange={(event) => dispatch({ type: "set_prefs_text", value: event.target.value })}
          onBlur={onBlur} rows={5}
          className="well resize-none px-3 py-3 outline-none min-h-11 text-caption font-normal text-charcoal" />
      </label>
      <DietaryTextHint offer={dietaryHintOffer} onAddRule={onAddRule} />
      {/* The live status sits beside the paragraph, never inside it (audit b4b #11). */}
      {classifying ? <Thinking label="Reading your preferences…" />
        : <p className={`m-0 ${CAPTION}`}>Confirm anything that applies.</p>}
      <p className={`m-0 ${CAPTION}`}>{PREFERENCE_POLICY_COPY}</p>
      <PreferenceGroup title="Enforced exclusions"
        explanation="These become rules that block matching foods."
        flags={enforcedFlags()} state={state} dispatch={dispatch} />
      <DietaryProfilePicker />
      <section className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <h2 className={`m-0 ${LABEL}`}>Cooking effort</h2>
          <p className={`m-0 ${CAPTION}`}>Choose one only if it fits.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(COOKING_EFFORT_LABELS) as CookingEffort[]).map((effort) => (
            <Pill key={effort} active={cookingEffort === effort}
              onClick={() => onCookingEffortChange(toggleCookingEffort(cookingEffort, effort))}>
              {COOKING_EFFORT_LABELS[effort]}
              {cookingEffort !== effort && cookingEffortSuggestion === effort
                ? " · Suggested" : ""}
            </Pill>
          ))}
        </div>
      </section>
    </div>
  );
}

function MacroPanel({ title, macros }: { title: string; macros: Macros }) {
  return (
    <section className="olive-panel flex flex-col gap-2 p-4">
      <span className="text-tiny font-normal leading-body-sm text-muted">{title}</span>
      <strong className="text-heading font-light">{macros.kcal.toLocaleString()} kcal</strong>
      <span className="text-tiny font-normal">
        {macros.protein} g protein · {macros.carbs} g carbs · {macros.fat} g fat
      </span>
    </section>
  );
}

/** The one "we cannot draw a plan yet" card, so both ways of getting there read the same. */
function MissingProfileCard({ missing }: { missing: string[] }) {
  return (
    <div className="well flex flex-col gap-2 p-4">
      <p className={`m-0 ${LABEL}`}>
        {missing.length > 0
          ? `Your profile needs ${missing.join(", ")}.`
          : "Your profile needs a few more details."}
      </p>
      <p className={`m-0 ${CAPTION}`}>Go back to fill them in, or skip for now.</p>
    </div>
  );
}

export function PlanStep({ state, base, dispatch, proteinAvailability, starterSelectionReady,
  optionalFoods = false, eligibility, paceNote = null }: StepProps & {
  base: Settings;
  proteinAvailability?: { selected: number; eligible: number; required: number; ready: boolean } | null;
  starterSelectionReady?: boolean;
  optionalFoods?: boolean;
  /** The account's holds (safety round + stored answers): the preview the server will write. */
  eligibility?: TargetEligibility;
  /** Why the pace is held although no hold was found (unanswered round, unread answers). */
  paceNote?: ReactNode;
}) {
  const missing = missingProfileFields(state, eligibility);
  if (missing.length > 0) return <MissingProfileCard missing={missing} />;
  // Never a crash: an adult-only refusal is the flow's own stop (A093), and here the same card.
  const settings = previewCompletedSettings(base, state, new Date(), eligibility);
  if (!settings) return <MissingProfileCard missing={missing} />;
  const targets = settings.activeTargetProfile;
  // A revision the builder could not produce is the same user-visible state as a missing field:
  // the missing-data card, not a crash. The non-null assertion this replaces made any gap between
  // `missingProfileFields()` and what the builder actually needs throw (D1 §8.5). The two reads
  // below are reachable only once `targets` exists, and `missingProfileFields` has already proved
  // both, so they keep their assertions.
  if (!targets) return <MissingProfileCard missing={missing} />;
  const trainingKcal = state.planEdits.trainingKcal ?? targets.training.kcal;
  const restKcal = state.planEdits.restKcal ?? targets.rest.kcal;
  const proteinG = state.planEdits.proteinG ?? targets.training.protein;
  // The formula the derivation actually used (step C): Katch-McArdle only for a recent scan.
  const derivedOn = targets.inputs?.effectiveDate ?? new Date().toISOString().slice(0, 10);
  const derivedAt = new Date(`${derivedOn}T12:00:00Z`);
  const formula = katchEligible(settings, derivedAt) ? "Katch-McArdle" : "Mifflin-St Jeor";
  const activity = activityFactor(settings.activityLevel!);
  // The same pure derivation the revision used, re-run for what the rate did to the number.
  const { rate } = deriveTargets(energyProfileFrom(settings), derivedAt,
    settings.trainingWeekdays?.length ?? 0);
  const clamp = settings.goalRateBpWeek ? rateClampCopy(rate, settings.goalRateBpWeek) : null;
  return (
    <div className="flex flex-col gap-3">
      {paceNote}
      <MacroPanel title="Training day" macros={targets.training} />
      <MacroPanel title="Rest day" macros={targets.rest} />
      <div className="well flex flex-col gap-3 p-4">
        <Stepper label="Meals per day" value={mealCountFor(settings)} step={1}
          onChange={(value) => dispatch({ type: "set_meals_per_day", value: Math.max(2, Math.min(6, value)) })}
          helperText={optionalFoods ? "Choose 2–6 meals. You can discover recipes after setup."
            : "Choose 2–6 meals. Each suggested meal uses a different protein you selected."} />
        <Stepper label="Training day calories" value={trainingKcal} step={50} unit="kcal"
          onChange={(value) => dispatch({ type: "edit_plan", field: "trainingKcal", value })} />
        <Stepper label="Rest day calories" value={restKcal} step={50} unit="kcal"
          onChange={(value) => dispatch({ type: "edit_plan", field: "restKcal", value })} />
        <Stepper label="Protein" value={proteinG} step={5} unit="g"
          onChange={(value) => dispatch({ type: "edit_plan", field: "proteinG", value })} />
        <Button variant="ghost" size="sm" className="self-start" onClick={() => dispatch({ type: "reset_plan" })}>
          Reset to derived
        </Button>
      </div>
      {proteinAvailability && !proteinAvailability.ready && <p role="status"
        className="well m-0 p-4 text-caption text-graphite">
        {proteinAvailability.selected} of {proteinAvailability.required} distinct proteins selected for this plan.
        {proteinAvailability.selected >= 2
          ? " Choose fewer meals here, or go Back to Foods and select more proteins."
          : proteinAvailability.eligible < 2
            ? " Your current food rules leave fewer than two starter proteins. Go Back to Dietary preferences to review your rules, or Skip for now and add safe foods later."
            : " Go Back to Foods and choose at least two proteins, or Skip for now."}
      </p>}
      {proteinAvailability === null && <p role="status" className="well m-0 p-4 text-caption text-graphite">
        Checking your food rules. If this takes too long, go Back to Foods and retry.
      </p>}
      {starterSelectionReady === false && proteinAvailability?.ready && <p role="status"
        className="well m-0 p-4 text-caption text-graphite">
        Go Back to Foods and choose at least two proteins, two carbs and two fats before using this plan.
      </p>}
      <p className={`m-0 px-1 ${CAPTION}`}>
        Starting estimate: {formula} BMR × {activity} activity
        {" = "}{rate.tdeeKcal.toLocaleString()} kcal a day,
        {" "}{rateSentence(settings.goal!, settings.goalRateBpWeek ?? null)}.
        {clamp ? ` ${clamp}` : ""} It updates as you log and weigh in.
      </p>
    </div>
  );
}
