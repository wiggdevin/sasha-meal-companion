"use client";

/**
 * Two daily actions that previously had no visible result — T8.
 *
 * Kept out of `app/page.tsx` for the reason `lib/health/body-page.ts` is kept out of
 * `app/body/page.tsx`: the page component is a view, and neither the water read nor the weigh-in
 * write is view work. Both reach storage the page itself never touches — IndexedDB for the cups,
 * the health route for the weight — and both have a rule worth stating once, here, rather than in
 * the middle of a 600-line render.
 *
 * The hook is assembled from two exported pieces, `readWater` and `waterLineFor`, so the rule that
 * a late read must not paint the wrong day can be driven directly: this repo has no DOM test
 * environment, and `renderToStaticMarkup` never runs an effect.
 */
import {
  AccountChanged, accountHandle, currentAccountOrNull, isCurrent, rethrowAccountChanged, accountFetch,
} from "@/lib/device/account";
import { useEffect, useRef, useState } from "react";
import { bodyMassSource, pillWeightLb } from "@/lib/health/daily";
import { readCachedDaily } from "@/lib/health-client";
import { lbToKg } from "@/lib/health/units";
import { saveWeighIn, type WeighInOptions } from "@/lib/health/weigh-in-client";
import { isProfileComplete } from "@/lib/profile/energy";
import { targetSourceFor } from "@/lib/profile/derive";
import { targetDayType } from "@/lib/targets";
import { targetDayFor, targetRevisionOn } from "@/lib/targets/revision";
import { getDay, loadStore, saveStoreFor, updateDay } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import {
  persistDerivedTargetRevisionSet, settingsWithTargetRevision, TargetRevisionQueuedError,
  type TargetPredecessor, type TargetRevisionSet,
} from "@/lib/targets/client";
import type { DayType, Settings } from "@/lib/types";
import { waterWeightKg } from "@/lib/water-goal";
import { getWater, type WaterRead } from "@/lib/water-client";

/** The viewed day's cups, the goal they count against (cups), the unit to show them in and
 *  whether that goal is the weight-based auto goal or the account's own. */
export type WaterLine = WaterRead;

/** One read, tagged with the date it was made for. */
export type DatedWater = WaterLine & { date: string };

/** The cups for one day. The date rides along so a late answer can be recognised as late. */
export async function readWater(date: string, dayType: DayType, weightKg?: number | null): Promise<DatedWater> {
  const read = await getWater(date, dayType, weightKg);
  return { date, ...read };
}

/**
 * The weight the auto water goal is drawn from for a date: the latest weigh-in on or before it,
 * then the input weight of the target revision in force on that date, then the profile weight — the order the targets
 * themselves use (`weightForTargets`), so the water goal moves when the plan does.
 */
export function waterGoalWeightKg(date: string, settings: Settings = loadStore().settings): number | null {
  let weighIn: number | null = null;
  try { weighIn = latestWeighInKg(date, settings); } catch { /* an unreadable cache is no weight */ }
  // The revision in force on THIS date, as its day type is (audit 2026-10-05 #16).
  return waterWeightKg(weighIn, targetRevisionOn(settings, date)?.inputs?.weightKg, settings.weightKg);
}

/**
 * What the card shows for the day on screen: the read, but only while it still describes that day.
 *
 * The user can tap to another date while a read is in flight, and IndexedDB gives no ordering guarantee
 * between two reads — so the answer for the day the user LEFT can land last. Without this the card would
 * paint Wednesday's cups under Thursday's date. Showing nothing for the instant before the right
 * answer arrives is the honest state; showing another day's count is not.
 */
export function waterLineFor(read: DatedWater | undefined, viewedDate: string): WaterLine | undefined {
  if (!read || read.date !== viewedDate) return undefined;
  const { date: _date, ...line } = read;
  void _date;
  return line;
}

