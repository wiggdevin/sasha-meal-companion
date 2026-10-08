"use client";
import {
  accountHandle, assertCurrent, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";

import { publishBodyProfile } from "@/lib/body-profile-client";
import {
  loadConstraints, saveConstraints, type Profile, type SaveResult,
} from "@/lib/constraints-client";
import { localIsoDay, todayIso } from "@/lib/settings/date";
import { isProfileComplete } from "@/lib/profile/energy";
import { targetSourceFor } from "@/lib/profile/derive";
import { getDay, loadStore, saveStore } from "@/lib/store";
import { getRow } from "@/lib/sync/idb";
import { openFoodWorldAtOnboarding } from "@/lib/foods/world-open-client";
import { mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { settingsProfileFromRow, settingsProfileToRow,
  type UserSettingsProfileRow } from "@/lib/sync/user-settings";
import {
  persistDerivedTargetRevision, settingsWithTargetRevision,
} from "@/lib/targets/client";
import { latestWeighInKg, saveMorningWeight } from "@/lib/today/water-and-weight";
import type { Settings, TargetRevision } from "@/lib/types";
import {
  eligibilityFromSafetyAnswers, RATE_HOLDS, safetyConditionEntries, type SafetyAnswers,
  type TargetEligibility,
} from "@/lib/profile/rate-eligibility";
import {
  buildCompletedSettings, buildSkippedSettings, changedPlanFields, constraintPatchForFlags,
  type OnboardingState, type PlanField, type PreferenceFlag, weightLbFor,
} from "./onboarding-state";

export async function loadOnboardingSettings(): Promise<Settings> {
  const h = accountHandle();
  const local = loadStore().settings;
  try {
    const row = await getRow(h, "user_settings", USER_SETTINGS_KEY) as UserSettingsProfileRow | undefined;
    return row ? { ...local, ...settingsProfileFromRow(row) } : local;
  } catch (e) {
    rethrowAccountChanged(e);
    return local;
  }
}

export type OnboardingSaveMode = "complete" | "skip";

export const CONSTRAINTS_UNAVAILABLE = "constraints_unavailable" as const;
export const CONSTRAINT_SAVE_WARNING =
  "Your allergen rules could not be saved — retry from Foods › Avoids";
/**
 * The account's own `user_settings` row is what releases the gate, so a setup flow that navigated
 * while that write was still queued sent a finished account back to step 1 on the next load. The
 * flow drains first (lib/sync/client.ts flushOutboxNow) and says this when the drain did not land:
 * the same warning-and-retry shape as CONSTRAINT_SAVE_WARNING, one line above the primary action.
 */
export const ONBOARDING_SYNC_WARNING =
  "Your setup could not be saved to your account — check your connection and try again";

/**
 * The gate's other half, and the reason `flushOutboxNow`'s answer is not enough on its own: it
 * reports "no whole-row `user_settings` op is queued any more", and a `drop` settlement — the answer
 * to a write the server refuses as unsupported, or one it says it is already done with — ALSO empties
 * the queue without the server row being written (lib/sync/settings-intents.ts:75). So the caller
 * reads the MIRROR too: the row the phone keeps for the server's `user_settings`, which this write put
 * there and which every pull rebuilds from the server's own row (lib/sync/client.ts
 * applyAndMirrorPulledUserSettings). It is the same row `loadOnboardingSettings` reads, through the
 * same reader, so "the mirror has no `onboarded_at`" means "the server has not been told".
 *
 * Fails closed: a row that cannot be read (no IndexedDB, a closed database) is `null`, never a
 * confirmed absence — an account may not leave onboarding on a question this device could not answer.
 */
export async function mirroredOnboardedAt(): Promise<string | null> {
  const h = accountHandle();
  try {
    const row = await getRow(h, "user_settings", USER_SETTINGS_KEY) as
      UserSettingsProfileRow | undefined;
    return settingsProfileFromRow(row ?? {}).onboardedAt ?? null;
  } catch (e) {
    rethrowAccountChanged(e);
    return null;
  }
}

export async function saveOnboardingSettings(
  settings: Settings,
  mode: OnboardingSaveMode = "complete",
  pinFields: readonly PlanField[] = [],
  writeTargets: typeof persistDerivedTargetRevision = persistDerivedTargetRevision,
  readLatestWeighIn: typeof latestWeighInKg = latestWeighInKg,
  /** The save's one target request id (see `persistCompletedOnboarding`). */
  targetRequestId?: string,
): Promise<TargetRevision | undefined> {
  const h = accountHandle();
  // The revision dates from the LOCAL day onboarding finished, not the UTC day: an evening
  // completion in a negative-offset zone would otherwise leave today with no target (lane G).
  const targetDate = settings.onboardedAt ? localIsoDay(settings.onboardedAt) : undefined;
  // The id rides as a trailing argument only when the caller minted one.
  const write = (input: Parameters<typeof writeTargets>[0]) => targetRequestId === undefined
    ? writeTargets(input) : writeTargets(input, undefined, undefined, targetRequestId);
  const revision = mode === "complete" && targetDate && isProfileComplete(settings)
    ? await write({
        settings,
        latestWeighInKg: readLatestWeighIn(targetDate, settings),
        today: targetDate,
        // No weekday template (D1 §6.3): an account that named no training day trains on none.
        trainingWeekdays: settings.trainingWeekdays ?? [],
        source: targetSourceFor(settings),
      })
    : undefined;
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    const { rev: _rev, user_id: _userId, ...stored } = row;
    void _rev; void _userId;
    const profile = mode === "skip"
      ? { onboarded_at: settings.onboardedAt ?? null }
      : {
          ...settingsProfileToRow(settings),
          ...(pinFields.includes("trainingKcal")
            ? { training_kcal: settings.trainingKcal } : {}),
          ...(pinFields.includes("restKcal") ? { rest_kcal: settings.restKcal } : {}),
          ...(pinFields.includes("proteinG") ? { protein_g: settings.proteinG } : {}),
        };
    const payload = { ...stored, ...profile };
    return {
      row: { ...row, ...payload },
      op: {
        op_id: crypto.randomUUID(),
        entity: "user_settings" as const,
        entity_id: USER_SETTINGS_KEY,
        kind: rev === null ? "create" as const : "update" as const,
        base_rev: rev,
        payload,
        client_ts: new Date().toISOString(),
      },
      result: undefined,
    };
  });
  publishBodyProfile();
  return revision;
}

