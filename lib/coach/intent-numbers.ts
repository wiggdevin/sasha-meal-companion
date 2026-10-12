/**
 * The numbers in a coach message, each with its unit, for the Jev intent pre-pass.
 *
 * A compound amount is read WHOLE (audit 2026-10-10 A029): "1 1/2 cups" is 1.5 cups, "1/2 cup" is
 * half a cup, "an hour and a half" is 90 minutes and "1 hour 30 minutes" is 90 minutes. Read as
 * separate numbers, the fast path applied the first part only ("an hour and a half" moved meals by
 * 60 minutes) or let Jev pick one part of a sum no single part holds.
 *
 * Pure. No I/O. It imports nothing from lib/ai (see lib/coach/intent-args.ts).
 */
import type { ExtractedNumber } from "@/lib/coach/intent-args";

const UNIT = "minutes?|mins?|min|hours?|hrs?|hr|h|cups?|ml|oz|kg|lbs?|pounds?";
const NUM = "\\d+(?:\\.\\d+)?";
const ONE = "an?|one";

function unitOf(raw: string | undefined): ExtractedNumber["unit"] {
  const unit = (raw ?? "").toLowerCase();
  if (["minute", "minutes", "min", "mins", "m"].includes(unit)) return "min";
  if (["hour", "hours", "hr", "hrs", "h"].includes(unit)) return "hour";
  if (["cup", "cups"].includes(unit)) return "cup";
  if (unit === "ml" || unit === "oz" || unit === "kg") return unit;
  if (["lb", "lbs", "pound", "pounds"].includes(unit)) return "lb";
  return null;
}

function amount(word: string): number {
  return /^(?:an?|one)$/i.test(word) ? 1 : Number.parseFloat(word);
}

type Read = { value: number; unit: ExtractedNumber["unit"] } | null;

/** Most specific first: a span one pattern claims is never read again by a later one. */
const PATTERNS: readonly { re: RegExp; read: (m: RegExpExecArray) => Read }[] = [
  // "1 hour 30 minutes", "an hour and 15 min", "2h 30m": one duration in minutes.
  { re: new RegExp(`\\b(${NUM}\\s*|(?:${ONE})\\s+)-?\\s*(?:hours?|hrs?|hr|h)\\s*(?:and\\s+)?(\\d+)\\s*(?:minutes?|mins?|min|m)\\b`, "gi"),
    read: (m) => ({ value: amount(m[1].trim()) * 60 + Number(m[2]), unit: "min" }) },
  // "1 1/2 cups", "2 1/2 hours".
  { re: new RegExp(`\\b(\\d+)\\s+(\\d+)\\s*/\\s*(\\d+)(?:\\s*-?\\s*(${UNIT}))?\\b`, "gi"),
    read: (m) => Number(m[3]) === 0 ? null
      : { value: Number(m[1]) + Number(m[2]) / Number(m[3]), unit: unitOf(m[4]) } },
  // "2 and a half cups", "an hour and a half".
  { re: new RegExp(`\\b(${NUM}|${ONE})\\s+and\\s+a\\s+half\\s+(${UNIT})\\b`, "gi"),
    read: (m) => ({ value: amount(m[1]) + 0.5, unit: unitOf(m[2]) }) },
  { re: new RegExp(`\\b(${NUM}|${ONE})\\s+(${UNIT})\\s+and\\s+a\\s+half\\b`, "gi"),
    read: (m) => ({ value: amount(m[1]) + 0.5, unit: unitOf(m[2]) }) },
  // "1/2 cup", "3/4".
  { re: new RegExp(`\\b(\\d+)\\s*/\\s*(\\d+)(?:\\s*-?\\s*(${UNIT}))?\\b`, "gi"),
    read: (m) => Number(m[2]) === 0 ? null
      : { value: Number(m[1]) / Number(m[2]), unit: unitOf(m[3]) } },
  // "half an hour" stays 30 minutes; "half a cup" is 0.5 cup.
  { re: /\bhalf\s+an?\s+hour\b/gi, read: () => ({ value: 30, unit: "min" }) },
  { re: new RegExp(`\\bhalf\\s+(?:an?\\s+)?(${UNIT})\\b`, "gi"),
    read: (m) => ({ value: 0.5, unit: unitOf(m[1]) }) },
  { re: /\ban\s+hour\b/gi, read: () => ({ value: 1, unit: "hour" }) },
  { re: /\ba\s+cup\b/gi, read: () => ({ value: 1, unit: "cup" }) },
  { re: new RegExp(`\\b(${NUM})(?:(?:\\s*-\\s*|\\s+)(${UNIT}))?\\b`, "gi"),
    read: (m) => ({ value: Number.parseFloat(m[1]), unit: unitOf(m[2]) }) },
];

export function extractNumbers(message: string): ExtractedNumber[] {
  const claimed: { start: number; end: number }[] = [];
  const found: (ExtractedNumber & { at: number })[] = [];
  for (const { re, read } of PATTERNS) {
    for (const match of message.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some((span) => start < span.end && end > span.start)) continue;
      const value = read(match as RegExpExecArray);
      if (value === null || !Number.isFinite(value.value)) continue;
      claimed.push({ start, end });
      found.push({ ...value, raw: match[0], at: start });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ value, unit, raw }) => ({ value, unit, raw }));
}