/**
 * The same rule on the way IN: a read is only worth holding while it still describes the day on
 * screen. The effect's own reads are covered by its `live` flag, but the re-read after a logged cup
 * had no guard at all — tap on Thursday, switch to Wednesday before IndexedDB answers, and the
 * held read was Thursday's, so Wednesday's line showed nothing until the next sync event.
 */
export function applyRead(
  next: DatedWater, liveDate: string, current: DatedWater | undefined,
): DatedWater | undefined {
  return next.date === liveDate ? next : current;
}

/**
 * The water line for the viewed day, and a re-read for right after the user logs a cup.
 *
 * `water` is `undefined` until a read for THIS day answers, so the progress card shows no line
 * rather than a wrong count. The goal is per day type, so the read has to know which one the viewed
 * day is — the same rule `lib/resolve.ts`'s `ratiosFor` applies. That day type is recomputed every
 * render, which is what makes changing it re-run the read; the store is only legible after mount,
 * which is what `mounted` gates.
 */
export function useWaterLine(viewedDate: string, mounted: boolean): {
  water: WaterLine | undefined;
  rereadWater: () => Promise<void>;
} {
  const [read, setRead] = useState<DatedWater | undefined>(undefined);
  const dayType = mounted && viewedDate
    ? targetDayType(viewedDate, getDay(viewedDate)?.dayTypeOverride, loadStore().settings)
    : null;
  // The auto goal follows the weight, so a new weigh-in re-reads the line like a new day type does.
  const weightKg = mounted && viewedDate ? waterGoalWeightKg(viewedDate) : null;
  // The day on screen right now, for answers that land after a render. The effect's `live` flag
  // covers its own reads; `rereadWater` outlives the render it was built in and needs this.
  const liveDate = useRef(viewedDate);

  useEffect(() => {
    liveDate.current = viewedDate;
    if (!viewedDate || !dayType) return;
    let live = true;
    const run = () => {
      void readWater(viewedDate, dayType, weightKg).then((next) => {
        if (live) setRead((current) => applyRead(next, liveDate.current, current));
      }).catch(() => {
        // A blocked IndexedDB is not a reason to fail the screen; the line simply stays away.
      });
    };
    run();
    window.addEventListener(SYNCED_EVENT, run);
    return () => {
      live = false;
      window.removeEventListener(SYNCED_EVENT, run);
    };
  }, [viewedDate, dayType, weightKg]);

  return {
    // The stored read is filtered on the way out, not on the way in: a result that arrives for a
    // day the user has already left is simply never the one the card renders.
    water: waterLineFor(read, viewedDate),
    // Re-read rather than increment: the IDB row is written before the outbox posts, so the count
    // is already local and the line moves in the same render pass as the tap.
    rereadWater: async () => {
      if (!dayType) return;
      const next = await readWater(viewedDate, dayType, weightKg);
      setRead((current) => applyRead(next, liveDate.current, current));
    },
  };
}

/**
 * The header pill's number for the VIEWED day, in pounds, or null for no pill.
 *
 * Precedence (the amended T8 §2 rule): an ingest sample for that day wins, then the value typed on
 * this device, then the synced copy of a manual sample, else no pill. `lib/health/daily.ts` holds
 * the rule and why the middle step sits where it does; this only supplies the viewed day's row.
 * The old reduce over every cached day took the last non-null one, which showed Tuesday's number
 * while the user was reading Friday.
 */
export function headerPillLb(viewedDate: string, localLb: number | undefined): number | null {
  const day = readCachedDaily(currentAccountOrNull())?.response.days
    .find((d) => d.local_date === viewedDate);
  return pillWeightLb(day?.body_mass_kg, bodyMassSource(day), localLb);
}

type WeightCandidate = { date: string; kg: number; priority: number };

/**
 * Latest effective weigh-in known to this phone on or before the target date. A same-day device
 * sample wins over the local typed value, which wins over its older synchronized manual copy.
 * The last authoritative revision is only a fallback when neither local store has the sample.
 */