type ConstraintLoad = { profile: Profile; rev: number } | null;

export type OnboardingPersistence = {
  saveLocal: (settings: Settings) => void;
  saveSynced: (
    settings: Settings,
    mode: OnboardingSaveMode,
    pinFields?: readonly PlanField[],
    targetRequestId?: string,
  ) => Promise<TargetRevision | undefined | void>;
  saveWeighIn: (localDate: string, lb: number) => Promise<string | null>;
  loadConstraints: () => Promise<ConstraintLoad>;
  saveConstraints: (patch: Parameters<typeof saveConstraints>[0], rev: number) => Promise<SaveResult>;
  localDate: () => string;
  hasWeighIn: (localDate: string) => boolean;
  /** W13 (D14): "New accounts become open at onboarding completion." Never fails onboarding;
   *  a transient failure is retried after later sync passes until the server settles it
   *  (lib/foods/world-open-client.ts). */
  openFoodWorld: (h: AccountHandle) => Promise<void>;
};

/**
 * Exported for its own test; every onboarding caller reaches it only through `persistence`.
 * Durable since Sol round 2: lib/foods/world-open-client.ts records a pending intent before
 * any network call and retries it after every successful sync until the server settles it.
 */
export async function openFoodWorld(h: AccountHandle): Promise<void> {
  await openFoodWorldAtOnboarding(h);
}

const persistence: OnboardingPersistence = {
  saveLocal: (settings) => saveStore({ ...loadStore(), settings }),
  saveSynced: (settings, mode, pinFields, targetRequestId) =>
    saveOnboardingSettings(settings, mode, pinFields, undefined, undefined, targetRequestId),
  saveWeighIn: (date, lb) => saveMorningWeight(date, lb, () => {}, { skipTargets: true }),
  loadConstraints: () => loadConstraints(),
  saveConstraints: (patch, rev) => saveConstraints(patch, rev),
  localDate: todayIso,
  hasWeighIn: (localDate) => typeof getDay(localDate)?.weightLb === "number",
  openFoodWorld,
};

