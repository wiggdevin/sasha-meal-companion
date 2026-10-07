"use client";

import { useState } from "react";
import Disclosure from "@/components/ui/Disclosure";
import ExportCard from "@/components/ExportCard";
import HealthSourcesSheet from "@/components/HealthSourcesSheet";
import SyncStatus from "@/components/SyncStatus";
import TargetModeSheet from "@/components/TargetModeSheet";
import CaloriesCard from "@/components/settings/CaloriesCard";
import AppProfileCard from "@/components/settings/AppProfileCard";
import DataAccountSection from "@/components/settings/DataAccountSection";
import SignOutCard from "@/components/settings/SignOutCard";
import HealthConnectionsSection from "@/components/settings/HealthConnectionsSection";
import MacroList from "@/components/settings/MacroList";
import ProteinLockCard from "@/components/settings/ProteinLockCard";
import ScheduleSection from "@/components/settings/ScheduleSection";
import SettingsSection from "@/components/settings/Section";
import { CAPTION, CARD_TITLE } from "@/components/settings/settings-styles";
import TargetsSection from "@/components/settings/TargetsSection";
import CuisinesSection from "@/components/settings/CuisinesSection";
import CompanionSection from "@/components/settings/CompanionSection";
import WaterSection from "@/components/settings/WaterSection";
import { useSettingsController } from "@/components/settings/use-settings-controller";
import { isExistingAccount } from "@/lib/profile/onboarding-state";
import Button from "@/components/ui/Button";
import ConfirmSheet from "@/components/ui/ConfirmSheet";
import Notice from "@/components/ui/Notice";

export default function SettingsPage() {
  const state = useSettingsController();
  const [confirmReset, setConfirmReset] = useState(false);
  if (!state) return null;

  const {
    store, settings, daily, targetsLoadFailed, targetSheetOpen, saveError,
    floors, trainingResolved, restResolved,
    trainingCaption, restCaption, proteinCaption, trainingAlert, restAlert, anyPinned,
    canOpenTargets, targetInitial, bodySheetOpen, setBodySheetOpen, loadSources, writeProfile,
    setTrainingKcal, setRestKcal, setProteinG, toggleProteinLock, resetTargets,
    setShiftMinutes, setSlotTime, setMealsPerDay,
    openTargetSheet, closeTargetSheet, saveTargets,
  } = state;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-8"
      style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}>
      <h1 className="ground m-0 px-1 text-display-md font-light leading-none tracking-display-md">
        Settings
      </h1>

      <SettingsSection title="Profile">
        <AppProfileCard settings={settings}
          setup={!settings.onboardedAt && isExistingAccount(store.firstOpenedAt)}
          training={trainingResolved} rest={restResolved} />
      </SettingsSection>

      {/* "Body profile & units" left (owner, 2026-10-05): it repeated what Edit profile edits; the
          profile card shows those details now. */}
      {saveError && <Notice tone="error" title={saveError} />}

      <HealthConnectionsSection daily={daily} onManage={() => setBodySheetOpen(true)} />
      {bodySheetOpen && daily?.response && (
        <HealthSourcesSheet sources={daily.response.sources}
          onClose={() => setBodySheetOpen(false)} onChanged={loadSources} />
      )}

      <TargetsSection settings={settings} onProfileChange={writeProfile}>
        {!trainingResolved || !restResolved ? (
          <div className="flex flex-col gap-1">
            <h3 className={`m-0 ${CARD_TITLE}`}>Finish your profile</h3>
            <p className={`m-0 ${CAPTION}`}>Add your details to get daily targets.</p>
            <a href="/onboarding" className="tap flex min-h-11 items-center text-caption text-charcoal">
              Profile
            </a>
          </div>
        ) : <>
          <CaloriesCard trainingKcal={trainingResolved.kcal}
            restKcal={restResolved.kcal} trainingCaption={trainingCaption}
            restCaption={restCaption} trainingAlert={trainingAlert} restAlert={restAlert}
            onTrainingChange={setTrainingKcal} onRestChange={setRestKcal} />

          <div className="border-t border-hairline" />
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h3 className={`m-0 ${CARD_TITLE}`}>Your daily targets</h3>
              <p className={`m-0 ${CAPTION}`}>Updates as you make changes above.</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <MacroList eyebrow="Training day" macros={trainingResolved} />
              <MacroList eyebrow="Rest day" macros={restResolved} />
            </div>
          </div>

          {/* A row inside the one Goals & targets card, not a card of its own. */}
          <Disclosure title="Advanced targets" variant="row" divider>
          <div className="flex flex-col gap-6 pt-1">
            <ProteinLockCard proteinLocked={settings.proteinLocked}
              proteinG={settings.proteinG ?? trainingResolved.protein} proteinCaption={proteinCaption}
              onToggleLock={toggleProteinLock} onProteinChange={setProteinG} />
            <Button variant="secondary" block onClick={openTargetSheet} disabled={!canOpenTargets}>
              Targets — grams or percent
            </Button>
            {targetsLoadFailed && (
              <Notice tone="error" title="Couldn’t load your targets — try again when you have a connection." />
            )}
          </div>
          </Disclosure>
        </>}
        {targetSheetOpen && targetInitial && floors && (
          <TargetModeSheet initial={targetInitial} floors={floors} saveError={saveError}
            onClose={closeTargetSheet} onSave={saveTargets} />
        )}
        {anyPinned && <Button variant="tertiary" onClick={() => setConfirmReset(true)} className="self-start">
          Reset to your plan
        </Button>}
        {confirmReset && (
          <ConfirmSheet title="Reset to your plan?" confirmLabel="Reset targets" destructive
            onCancel={() => setConfirmReset(false)}
            onConfirm={() => { setConfirmReset(false); resetTargets(); }}>
            Your own calorie and protein numbers are removed. Your targets go back to what your plan
            works out from your profile.
          </ConfirmSheet>
        )}
      </TargetsSection>

      <WaterSection settings={settings} />

      <CuisinesSection settings={settings} />

      <CompanionSection settings={settings} />

      <ScheduleSection shiftMinutes={settings.shiftMinutes} slotTimes={settings.slotTimes}
        mealsPerDay={settings.mealsPerDay} activeTargetProfile={settings.activeTargetProfile}
        onMealsPerDayChange={setMealsPerDay}
        onShiftChange={setShiftMinutes} onSlotTimeChange={setSlotTime} />

      {/* "Food preferences" left Settings (U17, 2026-10-04): its two links only led back to Foods,
          which the dock already reaches. */}
      <DataAccountSection>
        <ExportCard />
        <SyncStatus />
        <SignOutCard />
      </DataAccountSection>
    </main>
  );
}
