/**
 * .ics calendar generator for the app.
 *
 * A downloadable/shareable RFC 5545 calendar lets the person's device fire
 * reminders while the app is closed.
 *
 * One recurring VEVENT per account meal slot has a weekly RRULE with no
 * UNTIL or COUNT. The events contain no inherited single-client rituals.
 *
 * Times are written as "floating" local date-times (no TZID, no trailing Z)
 * so the reminder always fires at the stated wall-clock time on the user's device,
 * regardless of which timezone that device is in.
 */

import type { Settings, SlotId } from "./types";
import { resolveSlotTimes } from "./plan";
import { APP_CALENDAR_NAME, APP_NAME } from "@/lib/brand";

// ---------------------------------------------------------------- schedule

type SlotDefinition = {
  slot: SlotId;
  /** Final time-of-day, "HH:MM", 24h: the app's own clamped slot resolution. */
  time: string;
  summary: string;
  description: string;
};

/** Fixed reference date used only to seed a stable DTSTART. Not a plan start. */
const SCHEDULE_ANCHOR = "2026-01-01"; // Thursday

const WEEKDAY_NUM: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const EVENT_DURATION_MINUTES = 15;
const ALARM_LEAD_MINUTES = 15;

// ---------------------------------------------------------------- options

export type IcsGenerationOptions = {
  /** Whole-day offset in minutes, applied on top of slotTimes. PRD §7.4/§8. */
  shiftMinutes?: number;
  /** Per-slot absolute time overrides, "HH:MM". Applied before shiftMinutes. */
  slotTimes?: Partial<Record<SlotId, string>>;
  /** Overrides "now" for DTSTAMP — deterministic tests only. */
  now?: Date;
  mealsPerDay?: number | null;
  activeTargetProfile?: Settings["activeTargetProfile"];
};

// ---------------------------------------------------------------- time math

/** Parses "HH:MM" into total minutes since midnight. */
function parseTime(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function formatTime(minutesOfDay: number): { hh: string; mm: string } {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  return { hh: String(h).padStart(2, "0"), mm: String(m).padStart(2, "0") };
}

/** Date of the next occurrence of `byday` on/after `anchor` (both UTC dates). */
function nextOccurrenceOnOrAfter(anchor: Date, byday: string): Date {
  const target = WEEKDAY_NUM[byday];
  const d = new Date(anchor);
  const diff = (target - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

/** Earliest anchor date across a list of BYDAY tokens. */
function anchorDateFor(byday: string[]): Date {
  const anchor = new Date(`${SCHEDULE_ANCHOR}T00:00:00Z`);
  const candidates = byday.map((day) => nextOccurrenceOnOrAfter(anchor, day));
  return candidates.reduce((earliest, d) => (d < earliest ? d : earliest));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYYMMDD" for a UTC-dated anchor. */
function dateStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/**
 * Floating local date-time, e.g. "20260101T083000" — no TZID, no Z. Minutes past the end of the
 * day roll onto the next date, so an event that starts at 23:55 ends at 00:10 the day after,
 * never before it starts (audit A100).
 */
function floatingDateTime(d: Date, minutes: number): string {
  const day = new Date(d);
  day.setUTCDate(day.getUTCDate() + Math.floor(minutes / 1440));
  const { hh, mm } = formatTime(((minutes % 1440) + 1440) % 1440);
  return `${dateStamp(day)}T${hh}${mm}00`;
}

/** UTC date-time with trailing Z, for DTSTAMP. */
function utcDateTime(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

// ---------------------------------------------------------------- text rules

/** RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, newline. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Folds one logical content line at 75 octets per RFC 5545 §3.1, splitting
 * on UTF-8 byte boundaries (never mid-character) and continuing with a
 * single leading space.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Don't split a multi-byte UTF-8 sequence: back off over continuation bytes.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end--;
    }
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation line's leading space is itself 1 octet
  }
  return chunks.join("\r\n ");
}

function buildLines(lines: string[]): string {
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- generator

/**
 * Builds the full VCALENDAR: one recurring VEVENT per account meal slot,
 * each with a weekly RRULE, 15-minute duration and 15-minute-before alarm.
 */
export function generateMealPlanIcs(options: IcsGenerationOptions = {}): string {
  const shiftMinutes = options.shiftMinutes ?? 0;
  const slotTimes = options.slotTimes ?? {};
  const now = options.now ?? new Date();
  const dtstamp = utcDateTime(now);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${APP_NAME}//meal-plan//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${APP_CALENDAR_NAME}`,
  ];

  const byday = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const anchor = anchorDateFor(byday);
  // The same resolution Today shows: per-slot times, then the whole-day shift, clamped to the day
  // (lib/plan.ts `shiftTime`), never wrapped past midnight (audit A090, A100).
  const slots: SlotDefinition[] = resolveSlotTimes("rest", {
    slotTimes, shiftMinutes,
    mealsPerDay: options.mealsPerDay,
    activeTargetProfile: options.activeTargetProfile,
  }).map(({ slot, time }, index) => ({
    slot, time, summary: `Meal ${index + 1}`,
    description: "A meal from your personal plan.",
  }));
  for (const slotDef of slots) {
    const startMinutes = parseTime(slotDef.time);
    const endMinutes = startMinutes + EVENT_DURATION_MINUTES;
    const uid = `${slotDef.slot}@meal-companion.local`;
    const summary = escapeText(slotDef.summary);
    const description = escapeText(slotDef.description);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${floatingDateTime(anchor, startMinutes)}`,
      `DTEND:${floatingDateTime(anchor, endMinutes)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${byday.join(",")}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${summary}`,
      `TRIGGER:-PT${ALARM_LEAD_MINUTES}M`,
      "END:VALARM",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return buildLines(lines);
}

// ---------------------------------------------------------------- handoff

/** data: URI the UI can hand straight to a download link or share sheet. */
export function icsDataUri(ics: string): string {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(ics, "utf8").toString("base64")
      : btoa(unescape(encodeURIComponent(ics)));
  return `data:text/calendar;charset=utf-8;base64,${base64}`;
}

/** Blob for `navigator.share` / an object-URL download link. Browser-only. */
export function icsBlob(ics: string): Blob {
  if (typeof Blob === "undefined") {
    throw new Error("icsBlob() requires a browser environment (Blob is undefined).");
  }
  return new Blob([ics], { type: "text/calendar;charset=utf-8" });
}

export const ICS_FILENAME = "meal-companion.ics";
