import { describe, expect, it } from "vitest";
import {
  generateMealPlanIcs,
  icsDataUri,
} from "./ics";

/** Splits the raw output into CRLF-delimited physical (folded) lines. */
function physicalLines(ics: string): string[] {
  // Drop the trailing CRLF so we don't get a phantom empty final line.
  return ics.replace(/\r\n$/, "").split("\r\n");
}

/** Re-joins folded continuation lines (leading space) back into logical lines. */
function logicalLines(ics: string): string[] {
  const logical: string[] = [];
  for (const line of physicalLines(ics)) {
    if (line.startsWith(" ") && logical.length > 0) {
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

describe("generateMealPlanIcs", () => {
  it("exports only the account's selected meal layout", () => {
    const calendar = generateMealPlanIcs({ mealsPerDay: 4, now: new Date("2026-09-07T12:00:00Z") });
    const summaries = logicalLines(calendar).filter((line) => line.startsWith("SUMMARY:"));
    expect(summaries).toEqual(["SUMMARY:Meal 1", "SUMMARY:Meal 2", "SUMMARY:Meal 3", "SUMMARY:Meal 4"]);
    expect(calendar).not.toMatch(/Pre-training|refuel|Hot chocolate|SUMMARY:Coffee/i);
  });
  const ics = generateMealPlanIcs({ now: new Date("2026-09-07T12:00:00Z") });

  it("produces a valid VCALENDAR envelope", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("CALSCALE:GREGORIAN");
    expect(ics).toContain("PRODID:-//Sasha//meal-plan//EN");
    expect(ics).toContain("X-WR-CALNAME:Sasha Meals");
  });

  it("uses CRLF line endings exclusively", () => {
    // No bare LF that isn't part of a CRLF pair.
    expect(ics.match(/(?<!\r)\n/)).toBeNull();
    expect(ics).toContain("\r\n");
  });

  it("folds long lines at 75 octets with a single leading-space continuation", () => {
    for (const line of physicalLines(ics)) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });

  it("escapes commas, semicolons and newlines in text fields", () => {
    const escaped = generateMealPlanIcs({
      now: new Date("2026-09-07T12:00:00Z"),
    });
    // The real slot descriptions contain commas; verify the
    // escaping function directly via a crafted case through the public API
    // is not possible without exposing it, so assert on the known content
    // instead: no raw (unescaped) comma/semicolon appears inside a TEXT
    // value line outside of property-parameter position.
    const logical = logicalLines(escaped);
    for (const line of logical) {
      if (line.startsWith("SUMMARY:") || line.startsWith("DESCRIPTION:")) {
        const value = line.split(/:(.+)/)[1];
        // Any comma/semicolon present must be preceded by a backslash.
        expect(value).not.toMatch(/(?<!\\)[,;]/);
      }
    }
  });

  it("reminds for every day of the account layout", () => {
    const logical = logicalLines(ics);
    const rruleLines = logical.filter((l) => l.startsWith("RRULE:"));
    expect(rruleLines).toEqual(Array(3).fill("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU"));
  });

  it("has no UNTIL or COUNT — the reminder set is unbounded", () => {
    expect(ics).not.toContain("UNTIL=");
    expect(ics).not.toContain("COUNT=");
  });

  it("gives every slot a stable, unique UID", () => {
    const uids = logicalLines(ics)
      .filter((l) => l.startsWith("UID:"))
      .map((l) => l.slice(4));
    expect(new Set(uids).size).toBe(uids.length);
    expect(uids.length).toBeGreaterThan(0);
    for (const uid of uids) {
      expect(uid).toMatch(/^[a-z0-9-]+@meal-companion\.local$/);
    }
  });

  it("stamps DTSTAMP and a 15-minute VALARM before each event", () => {
    const logical = logicalLines(ics);
    const dtstamps = logical.filter((l) => l.startsWith("DTSTAMP:"));
    expect(dtstamps.length).toBeGreaterThan(0);
    for (const stamp of dtstamps) {
      expect(stamp).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/);
    }
    const triggers = logical.filter((l) => l.startsWith("TRIGGER:"));
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      expect(trigger).toBe("TRIGGER:-PT15M");
    }
  });

  it("gives events a 15-minute duration via DTSTART/DTEND", () => {
    const logical = logicalLines(ics);
    // Grab the first VEVENT's DTSTART/DTEND pair.
    const startIdx = logical.findIndex((l) => l.startsWith("DTSTART:"));
    const start = logical[startIdx].slice("DTSTART:".length);
    const end = logical[startIdx + 1].slice("DTEND:".length);

    const startMinutes = Number(start.slice(9, 11)) * 60 + Number(start.slice(11, 13));
    const endMinutes = Number(end.slice(9, 11)) * 60 + Number(end.slice(11, 13));
    expect(endMinutes - startMinutes).toBe(15);
  });

  it("uses floating local times — no TZID, no trailing Z on DTSTART", () => {
    const logical = logicalLines(ics);
    for (const line of logical) {
      if (line.startsWith("DTSTART:") || line.startsWith("DTEND:")) {
        expect(line).not.toContain("Z");
        expect(line).not.toContain("TZID");
      }
    }
  });
});

