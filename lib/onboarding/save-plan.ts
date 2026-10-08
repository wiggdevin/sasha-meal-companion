"use client";

/**
 * ONB2-P0 (GOAL defect 6, live QA 2026-10-08): the one-await save path "Use this plan" calls.
 *
 * The old inline handler (`ConversationalOnboarding.tsx`'s `savePlanAndFinish`, now superseded by
 * this file — see CONTRACT onb2-p0-save in coord.md) ran every step in series: the settings+
 * target-revision write, then the constraints write, then a fresh rules re-read
 * (`useStarterStep`'s `reread()`), then ANOTHER fresh rules read inside
 * `persistStarterSelection`'s own recheck, then one awaited `setFoodMembership(...,
 * { acknowledge: true })` server round trip per starter food, in series. For a pick-for-me
 * selection (6-12 foods) that is 6-12 sequential RPCs on top of everything else, which the live
 * QA measured at 8+ seconds.
 *
 * This function:
 *   - runs the settings+target-revision write and the constraints write in parallel
 *     (`lib/profile/onboarding-client.ts`'s own `persistCompletedOnboarding`, updated alongside
 *     this file — neither write reads the other's result);
 *   - reads the account's food rules exactly ONCE for the starter step (not twice), and passes
 *     that one read into `persistStarterSelection`'s own pre-write recheck instead of letting it
 *     re-fetch — ONB2-RULE-REREAD stays enforced (a rule saved between "Use this plan" and the
 *     write still fails the write closed), it just never costs a second network round trip;
 *   - writes every starter food's membership op WITHOUT its own acknowledgement round trip
 *     (`lib/foods/starter-client.ts`'s `defaultStarterWriter`, also updated alongside this file),
 *     in bounded-concurrency batches rather than one at a time, and leaves the one
 *     `flushOutboxNow` pass below to actually deliver them — every production path already ran
 *     that pass before leaving onboarding, so this costs nothing extra.
 *
 * No safety rule moves: the selection is still validated against a FRESH read before anything is
 * written, a selection a fresh rule drops below the two-per-role (or, for a legacy account, the
 * per-meal protein) floor still fails the whole write with one clean error, and a rules read that
 * fails (offline, a switched account) still fails closed rather than falling back to a stale list.
 */

import { accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";
import { loadConstraints, type Profile } from "@/lib/constraints-client";
import { fetchProfileInstances } from "@/lib/profile/instances-client";
import type { ProfileInstance } from "@/lib/policy/profiles/types";
import {
  starterChoices, starterSelectionValid, type Starter, type StarterMark,
} from "@/lib/foods/starter";
import { starterProteinAvailability } from "@/lib/foods/starter-availability";
import {
  defaultStarterWriter, persistStarterSelection, STARTER_RULE_CHANGED_ERROR,
  STARTER_RULES_UNAVAILABLE_ERROR, type StarterWriter,
} from "@/lib/foods/starter-client";
import {
  CONSTRAINT_SAVE_WARNING, mirroredOnboardedAt, ONBOARDING_SYNC_WARNING,
  persistCompletedOnboarding, retryOnboardingConstraints,
} from "@/lib/profile/onboarding-client";
import type { OnboardingState } from "@/lib/profile/onboarding-state";
import { safetyConditionEntries, type SafetyAnswers } from "@/lib/profile/rate-eligibility";
import { flushOutboxNow } from "@/lib/sync/client";
import type { Settings } from "@/lib/types";

type FreshStarterRules = { profile: Profile; instances: readonly ProfileInstance[] };

/** The account's food-write surface for this run of onboarding. Omit (or pass `null`) for an
 *  account whose food step never writes a starter selection (no pilot/legacy access). */
export type OnboardingStarterWrite = {
  /** `"legacy"` also gates the per-meal protein-availability floor; `"pilot"` does not. */
  status: "legacy" | "pilot";
  marks: Readonly<Record<string, StarterMark>>;
  plannedCount: number;
};

export type SaveOnboardingPlanInput = {
  settings: Settings;
  onboardingState: OnboardingState;
  starter?: OnboardingStarterWrite | null;
  /** The safety round's taps (onboarding v2 G7): their condition entries are written before the
   *  target revision, so the server derives the target under the hold. */
  safety?: SafetyAnswers;
};

export type SaveOnboardingPlanResult =
  | { ok: true }
  | { ok: false; error: string };

export type SaveOnboardingPlanDeps = {
  persistPlan: typeof persistCompletedOnboarding;
  retryConstraints: typeof retryOnboardingConstraints;
  readRules: (h: AccountHandle) => Promise<FreshStarterRules | null>;
  writeStarter: (
    marks: Readonly<Record<string, StarterMark>>,
    allowed: readonly Starter[],
    deps: StarterWriter,
  ) => Promise<number>;
  flushOutbox: typeof flushOutboxNow;
  mirrorOnboardedAt: typeof mirroredOnboardedAt;
};

async function readFreshStarterRules(h: AccountHandle): Promise<FreshStarterRules | null> {
  try {
    const [constraints, instances] = await Promise.all([
      loadConstraints({ account: h }), fetchProfileInstances(h),
    ]);
    if (!constraints) return null;
    return { profile: constraints.profile, instances: instances.instances };
  } catch {
    return null;
  }
}

const defaultDeps: SaveOnboardingPlanDeps = {
  persistPlan: persistCompletedOnboarding,
  retryConstraints: retryOnboardingConstraints,
  readRules: readFreshStarterRules,
  writeStarter: persistStarterSelection,
  flushOutbox: flushOutboxNow,
  mirrorOnboardedAt: mirroredOnboardedAt,
};

/**
 * Save a completed (never a skipped — see `persistSkippedOnboarding` for that path) onboarding
 * plan in one call. Safe to call again after a failure: every step it runs is already idempotent
 * on its own (`persistCompletedOnboarding`'s settings/constraints writes, `persistStarterSelection`'s
 * per-food "already matches" skip), so a retry need not track which earlier step already landed.
 */
export async function saveOnboardingPlan(
  input: SaveOnboardingPlanInput,
  deps: Partial<SaveOnboardingPlanDeps> = {},
): Promise<SaveOnboardingPlanResult> {
  const { persistPlan, retryConstraints, readRules, writeStarter, flushOutbox, mirrorOnboardedAt } =
    { ...defaultDeps, ...deps };
  const h = accountHandle();
  try {
    const safety = input.safety ?? {};
    const completed = await persistPlan(input.settings, input.onboardingState, undefined, undefined, safety);
    if (!completed.constraintsSaved && safetyConditionEntries(safety).length > 0) {
      // G7: the condition patch failed before the target was written, so nothing was saved. A
      // flags-only retry would drop the conditions and leave the plan unsaved; offer the step again.
      return { ok: false, error: completed.error ?? CONSTRAINT_SAVE_WARNING };
    }
    if (!completed.constraintsSaved) {
      const retried = await retryConstraints(input.onboardingState.flags);
      if (!retried) return { ok: false, error: CONSTRAINT_SAVE_WARNING };
    }
    assertCurrent(h);

    if (input.starter) {
      const { status, marks, plannedCount } = input.starter;
      let fresh: FreshStarterRules | null;
      try {
        fresh = await readRules(h);
      } catch {
        fresh = null;
      }
      if (!fresh) return { ok: false, error: STARTER_RULES_UNAVAILABLE_ERROR };
      assertCurrent(h);
      const freshChoices = starterChoices(input.onboardingState.flags, fresh.profile, fresh.instances);
      const freshSelectedIds = Object.entries(marks)
        .filter(([, mark]) => mark === "eats").map(([id]) => id);
      if (!starterSelectionValid(freshSelectedIds, freshChoices)) {
        return { ok: false, error: STARTER_RULE_CHANGED_ERROR };
      }
      if (status === "legacy"
        && !starterProteinAvailability(marks, freshChoices, plannedCount).ready) {
        return { ok: false, error: STARTER_RULE_CHANGED_ERROR };
      }
      // Hand this exact read to `persistStarterSelection`'s own pre-write recheck (ONB2-RULE-REREAD-
      // WRITE) instead of letting it fetch a second time — the read above already covers the same
      // window that recheck exists to close.
      await writeStarter(marks, freshChoices, { ...defaultStarterWriter, freshRules: async () => fresh });
    }

    const drained = await flushOutbox(h);
    const mirrored = drained ? await mirrorOnboardedAt() : null;
    if (mirrored === null) return { ok: false, error: ONBOARDING_SYNC_WARNING };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : ONBOARDING_SYNC_WARNING };
  }
}
