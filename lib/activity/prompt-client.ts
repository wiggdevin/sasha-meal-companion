"use client";
import { accountHandle, assertCurrent } from "@/lib/device/account";

import { activityPromptEligibility, type ActivitySuggestion } from "@/lib/activity/prompt";
import { fetchDaily } from "@/lib/health-client";
import { isProfileComplete } from "@/lib/profile/energy";
import { targetSourceFor } from "@/lib/profile/derive";
import { isoDaysBefore } from "@/lib/settings/date";
import { loadStore, saveStore } from "@/lib/store";
import { getRow } from "@/lib/sync/idb";
import { mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import {
  settingsProfileFromRow, settingsProfileToRow, type UserSettingsProfileRow,
} from "@/lib/sync/user-settings";
import {
  persistDerivedTargetRevision, settingsWithTargetRevision,
} from "@/lib/targets/client";
import { targetDayFor } from "@/lib/targets/revision";
import { latestWeighInKg } from "@/lib/today/water-and-weight";
import type { ActivityLevel, Store } from "@/lib/types";

export const DISMISSAL_DAYS = 30;

export async function readActivityPromptDismissal(): Promise<string | null> {
  const h = accountHandle();
  const row = await getRow(h, "user_settings", USER_SETTINGS_KEY) as UserSettingsProfileRow | undefined;
  return settingsProfileFromRow(row ?? {}).activityPromptDismissedUntil ?? null;
}

export async function writeActivityPromptDismissal(until: string): Promise<void> {
  const h = accountHandle();
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    const { rev: _rev, user_id: _userId, ...stored } = row;
    void _rev; void _userId;
    const activityPromptDismissedUntil = settingsProfileToRow({
      activityPromptDismissedUntil: until,
    }).activity_prompt_dismissed_until;
    const payload = { ...stored,
      activity_prompt_dismissed_until: activityPromptDismissedUntil };
    return {
      row: { ...row, ...payload },
      op: { op_id: crypto.randomUUID(), entity: "user_settings" as const,
        entity_id: USER_SETTINGS_KEY, kind: rev === null ? "create" as const : "update" as const,
        base_rev: rev, payload, client_ts: new Date().toISOString() },
      result: undefined,
    };
  });
}

async function writeActivityLevel(activityLevel: ActivityLevel): Promise<void> {
  const h = accountHandle();
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    const { rev: _rev, user_id: _userId, ...stored } = row;
    void _rev; void _userId;
    const payload = { ...stored, activity_level: activityLevel };
    return {
      row: { ...row, ...payload },
      op: { op_id: crypto.randomUUID(), entity: "user_settings" as const,
        entity_id: USER_SETTINGS_KEY, kind: rev === null ? "create" as const : "update" as const,
        base_rev: rev, payload, client_ts: new Date().toISOString() },
      result: undefined,
    };
  });
}

export type ActivityPromptClientDeps = {
  loadStore: () => Store;
  saveStore: (store: Store) => void;
  now: () => Date;
  latestWeighInKg: typeof latestWeighInKg;
  writeActivityLevel: (level: ActivityLevel) => Promise<void>;
  writeDismissal: (until: string) => Promise<void>;
  persistTargets: typeof persistDerivedTargetRevision;
};

const CLIENT_DEPS: ActivityPromptClientDeps = {
  loadStore, saveStore, now: () => new Date(), latestWeighInKg,
  writeActivityLevel, writeDismissal: writeActivityPromptDismissal,
  persistTargets: persistDerivedTargetRevision,
};

function localDateIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function dismissActivityPrompt(
  deps: ActivityPromptClientDeps = CLIENT_DEPS,
): Promise<void> {
  const until = new Date(deps.now().getTime() + DISMISSAL_DAYS * 86_400_000).toISOString();
  await deps.writeDismissal(until);
}

export async function applyActivitySuggestion(
  activityLevel: ActivityLevel,
  deps: ActivityPromptClientDeps = CLIENT_DEPS,
): Promise<void> {
  const h = accountHandle();
  const store = deps.loadStore();
  const settings = { ...store.settings, activityLevel };
  if (!isProfileComplete(settings)) throw new Error("Profile is incomplete");
  await deps.writeActivityLevel(activityLevel);
  const today = targetDayFor(deps.now());
  const revision = await deps.persistTargets({
    settings,
    latestWeighInKg: deps.latestWeighInKg(today, settings),
    today,
    trainingWeekdays: settings.trainingWeekdays ?? [],
    source: targetSourceFor(settings),
  });
  // Two awaits back: only while the account that tapped is still the one bound (Phase 9 §0.2).
  assertCurrent(h);
  deps.saveStore({ ...store, settings: settingsWithTargetRevision(settings, revision) });
}

export async function loadActivityPromptSuggestion(now = new Date()):
    Promise<ActivitySuggestion | null> {
  const asOf = localDateIso(now);
  const from = isoDaysBefore(asOf, 28);
  const to = isoDaysBefore(asOf, 1);
  const [daily, dismissedUntil] = await Promise.all([
    fetchDaily(accountHandle(), from, to), readActivityPromptDismissal(),
  ]);
  if (daily.disabled || daily.response === null) return null;
  const settings = loadStore().settings;
  return activityPromptEligibility({
    days: daily.response.days,
    asOf,
    savedActivityLevel: settings.activityLevel ?? null,
    profileComplete: isProfileComplete(settings),
    isSaving: false,
    dismissedUntil,
    now,
  });
}

export function activityPromptUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ACTIVITY_PROMPT_UI === "true";
}