const constraintsUnavailable = () => ({
  constraintsSaved: false as const,
  error: CONSTRAINTS_UNAVAILABLE,
});

/**
 * Finishing onboarding ALWAYS writes the account's `constraint_profiles` row (D1 §6.1), even when
 * no preference chip was chosen and every array stays empty. The row is what makes "this account
 * restricts nothing" a recorded fact rather than the absence of one, now that no default exists
 * in code — and a PUT at baseRev 0 is the only thing that creates it.
 */
async function applyFlagConstraints(
  h: AccountHandle,
  flags: readonly PreferenceFlag[],
  deps: Pick<OnboardingPersistence, "loadConstraints" | "saveConstraints">,
  conditions: readonly string[] = [],
): Promise<{ constraintsSaved: true } | { constraintsSaved: false; error: string }> {
  // PR #248 review r2 #1: every await is followed by a check of the handle the flow started with.
  const loaded = await deps.loadConstraints();
  assertCurrent(h);
  if (!loaded) return constraintsUnavailable();
  let result = await deps.saveConstraints(
    { ...(constraintPatchForFlags(flags, loaded.profile, conditions) ?? {}), baseRev: loaded.rev },
    loaded.rev,
  );
  assertCurrent(h);
  if (result.status === "ok") return { constraintsSaved: true };
  if (result.status === "error") return constraintsUnavailable();
  // One rebase onto the profile the conflict returned, then give up and say so.
  result = await deps.saveConstraints(
    { ...(constraintPatchForFlags(flags, result.profile, conditions) ?? {}), baseRev: result.rev },
    result.rev,
  );
  return result.status === "ok" ? { constraintsSaved: true } : constraintsUnavailable();
}

/** Retry only the direct constraint write; never mint a second target revision or weigh-in. */
export async function retryOnboardingConstraints(flags: readonly PreferenceFlag[]): Promise<boolean> {
  const h = accountHandle();
  return (await applyFlagConstraints(h, flags, persistence)).constraintsSaved;
}

export type CompletedOnboardingResult = {
  settings: Settings;
  constraintsSaved: boolean;
  error?: string;
  /** False when the safety round's condition write failed before anything else was written (no
   *  weigh-in, settings or target): a retry must run the whole save again (final Sol review r3). */
  profileWritten?: false;
};

/**
 * `safety` is the safety round's taps (lib/profile/rate-eligibility.ts). When they add condition
 * entries, the constraint row is written FIRST, so the target revision the server derives next
 * already sees the hold (a held account derives at a 0 pace; kidney disease, standard protein).
 * If that write fails, nothing else is written and the caller offers the step again.
 */