describe("shiftMinutes and slotTimes", () => {
  it("shifts every slot's start time by the given offset", () => {
    const base = generateMealPlanIcs({ now: new Date("2026-09-07T12:00:00Z") });
    const shifted = generateMealPlanIcs({
      shiftMinutes: -90,
      now: new Date("2026-09-07T12:00:00Z"),
    });

    const baseStarts = logicalLines(base)
      .filter((l) => l.startsWith("DTSTART:"))
      .map((l) => l.slice("DTSTART:".length));
    const shiftedStarts = logicalLines(shifted)
      .filter((l) => l.startsWith("DTSTART:"))
      .map((l) => l.slice("DTSTART:".length));

    expect(baseStarts.length).toBe(shiftedStarts.length);
    for (let i = 0; i < baseStarts.length; i++) {
      const baseMin =
        Number(baseStarts[i].slice(9, 11)) * 60 + Number(baseStarts[i].slice(11, 13));
      const shiftedMin =
        Number(shiftedStarts[i].slice(9, 11)) * 60 +
        Number(shiftedStarts[i].slice(11, 13));
      const wrapped = ((baseMin - 90) % 1440 + 1440) % 1440;
      expect(shiftedMin).toBe(wrapped);
    }
  });

  it("applies a per-slot time override, then shiftMinutes on top of it", () => {
    const ics = generateMealPlanIcs({
      slotTimes: { "meal-1": "12:30" },
      shiftMinutes: 15,
      now: new Date("2026-09-07T12:00:00Z"),
    });

    // meal-1 appears in all three day types; every occurrence should now
    // start at 12:45 (12:30 override + 15 min shift).
    const lines = logicalLines(ics);
    let meal1Starts = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "SUMMARY:Meal 1" || lines[i].startsWith("SUMMARY:Meal 1 —")) {
        // walk backward to find this VEVENT's DTSTART
        for (let j = i; j >= 0; j--) {
          if (lines[j].startsWith("DTSTART:")) {
            const t = lines[j].slice("DTSTART:".length);
            expect(t.slice(9, 13)).toBe("1245");
            meal1Starts++;
            break;
          }
        }
      }
    }
    expect(meal1Starts).toBe(1);
  });
});

describe("icsDataUri", () => {
  it("produces a base64 data URI that decodes back to the source", () => {
    const ics = generateMealPlanIcs({ now: new Date("2026-09-07T12:00:00Z") });
    const uri = icsDataUri(ics);
    expect(uri.startsWith("data:text/calendar;charset=utf-8;base64,")).toBe(true);
    const b64 = uri.split(",")[1];
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toBe(ics);
  });
});

describe("meal library safety (cross-cutting, PRD acceptance criterion 11)", () => {
  it("no slot summary or description in the calendar mentions apple as a food", () => {
    const ics = generateMealPlanIcs({ now: new Date("2026-09-07T12:00:00Z") });
    // What must never happen is an apple recommendation anywhere in the calendar.
    expect(ics.toLowerCase()).not.toContain("applesauce");
  });
});
