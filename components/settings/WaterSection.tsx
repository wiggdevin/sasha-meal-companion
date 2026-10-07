"use client";

import { useEffect, useState } from "react";
import ActionFeedbackToast from "@/components/ui/ActionFeedback";
import Chip from "@/components/ui/Chip";
import { AccountChanged } from "@/lib/device/account";
import { formatWeight } from "@/lib/health/units";
import { todayIso } from "@/lib/settings/date";
import { loadStore, saveStore } from "@/lib/store";
import type { ProfileDietPrefs } from "@/lib/sync/user-settings";
import { waterGoalWeightKg } from "@/lib/today/water-and-weight";
import type { Settings } from "@/lib/types";
import { goalColumnFor, WATER_GOAL_MIN, WATER_GOAL_UI_MAX } from "@/lib/water";
import { readWaterSettings, setGoal, setWaterPrefs, type WaterSettings } from "@/lib/water-client";
import { hasManualGoal, resolveWaterGoal, waterWeightKg } from "@/lib/water-goal";
import { waterUnitFor, type WaterGoalMode, type WaterPrefs } from "@/lib/water-prefs";
import { formatWater, UNIT_NAMES, WATER_UNITS, type WaterUnit } from "@/lib/water-units";
import Card from "./Card";
import SettingsSection from "./Section";
import { useSettingsWrite } from "./use-settings-write";
import { CAPTION, FIELD_LABEL, ROW_TITLE, ROW_VALUE } from "./settings-styles";

/**
 * Settings › Water (2026-10-03): the unit every water readout uses, and the daily goal — auto from
 * body weight (lib/water-goal.ts) or the account's own per-day-type goal. An account that set a
 * goal by hand stays on it, and is told the auto goal is there.
 */
type DayKind = "training-10" | "rest";
type WaterPatch = { unit: WaterUnit } | { mode: WaterGoalMode } | { cups: number; dayType: DayKind };

const EMPTY: WaterSettings = { stored: {}, prefs: {}, profileWeightKg: null };
const MARK = "flex h-7 w-7 items-center justify-center rounded-full border border-hairline text-[16px] leading-none text-graphite";

/** Keep the phone's settings blob in step, so a later profile or onboarding save carries the prefs. */
function mirrorPrefs(prefs: WaterPrefs): void {
  try {
    const store = loadStore();
    const dietPrefs: ProfileDietPrefs = { ...(store.settings.dietPrefs ?? { flags: [] }), water: prefs };
    saveStore({ ...store, settings: { ...store.settings, dietPrefs } }, { silent: true });
  } catch (error) {
    if (!(error instanceof AccountChanged)) throw error;
  }
}

function GoalStepper({ label, cups, unit, onChange }: {
  label: string; cups: number; unit: WaterUnit; onChange: (cups: number) => void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <span className={ROW_TITLE}>{label}</span>
      <div role="group" aria-label={`${label} water goal`} className="flex items-center">
        <button type="button" aria-label={`Lower the ${label.toLowerCase()} goal`} disabled={cups <= WATER_GOAL_MIN}
          onClick={() => onChange(cups - 1)} className="tap flex h-11 w-11 items-center justify-center disabled:opacity-40">
          <span aria-hidden="true" className={MARK}>−</span>
        </button>
        <span className={`min-w-20 text-center tabular-nums ${ROW_VALUE}`}>{formatWater(cups, unit)}</span>
        <button type="button" aria-label={`Raise the ${label.toLowerCase()} goal`} disabled={cups >= WATER_GOAL_UI_MAX}
          onClick={() => onChange(cups + 1)} className="tap flex h-11 w-11 items-center justify-center disabled:opacity-40">
          <span aria-hidden="true" className={MARK}>+</span>
        </button>
      </div>
    </div>
  );
}