export async function persistCompletedOnboarding(
  base: Settings,
  state: OnboardingState,
  now = new Date(),
  deps: OnboardingPersistence = persistence,
  safety: SafetyAnswers = {},
  /** GPT-6 Sol BLOCK (onb2-p0): minted ONCE per onboarding save and sent on every attempt, so a
   *  retry after a lost target answer is the same request and the server writes one revision. */
  targetRequestId?: string,
  /** The account's stored pace holds the shell planned under (final Sol review BLOCK): merged
   *  with this round's taps, so a stored hold the round did not repeat builds the same held plan
   *  the screen showed, instead of failing as an incomplete profile with no pace. */
  storedEligibility?: TargetEligibility | null,
): Promise<CompletedOnboardingResult> {
  const h = accountHandle();
  const conditions = safetyConditionEntries(safety);
  const round = eligibilityFromSafetyAnswers(safety);
  const eligibility: TargetEligibility = storedEligibility ? {
    holds: RATE_HOLDS.filter((hold) => round.holds.includes(hold) || storedEligibility.holds.includes(hold)),
    minor: round.minor || storedEligibility.minor,
  } : round;
  const settings = buildCompletedSettings(base, state, now, eligibility);
  if (conditions.length > 0) {
    const first = await applyFlagConstraints(h, state.flags, deps, conditions);
    if (!first.constraintsSaved) return { settings: base, ...first, profileWritten: false };
  }
  const weightLb = weightLbFor(state);
  const localDate = deps.localDate();
  if (weightLb !== null
    && (settings.weightKg !== base.weightKg || !deps.hasWeighIn(localDate))) {
    await deps.saveWeighIn(localDate, weightLb);
  }
  // PR #248 review r2 #1: a weigh-in answered after a switch must not lead into B's settings.
  assertCurrent(h);
  // ONB2-P0 (GOAL defect 6): the settings+target-revision write and the constraints write touch
  // different rows and neither reads the other's result, so they no longer wait on each other —
  // only the weigh-in stays before both (`writeTargets` reads it through `latestWeighInKg`).
  // G7: a safety-round condition patch was already written (with the flags) before the target, so
  // there is no second constraints write then.
  const [revision, constraints] = await Promise.all([
    targetRequestId === undefined
      ? deps.saveSynced(settings, "complete", changedPlanFields(base, settings))
      : deps.saveSynced(settings, "complete", changedPlanFields(base, settings), targetRequestId),
    conditions.length > 0
      ? Promise.resolve({ constraintsSaved: true } as const)
      : applyFlagConstraints(h, state.flags, deps),
  ]);
  const savedSettings = revision ? settingsWithTargetRevision(settings, revision) : settings;
  assertCurrent(h);
  deps.saveLocal(savedSettings);
  // W13 (D14): only a FIRST completion opens the world — a later re-run of this same function
  // (an account editing its profile again) must never re-invite an account that chose `closed`.
  // A completion that wrote safety conditions stays closed (a condition closes an open account).
  if (!base.onboardedAt && conditions.length === 0) await deps.openFoodWorld(h);
  return { settings: savedSettings, ...constraints };
}

/**
 * A skip is onboarding COMPLETION with no answers, so D1 §6.1 applies to it in full: it leaves the
 * account's `constraint_profiles` row behind, all arrays empty, PUT at baseRev 0 exactly as the
 * answered path does.
 *
 * The row is written FIRST. `saveSynced` is what stamps `onboarded_at`, which is what turns the
 * account's disposition from `force` into `none` and opens the gate — so an account may not leave
 * onboarding until the row that says "this account restricts nothing" exists. `constraint_profiles`
 * is not outbox-synced (lib/constraints-client.ts:1-7), so there is no durable queue to fall back
 * on: a failed PUT throws, onboarding stays put and the caller offers the step again.
 *
 * The `onboarded_at` stamp itself is the other half, and it is queued, not sent: the flow drains
 * that op before it navigates (lib/sync/client.ts flushOutboxNow, from
 * components/Onboarding/OnboardingFlow.tsx), because the gate re-reads the SERVER row and a queued
 * stamp is what sent a finished account back to step 1.
 */
export async function persistSkippedOnboarding(
  base: Settings,
  now = new Date(),
  deps: Pick<
    OnboardingPersistence,
    "saveLocal" | "saveSynced" | "loadConstraints" | "saveConstraints" | "openFoodWorld"
  > = persistence,
): Promise<Settings> {
  const h = accountHandle();
  const constraints = await applyFlagConstraints(h, [], deps);
  if (!constraints.constraintsSaved) throw new Error(CONSTRAINTS_UNAVAILABLE);
  const settings = buildSkippedSettings(base, now);
  assertCurrent(h);
  deps.saveLocal(settings);
  await deps.saveSynced(settings, "skip");
  // W13 (D14): a skip IS onboarding completion (D1 §6.1; it stamps `onboarded_at` the same as the
  // answered path), so it must open the world on a FIRST skip exactly like a first "complete" —
  // otherwise an account that skips onboarding can never be invited at all, because `base.onboardedAt`
  // is set by this same stamp and every later call (skip or complete) would see it already set.
  if (!base.onboardedAt) await deps.openFoodWorld(h);
  return settings;
}
