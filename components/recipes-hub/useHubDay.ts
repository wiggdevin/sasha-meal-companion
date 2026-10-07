"use client";
/**
 * Today, as the recipe widget needs it: what is left to eat, and the meal a log from here files
 * under — the current slot, by the same rule capture uses (lib/capture/presentation.ts
 * slotForNow). Re-read whenever a sync, a queued log or a planned recipe changes the day, when the
 * window comes back, and at the next slot boundary (or midnight), so a widget left open files a
 * log under the meal on screen now. A write re-reads it once more at the tap (`readHubDay`).
 */
import { useEffect, useState } from "react";
import { slotForNow } from "@/lib/capture/presentation";
import { LOG_QUEUED_EVENT } from "@/lib/log-commit-client";
import { remainingMacros } from "@/lib/recipes-hub/hub";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import type { Macros, SlotId } from "@/lib/types";

export type HubDay = { date: string; remaining: Macros | null; slot: SlotId; time: string; label: string };

/** Events after which the day is read again. */
export const HUB_DAY_EVENTS = [SYNCED_EVENT, LOG_QUEUED_EVENT, "recipe-plan-accepted", "focus"] as const;

function localToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function minutesOf(time: string): number | null {
  const [h, m] = time.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

export function readHubDay(now = new Date()): HubDay {
  const date = localToday(now);
  const day = resolveDay(loadStore(), date);
  const slot = slotForNow(day.slots, now.getHours() * 60 + now.getMinutes());
  const row = day.slots.find((entry) => entry.slot === slot);
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return { date, remaining: remainingMacros(day), slot, time: row?.time ?? time, label: row?.label ?? "this meal" };
}

/**
 * Milliseconds from `now` to the next minute a slot starts today, or to midnight when none is
 * left. Slots start at their own clock time (`slotForNow` switches on `time <= now`).
 */
export function msToNextSlot(slots: readonly { time: string }[], now = new Date()): number {
  const minute = now.getHours() * 60 + now.getMinutes();
  const starts = slots.map((entry) => minutesOf(entry.time)).filter((m): m is number => m !== null && m > minute);
  const next = starts.length > 0 ? Math.min(...starts) : 24 * 60;
  const at = new Date(now);
  at.setHours(0, next, 0, 0);
  return Math.max(1000, at.getTime() - now.getTime());
}

function slotsToday(now = new Date()): readonly { time: string }[] {
  try { return resolveDay(loadStore(), localToday(now)).slots; } catch { return []; }
}

export function useHubDay(): HubDay {
  const [day, setDay] = useState<HubDay>(() => readHubDay());
  useEffect(() => {
    const read = () => setDay(readHubDay());
    for (const name of HUB_DAY_EVENTS) window.addEventListener(name, read);
    return () => { for (const name of HUB_DAY_EVENTS) window.removeEventListener(name, read); };
  }, []);
  // Each read schedules the next boundary; a read for any other reason re-arms it.
  useEffect(() => {
    const timer = window.setTimeout(() => setDay(readHubDay()), msToNextSlot(slotsToday()));
    return () => window.clearTimeout(timer);
  }, [day]);
  return day;
}