export function latestWeighInKg(
  effectiveDate: string,
  settings: Settings = loadStore().settings,
): number | null {
  let latest: WeightCandidate | null = null;
  const choose = (
    current: WeightCandidate | null,
    candidate: WeightCandidate,
  ): WeightCandidate | null => {
    if (candidate.date > effectiveDate || !Number.isFinite(candidate.kg) || candidate.kg <= 0) {
      return current;
    }
    return !current || candidate.date > current.date
      || (candidate.date === current.date && candidate.priority > current.priority)
      ? candidate : current;
  };

  for (const day of readCachedDaily(currentAccountOrNull())?.response.days ?? []) {
    if (typeof day.body_mass_kg !== "number") continue;
    latest = choose(latest, { date: day.local_date, kg: day.body_mass_kg,
      priority: bodyMassSource(day) === "manual" ? 0 : 2 });
  }
  for (const day of Object.values(loadStore().days)) {
    if (typeof day.weightLb !== "number") continue;
    latest = choose(latest, { date: day.date, kg: lbToKg(day.weightLb), priority: 1 });
  }
  if (latest) return latest.kg;

  // The revision in force on THIS date, not today's current one (audit 2026-10-05 #16).
  const inputs = targetRevisionOn(settings, effectiveDate)?.inputs;
  return inputs?.weightSource === "weigh-in" && inputs.effectiveDate <= effectiveDate
    ? inputs.weightKg : null;
}

export const TARGETS_PARTIAL_MESSAGE = "Weight saved; targets will refresh on the next sync";
/** The save ran for an account that is no longer signed in on this phone. */
export const ACCOUNT_CHANGED_REASON = "Signed in as someone else; that weight stays with the other account.";

type MorningWeightOptions = WeighInOptions & {
  writeTargets?: typeof persistDerivedTargetRevisionSet;
  /** Target authority becomes effective today even when the weigh-in itself is backdated. */
  targetDate?: string;
  /** Onboarding owns the subsequent target write and only needs this function's local-first sample. */
  skipTargets?: boolean;
  /** The first real revision and this Undo predecessor must land in one server transaction. */
  predecessor?: TargetPredecessor;
};

export type MorningWeightResult =
  | { ok: false; reason: string }
  | { ok: true; previousTargetRevisionId: string | null }
  | { ok: true; partial: "targets"; message: typeof TARGETS_PARTIAL_MESSAGE;
      previousTargetRevisionId: string | null; targetRequestId?: string };

export function saveMorningWeight(
  viewedDate: string,
  lb: number,
  onStored: () => void,
  opts: MorningWeightOptions & { detailed: true },
): Promise<MorningWeightResult>;
export function saveMorningWeight(
  viewedDate: string,
  lb: number,
  onStored: () => void,
  opts?: MorningWeightOptions,
): Promise<string | null>;

/**
 * Local first, then the server (T8 §2). `updateDay` is instant and offline-safe — it is what the
 * weekly summary and the pill read straight away, which is why `onStored` fires before the network
 * is touched. `saveWeighIn` then turns the same number into a `health_samples` row the estimator
 * can see, or parks the day for the next sync.
 *
 * A REFUSAL is the one case the local write has to be taken back. The server will never hold that
 * number, so leaving it here would put Today and the server permanently at odds — the pill would go
 * on showing a weight that exists nowhere else. A transport failure is the opposite: the write
 * stands, and the drain carries it up later. If the weight lands but its target revision does not,
 * the detailed caller gets a partial success with an Undo token while the target request queues.
 *
 * The revert only fires while the day still holds the number THIS call wrote. Two Saves for the
 * same day can overlap, and each captures its own "previous": A(10) captures nothing there, B(171)
 * captures A's 10, and A's late refusal put nothing back over B's accepted 171. The FAB disables
 * Save while one is in flight (components/QuickActions.tsx), and this is the second line of that
 * defence — a revert that would overwrite someone else's number simply does not happen.
 */
