"use client";

import {
  AccountChanged, accountHandle, assertCurrent, currentAccountOrNull, isCurrent, type AccountHandle,
} from "@/lib/device/account";
import { useEffect, useRef, useState } from "react";
import type { TargetsRequest, TargetsResponse } from "@/lib/api-types";
import { applySetTargets, applyUpdateProfile, syncProfileSettings } from "@/lib/coach/apply-profile";
import type { ApplyResult } from "@/lib/coach/apply-shared";
import { canOpenTargetsSheet, postTargets, targetsToSheetInitial }
  from "@/lib/estimator-client";
import { fetchDaily, type DailyFetch } from "@/lib/health-client";
import { probeBodyCapability, readBodyCapability } from "@/lib/health/capability";
import { formatKcal, isoDaysBefore, isSameLocalDay, todayIso } from "@/lib/settings/date";
import { loadStore, saveStore, saveStoreFor } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { fetchTargetState } from "@/lib/targets/client";
import type { MacroFloors } from "@/lib/targets/percent";
import type { Settings, SlotId, Store } from "@/lib/types";

type ProfileAction = Parameters<typeof applyUpdateProfile>[0];
type TargetAction = Parameters<typeof applySetTargets>[0];
type ProfileWriteAction = Omit<ProfileAction, "actionId" | "flagged">;
type TargetWriteAction = Omit<TargetAction, "actionId" | "flagged">;
export type ProfilePatch = Partial<Pick<Settings,
  "heightCm" | "heightUnit" | "weightKg" | "weightUnit" | "birthYear" | "sex"
  | "bodyFatPct" | "bodyFatSource" | "bodyFatMeasuredOn" | "activityLevel" | "goal"
  | "goalRateBpWeek" | "trainingWeekdays"
>>;
export type TargetPin = Omit<TargetWriteAction, "kind">;

export type SettingsWriteDeps = {
  applyProfile: (action: ProfileWriteAction) => Promise<ApplyResult>;
  applyTargets: (action: TargetWriteAction) => Promise<ApplyResult>;
  syncProfile: typeof syncProfileSettings;
  load: typeof loadStore;
  save: typeof saveStore;
};

const WRITE_DEPS: SettingsWriteDeps = {
  applyProfile: (action) => applyUpdateProfile({ ...action, actionId: "settings", flagged: [] }),
  applyTargets: (action) => applySetTargets({ ...action, actionId: "settings", flagged: [] }),
  syncProfile: syncProfileSettings,
  load: loadStore,
  save: saveStore,
};

const PROFILE_ACTION_KEYS = [
  "heightCm", "weightKg", "birthYear", "sex", "bodyFatPct", "bodyFatSource", "bodyFatMeasuredOn",
  "activityLevel", "goal", "goalRateBpWeek", "trainingWeekdays",
] as const;

function failed(result: ApplyResult): string | null {
  return result.status === "failed" ? result.reason : null;
}

/** Reuse the coach's existing profile authority path; units remain display-only synchronized fields. */
export async function persistProfilePatch(
  current: Store,
  patch: ProfilePatch,
  deps: SettingsWriteDeps = WRITE_DEPS,
): Promise<Store> {
  const actionFields: Record<string, unknown> = {};
  const directFields: ProfilePatch = {};
  for (const [key, value] of Object.entries(patch) as Array<[keyof ProfilePatch, unknown]>) {
    if (key === "heightUnit" || key === "weightUnit") {
      Object.assign(directFields, { [key]: value });
    } else if ((PROFILE_ACTION_KEYS as readonly string[]).includes(key)) {
      actionFields[key] = value;
    }
  }

  // Phase 9 §0.2 (PR #248 review r1 #5): the account that started the edit; after every await
  // nothing is read or written unless it is still the one bound.
  const h = currentAccountOrNull();
  const stillMine = (): void => { if (h !== null) assertCurrent(h); };
  let latest = current;
  if (Object.keys(actionFields).length > 0) {
    const result = await deps.applyProfile({
      kind: "update_profile", ...actionFields,
    } as ProfileWriteAction);
    stillMine();
    const reason = failed(result);
    if (reason) throw new Error(reason);
    latest = deps.load();
  }
  if (Object.keys(directFields).length > 0) {
    const next: Store = { ...latest, settings: { ...latest.settings, ...directFields } };
    stillMine();
    await deps.syncProfile(next.settings, h ?? undefined, Object.keys(directFields) as (keyof Settings)[]);
    stillMine();
    deps.save(next);
    latest = next;
  }
  return latest;
}

