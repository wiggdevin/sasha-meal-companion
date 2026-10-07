"use client";
import { accountHandle, assertCurrent } from "@/lib/device/account";

/** Water and weight actions reuse the two Today clients introduced by T8. */

import type { CoachAction } from "@/lib/coach/actions";
import { syncProfileSettings, targetPredecessorFor } from "@/lib/coach/apply-profile";
import { dateInZone, type ApplyContext, type ApplyResult, type UndoToken }
  from "@/lib/coach/apply-shared";
import { drainWeighIns, saveWeighIn } from "@/lib/health/weigh-in-client";
import { LB_PER_KG } from "@/lib/health/units";
import { isProfileComplete } from "@/lib/profile/energy";
import { targetDayFor } from "@/lib/targets/revision";
import { getDay, loadStore, saveStore, updateDay } from "@/lib/store";
import { deleteMorningWeight, saveMorningWeight } from "@/lib/today/water-and-weight";
import {
  cancelPendingTargetRevision, restoreTargetRevisionOnline, settingsWithTargetRevision,
} from "@/lib/targets/client";
import { wholeCups } from "@/lib/water";
import { addCupsWithRev, undoAddedCups } from "@/lib/water-client";

type WaterAction = Extract<CoachAction, { kind: "log_water" }>;
type WeightAction = Extract<CoachAction, { kind: "log_weight" }>;
type WaterToken = Extract<UndoToken, { kind: "log_water" }>;
type WeightToken = Extract<UndoToken, { kind: "log_weight" }> & {
  fetchImpl?: typeof fetch;
  previousTargetRevisionId?: string | null;
  targetRequestId?: string;
};
type PartialTargetApplyResult = {
  status: "applied";
  ok: true;
  partial: "targets";
  message: string;
  token: WeightToken;
};
const WEIGHT_UNDO_FAILED = "Weight kept — edit it in Settings";

function actionDate(date: string | undefined, ctx?: Pick<ApplyContext, "tz" | "now">): string | null {
  if (date) return date;
  const tz = ctx?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return dateInZone(ctx?.now ?? new Date(), tz);
}

export async function applyLogWater(
  action: WaterAction,
  ctx?: Pick<ApplyContext, "tz" | "now">,
): Promise<ApplyResult> {
  const date = actionDate(action.date, ctx);
  if (!date) return { status: "failed", reason: "Could not read that water date." };
  // water_log.cups is an integer column: a fractional cup (500 ml = 2.083) was rejected by sync and
  // never saved. Round to whole cups, half up; a sip under half a cup is not promoted to a full cup.
  const cups = wholeCups(action.ml);
  if (cups === 0) return { status: "failed", reason: "That is under half a cup, so nothing was logged." };
  const { cups: after, rev } = await addCupsWithRev(date, cups);
  return { status: "applied", token: { kind: "log_water", date, cups,
    ...(Number.isSafeInteger(after) ? { after } : {}),
    ...(typeof rev === "number" && Number.isSafeInteger(rev) ? { afterRev: rev } : {}) } };
}

/**
 * Water is additive, so Undo applies the exact inverse cup delta — only while the day still holds
 * the count the add left (`after`). A token from before that knows no such count cannot tell a
 * later add or correction apart, so it does not run at all (review t4r8 #1).
 */
export async function undoLogWater(token: WaterToken): Promise<void> {
  if (typeof token.after !== "number") {
    throw new Error("This water entry can no longer be undone here. Edit the count on Today.");
  }
  if (!await undoAddedCups(token.date, token.cups, token.after, token.afterRev)) {
    throw new Error("Water has changed since, so Undo left it alone.");
  }
}

export async function applyLogWeight(
  action: WeightAction,
  ctx: Pick<ApplyContext, "tz" | "now" | "fetchImpl">,
): Promise<ApplyResult | PartialTargetApplyResult> {
  const date = actionDate(action.date, ctx);
  if (!date) return { status: "failed", reason: "Could not read that weight date." };
  // The target dates by the device's local day, the day the phone resolves it on (`targetDayFor`),
  // and the predecessor is dated by this same captured day, so the new revision wins today.
  const targetDate = targetDayFor(ctx.now ?? new Date());
  const previousLb = getDay(date)?.weightLb ?? null;
  const store = loadStore();
  const predecessor = isProfileComplete(store.settings)
    ? targetPredecessorFor(store.settings, ctx, targetDate)
    : undefined;
  const lb = action.kg * LB_PER_KG;
  const saved = await saveMorningWeight(date, lb, () => {}, {
    tz: ctx.tz, fetchImpl: ctx.fetchImpl, targetDate, detailed: true, predecessor,
  });
  if (!saved.ok) return { status: "failed", reason: saved.reason };
  const token: WeightToken = {
    kind: "log_weight", date, previousLb, tz: ctx.tz, fetchImpl: ctx.fetchImpl,
    previousTargetRevisionId: saved.previousTargetRevisionId,
    ...("partial" in saved && saved.targetRequestId
      ? { targetRequestId: saved.targetRequestId } : {}),
  };
  if ("partial" in saved) {
    return { status: "applied", ok: true, partial: "targets", message: saved.message, token };
  }
  return { status: "applied", token };
}

export async function undoLogWeight(token: WeightToken, ctx: { now?: Date } = {}): Promise<void> {
  const h = accountHandle();
  if (token.targetRequestId) await cancelPendingTargetRevision(token.targetRequestId, h);
  if (token.previousLb !== null) {
    try {
      const refused = await saveWeighIn(token.date, token.previousLb, {
        tz: token.tz, fetchImpl: token.fetchImpl, account: h,
      });
      if (refused) throw new Error(WEIGHT_UNDO_FAILED);
      const drained = await drainWeighIns(h, { tz: token.tz, fetchImpl: token.fetchImpl });
      if (drained.pending > 0) throw new Error(WEIGHT_UNDO_FAILED);
    } catch {
      throw new Error(WEIGHT_UNDO_FAILED);
    }
    assertCurrent(h);
    updateDay(token.date, { weightLb: token.previousLb });
  } else {
    // Pending weigh-ins use T8's separate IDB list rather than the sync outbox, so there is no op to
    // cancel. Let its existing drain settle the upsert first; the delete must be the final server write.
    try {
      const drained = await drainWeighIns(h, { tz: token.tz, fetchImpl: token.fetchImpl });
      if (drained.pending > 0) throw new Error(WEIGHT_UNDO_FAILED);
    } catch {
      throw new Error(WEIGHT_UNDO_FAILED);
    }
    // PR #248 review r4 #1: the delete goes out only as the account that started the Undo.
    assertCurrent(h);
    const deleted = await deleteMorningWeight(token.date, { fetchImpl: token.fetchImpl, account: h });
    if (!deleted.ok) throw new Error(deleted.reason);
    assertCurrent(h);
    updateDay(token.date, { weightLb: undefined });
  }

  if (token.previousTargetRevisionId) {
    const restoreDate = targetDayFor(ctx.now ?? new Date());
    const restored = await restoreTargetRevisionOnline(
      token.previousTargetRevisionId,
      restoreDate,
      token.fetchImpl,
      h,
    );
    assertCurrent(h);
    const store = loadStore();
    const settings = settingsWithTargetRevision(store.settings, restored);
    await syncProfileSettings(settings, h, ["trainingKcal", "restKcal", "proteinG"]);
    assertCurrent(h);
    saveStore({
      ...store,
      settings,
    });
  }
}
