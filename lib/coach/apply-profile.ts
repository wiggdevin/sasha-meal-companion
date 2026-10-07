"use client";
import { accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";

/** Profile fields and target pins use the same local Settings write path as /settings. */

import type { CoachAction } from "@/lib/coach/actions";
import type { ApplyResult, UndoToken } from "@/lib/coach/apply-shared";
import { loadStore, saveStore } from "@/lib/store";
import { isProfileComplete, settingsWithBodyFatProvenance } from "@/lib/profile/energy";
import { targetSourceFor } from "@/lib/profile/derive";
import { settingsWithGoalRate } from "@/lib/profile/rate-goal";
import { mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { settingsProfileToRow } from "@/lib/sync/user-settings";
import {
  persistDerivedTargetRevisionSet, restoreTargetRevisionOnline, settingsWithTargetRevision,
  type TargetPredecessor,
} from "@/lib/targets/client";
import { targetDayFor } from "@/lib/targets/revision";
import { latestWeighInKg } from "@/lib/today/water-and-weight";
import type { Settings } from "@/lib/types";

type ProfileAction = Extract<CoachAction, { kind: "update_profile" }>;
type TargetsAction = Extract<CoachAction, { kind: "set_targets" }>;
type SettingsToken = Extract<UndoToken, { kind: "update_profile" | "set_targets" }>;

function snapshot(settings: Settings): Settings {
  return structuredClone(settings);
}

function writeSettings(h: AccountHandle, next: Settings): void {
  assertCurrent(h);
  const store = loadStore();
  saveStore({ ...store, settings: next });
}

export async function syncProfileSettings(
  settings: Settings, h: AccountHandle = accountHandle(), fields: readonly (keyof Settings)[],
): Promise<void> {
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    const { rev: _rev, user_id: _userId, ...stored } = row;
    void _rev; void _userId;
    const mapped: Record<string, unknown> = {
      ...settingsProfileToRow(settings),
      training_kcal: settings.trainingKcal,
      rest_kcal: settings.restKcal,
      protein_g: settings.proteinG,
    };
    // The phone projection may still contain defaults. Only explicit edit fields own a write.
    const patch = Object.fromEntries(fields.flatMap((field) => {
      const column = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      return Object.prototype.hasOwnProperty.call(mapped, column) ? [[column, mapped[column]]] : [];
    }));
    const payload = { ...stored, ...patch };
    return {
      row: { ...row, ...payload },
      op: { op_id: crypto.randomUUID(), entity: "user_settings" as const,
        entity_id: USER_SETTINGS_KEY, kind: rev === null ? "create" as const : "update" as const,
        base_rev: rev, payload, client_ts: new Date().toISOString() },
      result: undefined,
    };
  });
}

/** `tz` is accepted from coach callers but never dates a target: see `targetDayFor`. */
type TargetWriteContext = { now?: Date; tz?: string; fetchImpl?: typeof fetch };

/** The day a phone target write takes effect, and the day its projection resolves on. */
function effectiveDate(ctx: TargetWriteContext): string {
  return targetDayFor(ctx.now ?? new Date());
}

function cachedWeighIn(settings: Settings): number | null {
  const inputs = settings.activeTargetProfile?.inputs;
  return inputs?.weightSource === "weigh-in" ? inputs.weightKg : null;
}

async function persistTargets(
  h: AccountHandle,
  settings: Settings,
  ctx: TargetWriteContext,
  previous: Settings,
): Promise<{ settings: Settings; undoPrevious: Settings }> {
  const today = effectiveDate(ctx);
  const result = await persistDerivedTargetRevisionSet({
    settings,
    latestWeighInKg: latestWeighInKg(today, settings) ?? cachedWeighIn(settings),
    today,
    trainingWeekdays: settings.trainingWeekdays ?? [],
    source: targetSourceFor(settings),
  }, {
    fetchImpl: ctx.fetchImpl,
    predecessor: targetPredecessorFor(previous, ctx, today),
    account: h,
  });
  return {
    settings: settingsWithTargetRevision(settings, result.revision),
    undoPrevious: result.predecessor
      ? settingsWithTargetRevision(previous, result.predecessor)
      : previous,
  };
}

/**
 * Give a re-derived target write a real predecessor so Undo can re-assert it as a new revision.
 * Only a complete prior profile can be recomputed; an incomplete one has no numbers to restore,
 * so the very first revision of an account has no predecessor. A paired write passes the one `today`
 * it dated its new revision by, so both rows carry the same day even across local midnight.
 */