/** Common calorie/protein controls share the same target revision action used by the coach. */
export async function persistTargetPin(
  pin: TargetPin,
  deps: SettingsWriteDeps = WRITE_DEPS,
): Promise<Store> {
  const h = currentAccountOrNull();
  const result = await deps.applyTargets({ kind: "set_targets", ...pin });
  if (h !== null) assertCurrent(h);
  const reason = failed(result);
  if (reason) throw new Error(reason);
  return deps.load();
}

/** Health reads go only where the account has health on: a cached "disabled" answer, or one shared
 *  probe that says so, means no `/api/health/daily` window request (and no 503) from Settings. */
export async function fetchDailyIfEnabled(h: AccountHandle, from: string, to: string): Promise<DailyFetch | null> {
  const known = readBodyCapability();
  const capability = known !== "unknown" ? known : await probeBodyCapability();
  if (capability === "disabled") return null;
  return fetchDaily(h, from, to);
}

function localPatch(h: AccountHandle | null, current: Store, patch: Partial<Settings>): Store {
  const next = { ...current, settings: { ...current.settings, ...patch } };
  if (h === null) saveStore(next);
  else saveStoreFor(h, next);
  return next;
}

export function useSettingsController() {
  const [store, setStore] = useState<Store | null>(null);
  const pinQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [bodySheetOpen, setBodySheetOpen] = useState(false);
  const [daily, setDaily] = useState<DailyFetch | null>(null);
  const [targets, setTargets] = useState<TargetsResponse | null>(null);
  const [targetsLoadFailed, setTargetsLoadFailed] = useState(false);
  const [targetSheetOpen, setTargetSheetOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function loadSources(): void {
    const to = todayIso();
    const h = currentAccountOrNull();
    if (h === null) return;
    void fetchDailyIfEnabled(h, isoDaysBefore(to, 21), to)
      .then((result) => { if (result !== null) setDaily(result); }).catch(() => {});
  }

  useEffect(() => {
    const h = currentAccountOrNull();
    if (h === null) return;
    let live = true;
    const to = todayIso();
    void fetchDailyIfEnabled(h, isoDaysBefore(to, 21), to)
      .then((result) => { if (live && result !== null) setDaily(result); }).catch(() => {});
    return () => { live = false; };
  }, []);

  // The calorie steppers and "Your daily targets" read the SERVER's resolved numbers. A profile
  // change or a pin writes a new revision, so the page has to read it back: before this, the
  // numbers only moved after a reload (owner report, 2026-09-22: "calories aren't updating when I change
  // my intake values"). A failed read keeps the last numbers on screen rather than blanking them.
  // One loader serves the mount read and every refresh, so the unmount guard cannot be forgotten
  // in one of them; it runs unconditionally after a write because a profile edit can be the one
  // that completes the profile and turns `needs_profile` into a first revision.
  // `live` is set true in the effect SETUP, not at declaration: Strict Mode runs setup → cleanup →
  // setup on the same instance and keeps the ref, so a flag that is only ever cleared would stay
  // false after the simulated remount and every read would no-op. `generation` drops a stale
  // answer when two reads overlap (rapid stepper taps), so an older revision cannot land last.
  const live = useRef(false);
  const generation = useRef(0);
  // The last good numbers, set beside every setTargets call. Not a sync effect: the markup test's
  // effect budget counts mount effects, and a fourth one would silently skip the store load.
  const targetsRef = useRef<TargetsResponse | null>(null);
  function refreshTargets(): void {
    const id = ++generation.current;
    void fetchTargetState().then(
      (result) => {
        if (!live.current || id !== generation.current) return;
        targetsRef.current = result.target;
        setTargets(result.target);
        setTargetsLoadFailed(false);
      },
      () => {
        if (!live.current || id !== generation.current) return;
        // A failed re-read after a write keeps the last good numbers on screen; only a read that
        // has nothing to fall back on shows the "couldn't load" line.
        setTargetsLoadFailed((failed) => failed || targetsRef.current === null);
      },
    );
  }
  useEffect(() => {
    live.current = true;
    refreshTargets();
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(loadStore());
    const onSynced = () => setStore(loadStore());
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(SYNCED_EVENT, onSynced);
  }, []);

  if (!store) return null;
  const settings = store.settings;
  const trainingResolved = targets?.resolved.training ?? null;
  const restResolved = targets?.resolved.rest ?? null;
  const floors: MacroFloors | null = targets?.revision?.floors ?? null;
  const changedToday = settings.changedAt
    ? isSameLocalDay(settings.changedAt, todayIso())
    : false;

  function commit(patch: Partial<Settings>): void {
    setStore(localPatch(null, loadStore(), patch)); // a click: the bound account, this tick
  }

  function pinCaption(value: number | null, base: number | undefined, unit: string): string | null {
    if (value === null) return null;
    if (base === undefined) return null;
    const formatted = unit === "kcal" ? formatKcal(base) : String(base);
    return changedToday
      ? `Changed today — your plan was ${formatted}${unit === "kcal" ? "" : ` ${unit}`}.`
      : `Pinned by you — your plan would have moved to ${formatted}${unit === "kcal" ? "" : ` ${unit}`}.`;
  }

  /** Resolves once the write lands; a failure rejects, and the section shows the shared alert. */
  function writeProfile(patch: ProfilePatch): Promise<void> {
    setSaveError(null);
    return persistProfilePatch(loadStore(), patch).then(
      (next) => { setStore(next); refreshTargets(); },
      (e: unknown) => {
        if (e instanceof AccountChanged) return; // another account now: nothing of this edit shows
        throw e;
      },
    );
  }

  function writePin(pin: TargetPin): void {
    setSaveError(null);
    // In tap order: a pin waits for the one before it, so a slow first tap never lands after a later
    // one and shows its older value (UI audit r1).
    const run = pinQueue.current.catch(() => {}).then(() => persistTargetPin(pin));
    pinQueue.current = run;
    void run.then(
      (next) => { setStore(next); refreshTargets(); },
      (e: unknown) => {
        if (e instanceof AccountChanged) return;
        setSaveError("Couldn't save your targets — try again when you have a connection.");
      },
    );
  }

  function resetTargets(): void {
    setSaveError(null);
    const h = currentAccountOrNull();
    // The same queue as the steppers: a tap still in flight never lands after the reset (UI audit r2).
    const run = pinQueue.current.catch(() => {}).then(() => persistTargetPin({ dayType: "both", kcal: null, proteinG: null }));
    pinQueue.current = run;
    void run.then(
      (next) => {
        if (h !== null && !isCurrent(h)) return;
        setStore(localPatch(h, next, { proteinLocked: true }));
        refreshTargets();
      },
      (e: unknown) => {
        if (e instanceof AccountChanged) return;
        setSaveError("Couldn't reset your targets — try again when you have a connection.");
      },
    );
  }

  function setTrainingKcal(kcal: number): void {
    writePin({ dayType: "training", kcal });
  }

  function setRestKcal(kcal: number): void {
    writePin({ dayType: "rest", kcal });
  }

  function saveTargets(request: TargetsRequest): void {
    setSaveError(null);
    // The same queue as the steppers and the reset: a double tap on Save sends in order, and the last
    // save is the one that stays (UI audit r3).
    const run = pinQueue.current.catch(() => {}).then(() => postTargets(request));
    pinQueue.current = run;
    void run.then(
      (updated) => { targetsRef.current = updated; setTargets(updated); setTargetSheetOpen(false); },
      () => setSaveError("Couldn't save your targets — try again when you have a connection."),
    );
  }

  return {
    store, settings, daily, targets, targetsLoadFailed, targetSheetOpen, saveError,
    floors, trainingResolved, restResolved,
    trainingCaption: pinCaption(settings.trainingKcal, trainingResolved?.kcal, "kcal"),
    restCaption: pinCaption(settings.restKcal, restResolved?.kcal, "kcal"),
    proteinCaption: pinCaption(settings.proteinG, trainingResolved?.protein, "g"),
    trainingAlert: null,
    restAlert: null,
    anyPinned: settings.trainingKcal !== null || settings.restKcal !== null
      || settings.proteinG !== null,
    canOpenTargets: canOpenTargetsSheet(targets) && floors !== null,
    targetInitial: targets ? targetsToSheetInitial(targets) : null,
    bodySheetOpen,
    setBodySheetOpen,
    loadSources,
    writeProfile,
    setTrainingKcal,
    setRestKcal,
    setProteinG: (proteinG: number) => writePin({ dayType: "both", proteinG }),
    toggleProteinLock: () => commit({ proteinLocked: !settings.proteinLocked }),
    resetTargets,
    setShiftMinutes: (shiftMinutes: number) => commit({ shiftMinutes }),
    setMealsPerDay: (mealsPerDay: number) => {
      if (!Number.isInteger(mealsPerDay) || mealsPerDay < 2 || mealsPerDay > 6) return;
      const next = localPatch(null, loadStore(), { mealsPerDay });
      setStore(next);
      void syncProfileSettings(next.settings, accountHandle(), ["mealsPerDay"]).catch(() =>
        setSaveError("Couldn't save your meal count — try again when you have a connection."));
    },
    setSlotTime: (slot: SlotId, time: string | null) => {
      const slotTimes = { ...settings.slotTimes };
      if (time === null) delete slotTimes[slot]; else slotTimes[slot] = time;
      commit({ slotTimes });
    },
    openTargetSheet: () => setTargetSheetOpen(true),
    closeTargetSheet: () => { setTargetSheetOpen(false); setSaveError(null); },
    saveTargets,
  };
}
