"use client";

/**
 * The data hook behind Today's Body card (Sol audit, T11a): the viewed date's rolled-up row, read
 * through `fetchDaily` so the card shows the same numbers as `/body` and the settings card. The
 * effect is `[]`-shaped and the setter sits behind the promise, matching the house pattern for a
 * one-shot client read.
 */
import { currentAccountOrNull } from "@/lib/device/account";
import { useEffect, useState } from "react";
import { fetchExpenditure } from "@/lib/estimator-client";
import { fetchDaily } from "@/lib/health-client";
import { TDEE_WINDOW_DAYS } from "@/lib/body-window";
import type { DailyHealthResponse, DailyHealthRow } from "@/lib/health/contract";
import type { ExpenditureResponse } from "@/lib/api-types";

/** The source-kind labels the card is allowed to print, mirroring `health_sources.kind`. */
const SOURCE_LABELS: Record<string, string> = {
  apple_health_shortcut: "Phone update",
  health_auto_export: "Apple Health",
  oura: "Oura",
  manual: "Typed in",
};

export function sourceLabel(kind: string): string {
  return SOURCE_LABELS[kind] ?? "Other";
}

/** One fetch spans the wider rule T11b's lines read, so the card needs no second request. */
export { TDEE_WINDOW_DAYS };

export type TodayBodyState = { localDate: string | null; row: DailyHealthRow | null;
  /** The fetched window ending at `localDate` — what `tdeeLines()` needs for the one TDEE line. */
  days: DailyHealthRow[]; estimate: ExpenditureResponse | null; loading: boolean;
  /** `fetchDaily`'s own flags for the row above: a cached copy served because the live request
   *  failed, and when it was written. Both ride with the row — a new date's fetch clears them. */
  offline: boolean; fetchedAt: string | null;
  /** `fetchExpenditure`'s flag for `estimate`: a cached copy served because `/api/expenditure`
   *  failed. Date-independent, like `estimate` itself — a date change does not clear it. */
  stale: boolean };

export const INITIAL_TODAY_BODY: TodayBodyState = { localDate: null, row: null, days: [],
  estimate: null, loading: true, offline: false, fetchedAt: null, stale: false };

/** The viewed date's row only — never `days[0]`, which can be an unrelated cached range. */
export function pickDay(days: DailyHealthResponse["days"] | null | undefined,
    localDate: string): DailyHealthRow | null {
  return days?.find((day) => day.local_date === localDate) ?? null;
}

/** A settled response fills the row for the date it was asked for, along with `fetchDaily`'s own
 *  `offline`/`fetchedAt` for that same row (gap-body-dashboard-11) — a cached copy served for a
 *  failed live request must carry its own staleness with it, not just its values. */
export function applyDays(state: TodayBodyState, localDate: string,
    days: DailyHealthResponse["days"] | null | undefined, offline = false,
    fetchedAt: string | null = null): TodayBodyState {
  return { ...state, localDate, row: pickDay(days, localDate), days: days ?? [],
    offline, fetchedAt, loading: false };
}

/**
 * What the card shows for `localDate`: the settled row only when it belongs to that date. A date
 * change therefore clears the previous row at once — no setState in an effect, and no stale numbers
 * while the new fetch is in flight. The window goes with the row (it ends at the row's date); the
 * nightly estimate is date-independent and always rides along.
 */
export function viewedDate(state: TodayBodyState, localDate: string): TodayBodyState {
  if (state.localDate === localDate) return state;
  return { localDate, row: null, days: [], estimate: state.estimate, stale: state.stale,
    offline: false, fetchedAt: null, loading: true };
}

/** `localDate` shifted by `days` (negative is earlier), in the phone's own zone — the viewed date
 *  can be any date on the Today screen, so the window is anchored to it and not to `new Date()`. */
export function shiftDate(localDate: string, days: number): string {
  const d = new Date(`${localDate}T00:00:00`);
  d.setDate(d.getDate() + days);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `enabled` false fetches nothing: Today reads once when body data is on and hands that read to
 *  the Health Overview Orbit (2026-09-30), so its activity and recovery branches stay current. */
export function useTodayBody(localDate: string, enabled = true): TodayBodyState {
  const [state, setState] = useState<TodayBodyState>(INITIAL_TODAY_BODY);

  useEffect(() => {
    if (!enabled) return;
    const h = currentAccountOrNull();
    if (h === null) return; // no account bound: nothing of anyone's to fetch
    let live = true;
    void fetchDaily(h, shiftDate(localDate, -(TDEE_WINDOW_DAYS - 1)), localDate).then((result) => {
      if (live) setState((prev) => applyDays(prev, localDate, result.response?.days,
        result.offline, result.fetchedAt));
    }).catch(() => {}); // an account that has since gone: nothing to show
    // The adaptive estimate is a nightly rollup, so it is fetched once, not per viewed date; the
    // card only prints a value the server has already explained (T11b owns the three-line version).
    void fetchExpenditure(h).then((result) => {
      if (live) setState((prev) => ({ ...prev, estimate: result?.value ?? null,
        stale: result?.stale ?? false }));
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [localDate, enabled]);

  return viewedDate(state, localDate);
}