export function targetPredecessorFor(
  previous: Settings,
  ctx: TargetWriteContext,
  today: string = effectiveDate(ctx),
): TargetPredecessor | undefined {
  if (previous.activeTargetProfile?.id) return undefined;
  if (!isProfileComplete(previous)) return undefined;
  return {
    operation: "derive",
    input: {
      settings: previous,
      latestWeighInKg: latestWeighInKg(today, previous) ?? cachedWeighIn(previous),
      today,
      trainingWeekdays: previous.trainingWeekdays ?? [],
      source: targetSourceFor(previous),
    },
  };
}

function restoreFields(current: Settings, previous: Settings, fields: (keyof Settings)[]): Settings {
  const next = snapshot(current);
  const mutable = next as unknown as Record<keyof Settings, unknown>;
  const prior = previous as unknown as Record<keyof Settings, unknown>;
  for (const field of fields) {
    if (prior[field] === undefined) delete mutable[field];
    else mutable[field] = structuredClone(prior[field]);
  }
  return next;
}

export async function applyUpdateProfile(
  action: ProfileAction,
  ctx: TargetWriteContext = {},
): Promise<ApplyResult> {
  const h = accountHandle();
  const store = loadStore();
  const previous = snapshot(store.settings);
  const { kind: _kind, actionId: _actionId, flagged: _flagged, ...fields } = action;
  void _kind; void _actionId; void _flagged;
  let next: Settings = settingsWithGoalRate(store.settings,
    settingsWithBodyFatProvenance(store.settings, { ...store.settings, ...fields }));
  let undoPrevious = previous;
  if (isProfileComplete(next)) {
    const persisted = await persistTargets(h, next, ctx, previous);
    next = persisted.settings;
    undoPrevious = persisted.undoPrevious;
  }
  // A body-fat change can clear the scan label, so Undo must put the label back with the value.
  const touched = Object.keys(fields) as (keyof Settings)[];
  const provenance: (keyof Settings)[] = touched.includes("bodyFatPct")
    ? ["bodyFatSource", "bodyFatMeasuredOn"] : [];
  // A goal change resets the rate, so Undo must put the old rate back with the old goal.
  const rate: (keyof Settings)[] = touched.includes("goal") ? ["goalRateBpWeek"] : [];
  await syncProfileSettings(next, h, [...touched, ...provenance, ...rate,
    ...(isProfileComplete(next) ? ["trainingKcal", "restKcal", "proteinG"] as const : [])]);
  writeSettings(h, next);
  return { status: "applied", token: { kind: "update_profile", previous: undoPrevious,
    fields: [...new Set([...touched, ...provenance, ...rate, "activeTargetProfile" as const])] } };
}

export async function applySetTargets(
  action: TargetsAction,
  ctx: TargetWriteContext = {},
): Promise<ApplyResult> {
  const h = accountHandle();
  const store = loadStore();
  const previous = snapshot(store.settings);
  const next: Settings = {
    ...store.settings,
    ...(action.kcal !== undefined && (action.dayType === "training" || action.dayType === "both")
      ? { trainingKcal: action.kcal } : {}),
    ...(action.kcal !== undefined && (action.dayType === "rest" || action.dayType === "both")
      ? { restKcal: action.kcal } : {}),
    ...(action.proteinG !== undefined ? { proteinG: action.proteinG } : {}),
    changedAt: (ctx.now ?? new Date()).toISOString(),
  };
  if (!isProfileComplete(next)) {
    return { status: "failed", reason: "Finish profile setup before changing targets." };
  }
  const persisted = await persistTargets(h, next, ctx, previous);
  await syncProfileSettings(persisted.settings, h, ["trainingKcal", "restKcal", "proteinG"]);
  writeSettings(h, persisted.settings);
  const fields: (keyof Settings)[] = ["changedAt", "activeTargetProfile"];
  if (action.kcal !== undefined && (action.dayType === "training" || action.dayType === "both")) {
    fields.push("trainingKcal");
  }
  if (action.kcal !== undefined && (action.dayType === "rest" || action.dayType === "both")) {
    fields.push("restKcal");
  }
  if (action.proteinG !== undefined) fields.push("proteinG");
  return { status: "applied", token: {
    kind: "set_targets", previous: persisted.undoPrevious, fields,
  } };
}

export async function undoSettingsAction(
  token: SettingsToken,
  ctx: TargetWriteContext = {},
): Promise<void> {
  const h = accountHandle();
  let next = restoreFields(loadStore().settings, token.previous, token.fields);
  const revisionId = token.previous.activeTargetProfile?.id;
  if (revisionId) {
    const restored = await restoreTargetRevisionOnline(
      revisionId, effectiveDate(ctx), ctx.fetchImpl, h);
    next = settingsWithTargetRevision(next, restored);
  }
  await syncProfileSettings(next, h, [...token.fields,
    ...(revisionId ? ["trainingKcal", "restKcal", "proteinG"] as const : [])]);
  writeSettings(h, next);
}
