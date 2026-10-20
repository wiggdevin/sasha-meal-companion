"use client";

/**
 * The data hook behind "Your week" (UI makeover §4.1): the last 28 dates ending today, from the
 * store Today already holds, the account's water rows and one health window read. The health read
 * starts the first time the Overview face is on show and is made once per account and day; the
 * water rows are re-read when the day's cup count changes or a sync lands.
 */
import { useEffect, useMemo, useState } from "react";
import { currentAccountOrNull } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { readHealthWindow, readWaterGoal, readWaterWindow, type HealthWindow } from "@/lib/trends/sources";
import { buildTrendDays, windowDates, type TrendDay } from "@/lib/trends/series";
import type { DayType, Store } from "@/lib/types";

export const TREND_WINDOW_DAYS = 28;

export type TrendsState = {
  days: TrendDay[] | null;
  /** loading until the first read answers. */
  health: HealthWindow | { status: "loading" };
};

type WaterRead = { key: string; cups: Map<string, number> | null; goal: ((date: string, dayType: DayType) => number) | null };

export function useTrends({ store, today, active, cupsNow }: {
  store: Store | undefined;
  today: string;
  active: boolean;
  /** The viewed day's cup count, so a new cup re-reads the water rows. */
  cupsNow?: number;
}): TrendsState {
  const dates = useMemo(() => windowDates(today, TREND_WINDOW_DAYS), [today]);
  const [shown, setShown] = useState(active);
  const [health, setHealth] = useState<{ key: string; window: HealthWindow } | null>(null);
  const [water, setWater] = useState<WaterRead | null>(null);
  const [synced, setSynced] = useState(0);

  // Mark the face as seen once (an effect-free derivation, so a later hide keeps the data).
  if (active && !shown) setShown(true);

  useEffect(() => {
    const bump = () => setSynced((n) => n + 1);
    window.addEventListener(SYNCED_EVENT, bump);
    return () => window.removeEventListener(SYNCED_EVENT, bump);
  }, []);

  const h = currentAccountOrNull();
  const account = h?.userId ?? null;
  const healthKey = `${account}|${today}`;

  useEffect(() => {
    if (!shown || !h) return;
    let live = true;
    readHealthWindow(h, dates[0], dates[dates.length - 1])
      .then((read) => { if (live) setHealth({ key: healthKey, window: read }); })
      .catch(() => { if (live) setHealth({ key: healthKey, window: { status: "unavailable" } }); });
    return () => { live = false; };
    // One read per account and day; the handle object itself is not a reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, healthKey]);

  const waterKey = `${account}|${today}|${cupsNow ?? ""}|${synced}`;
  useEffect(() => {
    if (!shown || !h) return;
    let live = true;
    Promise.all([readWaterWindow(h, dates), readWaterGoal(h)])
      .then(([cups, goal]) => { if (live) setWater({ key: waterKey, cups, goal }); })
      .catch(() => { if (live) setWater({ key: waterKey, cups: null, goal: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, waterKey]);

  const healthWindow = health?.key === healthKey ? health.window : null;
  const rows = healthWindow?.status === "ok" ? healthWindow.rows : null;
  // A read made for another account or day is never shown (the key starts with both).
  const waterNow = water?.key.startsWith(`${healthKey}|`) ? water : null;
  const days = useMemo(() => store ? buildTrendDays({ store, today, dates,
    cups: waterNow?.cups ?? null, waterGoal: waterNow?.goal ?? null, health: rows }) : null,
  [store, today, dates, waterNow, rows]);

  return { days, health: healthWindow ?? { status: "loading" } };
}