export default function WaterSection({ settings }: { settings: Settings }) {
  const [water, setWater] = useState<WaterSettings | null>(null);
  useEffect(() => {
    let live = true;
    void readWaterSettings().then((read) => { if (live) setWater(read); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const current = water ?? EMPTY;
  const prefs: WaterPrefs = water?.prefs ?? (settings.dietPrefs as ProfileDietPrefs | null | undefined)?.water ?? {};
  const unit = waterUnitFor(prefs);
  const weightKg = waterWeightKg(waterGoalWeightKg(todayIso(), settings), current.profileWeightKg);
  const rest = resolveWaterGoal({ dayType: "rest", stored: current.stored, prefs, weightKg });
  const training = resolveWaterGoal({ dayType: "training-10", stored: current.stored, prefs, weightKg });
  const autoLine = rest.autoCups === training.autoCups
    ? `${formatWater(rest.autoCups, unit)} a day`
    : `${formatWater(rest.autoCups, unit)} a day, ${formatWater(training.autoCups, unit)} on training days`;

  const { feedback, write } = useSettingsWrite<WaterPatch>(async (patch) => {
    if ("unit" in patch || "mode" in patch) {
      const next = await setWaterPrefs("unit" in patch ? { unit: patch.unit } : { goal: patch.mode });
      mirrorPrefs(next);
      return;
    }
    await setGoal(patch.cups, patch.dayType);
    mirrorPrefs({ ...prefs, goal: "manual" });
  });

  /** Shown at once; the write follows through the shared feedback. */
  function change(patch: WaterPatch): void {
    setWater((w) => {
      const base = w ?? current;
      if ("unit" in patch) return { ...base, prefs: { ...base.prefs, unit: patch.unit } };
      if ("mode" in patch) return { ...base, prefs: { ...base.prefs, goal: patch.mode } };
      return { ...base, prefs: { ...base.prefs, goal: "manual" },
        stored: { ...base.stored, [goalColumnFor(patch.dayType)]: patch.cups } };
    });
    write(patch);
  }

  function chooseMode(mode: WaterGoalMode): void {
    if (mode === rest.mode) return;
    // A first "My own" starts from today's auto numbers rather than the columns' untouched 8s.
    if (mode === "manual" && !hasManualGoal(current.stored)) {
      change({ cups: training.autoCups, dayType: "training-10" });
      change({ cups: rest.autoCups, dayType: "rest" });
      return;
    }
    change({ mode });
  }

  return (
    <SettingsSection title="Water">
      <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
      <Card feedback={feedback.phase}>
        <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
          <legend className={`mb-1.5 ${FIELD_LABEL}`}>Units</legend>
          <div className="pill-in grid min-h-11 grid-cols-3 gap-1 p-1" aria-label="Water unit">
            {WATER_UNITS.map((candidate) => (
              <Chip key={candidate} aria-label={UNIT_NAMES[candidate]} selected={unit === candidate}
                onClick={() => { if (unit !== candidate) change({ unit: candidate }); }}>{candidate}</Chip>
            ))}
          </div>
          <span className={CAPTION}>A cup is 8 oz (237 ml). Today and the overview count in this unit.</span>
        </fieldset>
        {water && <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
          <legend className={`mb-1.5 ${FIELD_LABEL}`}>Daily goal</legend>
          <div className="pill-in grid min-h-11 grid-cols-2 gap-1 p-1" aria-label="Water goal">
            <Chip aria-label="Auto (from your weight)" selected={rest.mode === "auto"}
              onClick={() => chooseMode("auto")}>Auto</Chip>
            <Chip aria-label="My own goal" selected={rest.mode === "manual"}
              onClick={() => chooseMode("manual")}>My own</Chip>
          </div>
          {rest.mode === "auto" ? <span className={CAPTION}>
            {weightKg === null ? `${autoLine} until your profile has a weight.`
              : `From your weight (${formatWeight(weightKg, settings.weightUnit ?? "lb")}): ${autoLine}.`}
          </span> : <>
            <GoalStepper label="Training days" cups={training.manualCups} unit={unit}
              onChange={(cups) => change({ cups, dayType: "training-10" })} />
            <GoalStepper label="Rest days" cups={rest.manualCups} unit={unit}
              onChange={(cups) => change({ cups, dayType: "rest" })} />
            <span className={CAPTION}>Auto (from your weight) is available: {autoLine}.</span>
          </>}
        </fieldset>}
      </Card>
    </SettingsSection>
  );
}