export async function saveMorningWeight(
  viewedDate: string,
  lb: number,
  onStored: () => void,
  opts: MorningWeightOptions & { detailed?: boolean } = {},
): Promise<string | null | MorningWeightResult> {
  // Phase 9 §0.2 (PR #248 review r1 #4): one handle for the whole save. After every await, nothing
  // is read, written or called back unless that account is still the one bound.
  const h = opts.account ?? accountHandle();
  const gone = (): string | null | MorningWeightResult =>
    (opts.detailed ? { ok: false, reason: ACCOUNT_CHANGED_REASON } : null);
  const targetDate = opts.targetDate ?? targetDayFor();
  const beforeSettings = loadStore().settings;
  const beforeEffectiveKg = latestWeighInKg(targetDate, beforeSettings);
  const previous = getDay(viewedDate)?.weightLb;
  updateDay(viewedDate, { weightLb: lb });
  onStored();

  let refused: string | null;
  try {
    refused = await saveWeighIn(viewedDate, lb, { ...opts, account: h });
  } catch (e) {
    if (e instanceof AccountChanged) return gone();
    throw e;
  }
  if (!isCurrent(h)) return gone();
  if (refused && getDay(viewedDate)?.weightLb === lb) {
    updateDay(viewedDate, { weightLb: previous });
    onStored();
  }
  if (refused) return opts.detailed ? { ok: false, reason: refused } : refused;

  const store = loadStore();
  const previousTargetRevisionId = store.settings.activeTargetProfile?.id ?? null;
  if (opts.skipTargets || !isProfileComplete(store.settings)) {
    return opts.detailed ? { ok: true, previousTargetRevisionId } : null;
  }
  const effectiveKg = latestWeighInKg(targetDate, store.settings);
  if (beforeEffectiveKg !== null && effectiveKg === beforeEffectiveKg) {
    return opts.detailed ? { ok: true, previousTargetRevisionId } : null;
  }
  try {
    const result: TargetRevisionSet = await (opts.writeTargets ?? persistDerivedTargetRevisionSet)({
      settings: store.settings,
      latestWeighInKg: effectiveKg,
      today: targetDate,
      trainingWeekdays: store.settings.trainingWeekdays ?? [],
      source: targetSourceFor(store.settings),
    }, {
      fetchImpl: opts.fetchImpl ?? fetch,
      predecessor: opts.predecessor,
      queueOnFailure: true,
      account: h,
    });
    if (!isCurrent(h)) return gone();
    saveStoreFor(h, { ...store,
      settings: settingsWithTargetRevision(store.settings, result.revision) });
    onStored();
    const priorId = previousTargetRevisionId ?? result.predecessor?.id ?? null;
    return opts.detailed ? { ok: true, previousTargetRevisionId: priorId } : null;
  } catch (error) {
    if (error instanceof AccountChanged || !isCurrent(h)) return gone();
    const targetRequestId = error instanceof TargetRevisionQueuedError ? error.requestId : undefined;
    const partial = { ok: true as const, partial: "targets" as const,
      message: TARGETS_PARTIAL_MESSAGE, previousTargetRevisionId,
      ...(targetRequestId ? { targetRequestId } : {}) };
    return opts.detailed ? partial : TARGETS_PARTIAL_MESSAGE;
  }
}

export type DeleteMorningWeightResult = { ok: true } | { ok: false; reason: string };

/** Remove one manual weigh-in. A missing row already satisfies Undo; every other failure is honest. */
export async function deleteMorningWeight(
  viewedDate: string, opts: Pick<WeighInOptions, "fetchImpl" | "account"> = {},
): Promise<DeleteMorningWeightResult> {
  const reason = "Weight kept — edit it in Settings";
  const h = opts.account ?? accountHandle();
  try {
    const response = await accountFetch(h,
      `/api/health/weigh-in?date=${encodeURIComponent(viewedDate)}`,
      { method: "DELETE" }, { budget: "commit", fetchImpl: opts.fetchImpl });
    return response.ok || response.status === 404 ? { ok: true } : { ok: false, reason };
  } catch (e) {
    rethrowAccountChanged(e);
    return { ok: false, reason };
  }
}
