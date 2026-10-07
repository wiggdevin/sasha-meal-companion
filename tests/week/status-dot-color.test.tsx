/**
 * Audit finding #89 (fix-weekgrid-missed-day-indicator): WeekGrid's status
 * dot renders "missed" (red) and "not due yet" (grey) with the exact same
 * color, so the Week tab can't visually tell them apart at a glance.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WeekGrid from "@/components/week/WeekGrid";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";

// Monday 7 Sep .. Sunday 13 Sep 2026, with Wednesday the 9th as "today" —
// same fixture as tests/week/day-tap.test.tsx.
const WEEK = [
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
  "2026-09-11",
  "2026-09-12",
  "2026-09-13",
];
const TODAY = "2026-09-09";

function renderWeek(): string {
  const store = loadStore();
  return renderToStaticMarkup(
    <WeekGrid days={WEEK.map((date) => resolveDay(store, date))} today={TODAY} />,
  );
}

function dotBackgroundFor(markup: string, date: string): string {
  const cellStart = markup.indexOf(`href="/?d=${date}"`);
  const dotMatch = markup.slice(cellStart).match(/background:([^;"]+)/);
  if (!dotMatch) throw new Error(`no status dot found for ${date}`);
  return dotMatch[1];
}

describe("WeekGrid empty-day status", () => {
  it("renders an untouched past day as neutral and unplanned", () => {
    const markup = renderWeek();
    expect(markup).toContain('aria-label="Mon 7 Sep, unplanned"');
    expect(markup.slice(markup.indexOf('href="/?d=2026-09-07"'),
      markup.indexOf('href="/?d=2026-09-08"'))).toContain("Not planned");
    expect(dotBackgroundFor(markup, "2026-09-13")).toBe("rgba(0,0,0,0.12)");
  });
});
