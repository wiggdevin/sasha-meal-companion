"use client";

import type { ActivityLevel, Goal, Settings } from "@/lib/types";
import GoalRateField, { goalChangePatch } from "@/components/GoalRateField";
import { deriveTargets, energyProfileFrom, isProfileComplete, type RateOutcome }
  from "@/lib/profile/energy";
import Card from "./Card";
import SettingsSection from "./Section";
import { CAPTION, FIELD_LABEL } from "./settings-styles";
import ActivityMismatchPrompt from "@/components/ActivityMismatchPrompt";
import GlassSelect from "@/components/ui/GlassSelect";
import ActionFeedbackToast from "@/components/ui/ActionFeedback";
import { useSettingsWrite } from "./use-settings-write";

export type GoalProfilePatch = Partial<Pick<Settings,
  "goal" | "goalRateBpWeek" | "activityLevel" | "trainingWeekdays"
>>;

const ACTIVITIES: Array<{ value: ActivityLevel; label: string }> = [
  { value: "sedentary", label: "Sedentary" },
  { value: "light", label: "Light" },
  { value: "moderate", label: "Moderate" },
  { value: "active", label: "Active" },
  { value: "very_active", label: "Very active" },
];
const GOALS: Array<{ value: Goal; label: string }> = [
  { value: "lose_fat", label: "Lose fat" },
  { value: "recomp", label: "Recomp" },
  { value: "maintain", label: "Maintain" },
  { value: "gain_muscle", label: "Gain muscle" },
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FIELD = "well min-h-11 w-full px-3 text-body outline-none";

/** What the rate did to today's number, for the picker's caption; nothing while incomplete. */
function rateOutcome(settings: Settings): RateOutcome | undefined {
  if (!isProfileComplete(settings)) return undefined;
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  try {
    return deriveTargets(energyProfileFrom(settings), noon,
      settings.trainingWeekdays?.length ?? 0).rate;
  } catch {
    return undefined;
  }
}

function selectedDays(current: number[] | null | undefined, selected: number): number[] {
  const days = current ?? [];
  return days.includes(selected)
    ? days.filter((day) => day !== selected)
    : [...days, selected].sort((left, right) => left - right);
}

export default function TargetsSection({
  settings,
  onProfileChange,
  children,
}: {
  settings: Settings;
  /** Resolves once the profile write lands; a rejection is shown as the shared alert. */
  onProfileChange: (patch: GoalProfilePatch) => void | Promise<unknown>;
  children: React.ReactNode;
}) {
  const { feedback, write } = useSettingsWrite(onProfileChange);
  return (
    <SettingsSection title="Goals & targets">
      <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
      <Card feedback={feedback.phase}>
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Goal</span>
          <GlassSelect aria-label="Goal" value={settings.goal ?? ""}
            onChange={(next) => write(goalChangePatch(next))}
            className={FIELD} options={[{ value: "", label: "Not set" }, ...GOALS]} />
        </label>
        {settings.goal && (
          <GoalRateField goal={settings.goal} value={settings.goalRateBpWeek ?? null}
            onChange={(goalRateBpWeek) => write({ goalRateBpWeek })}
            outcome={rateOutcome(settings)} fieldClass={FIELD} labelClassName={FIELD_LABEL}
            captionClassName={CAPTION} />
        )}
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Activity level</span>
          <GlassSelect aria-label="Activity level" value={settings.activityLevel ?? ""}
            onChange={(next) => write({ activityLevel: next === "" ? null : next as ActivityLevel })}
            className={FIELD} options={[{ value: "", label: "Not set" }, ...ACTIVITIES]} />
        </label>
        <ActivityMismatchPrompt />
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className={`mb-2.5 ${FIELD_LABEL}`}>Training days</legend>
          {/* One row, a week at a glance: every day is a pill, chosen days fill olive (2026-10-01:
              unchosen days were bare text on the card). */}
          <div className="grid grid-cols-7 gap-1.5">
            {WEEKDAYS.map((day, value) => {
              const active = settings.trainingWeekdays?.includes(value) ?? false;
              return (
                <button key={day} type="button" aria-label={`Training day ${day}`}
                  aria-pressed={active}
                  onClick={() => write({
                    trainingWeekdays: selectedDays(settings.trainingWeekdays, value),
                  })}
                  className={`tap day-pill min-h-11 min-w-0 rounded-full px-0 text-caption font-medium ${active ? "chip-on" : "chip-idle"}`}>
                  {SHORT_WEEKDAYS[value]}
                </button>
              );
            })}
          </div>
          <span className={CAPTION}>Choose every day you normally train.</span>
        </fieldset>
        {/* One card for goals and targets (owner, 2026-10-05): the calorie steppers, the daily
            targets and the advanced controls follow the goal fields, a hairline between groups. */}
        <div className="border-t border-hairline" />
        {children}
      </Card>
    </SettingsSection>
  );
}
