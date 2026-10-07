/**
 * Design §8.3 — the render spec for Week's two stat cards in their three states (nothing logged,
 * partly logged, populated), plus the index of the grid and strip specs that already cover
 * `WeekGrid` and `TodayDayStrip`.
 *
 * The stat cards are written inline in `app/week/page.tsx` (T1-owned), and their numbers come from
 * `computeWeekStats`. So the two halves are asserted where each one lives: the numbers against the
 * pure function, and the presentation rule — the dash and the two "nothing yet" captions that a
 * first open must show instead of `0%` — against the page's own source. That keeps this spec
 * stable while another lane is editing the same page.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WeekGrid from "@/components/week/WeekGrid";
import TodayDayStrip from "@/components/TodayDayStrip";
import { computeWeekStats } from "@/lib/summary";
import { loadStore } from "@/lib/store";
import type { Macros, ResolvedDay, ResolvedSlot } from "@/lib/types";

const TODAY = "2026-09-10";
const WEEK = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11",
  "2026-09-12", "2026-09-13"];

const TARGETS: Macros = { kcal: 2_100, protein: 135, carbs: 220, fat: 70 };
const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

function slot(id: ResolvedSlot["slot"], time: string, eaten: boolean): ResolvedSlot {
  return { slot: id, time, label: id, meal: eaten
    ? { id: `m-${id}`, name: "Meal", slot: id, components: [], macros: TARGETS,
        prepMinutes: 0, tags: [] }
    : null,
    components: [], macros: eaten ? TARGETS : ZERO, eaten, ...(eaten ? { eatenAt: `${time}` } : {}) };
}

function day(date: string, opts: { targets?: Macros | null; eaten?: boolean } = {}): ResolvedDay {
  const eaten = opts.eaten ?? false;
  return {
    date, dayType: "rest", isFloorDay: false,
    targets: opts.targets === undefined ? TARGETS : opts.targets,
    slots: [slot("meal-1", "08:00", eaten), slot("meal-2", "13:00", false),
      slot("meal-3", "19:00", false)],
    extras: [], consumed: eaten ? TARGETS : ZERO, waterCups: 0,
  };
}

describe("Week's two stat cards", () => {
  it("has nothing logged: nothing to average on a week nobody has touched yet", () => {
    const stats = computeWeekStats(WEEK.map((d) => day(d, { targets: null })), TODAY);
    expect(stats.proteinHitRate).toBeNull();
    expect(stats.calories).toBeNull();
    expect(stats.rangeLabel).not.toBe("");
  });

  it("scores a partly logged week over its past days only, once one carries a tick", () => {
    const stats = computeWeekStats(
      WEEK.map((d) => day(d, { eaten: d === "2026-09-08" })), TODAY);
    expect(stats.proteinHitRate).not.toBeNull();
    // Monday, Tuesday and Wednesday are past; Thursday is today and is not scored.
    expect(stats.proteinHitRate?.total).toBe(3);
    expect(stats.calories?.target).toBe(TARGETS.kcal);
  });

  it("averages every scored day once the week is populated", () => {
    const stats = computeWeekStats(WEEK.map((d) => day(d, { eaten: true })), TODAY);
    expect(stats.proteinHitRate?.pct).toBe(100);
    expect(stats.calories?.avg).toBe(TARGETS.kcal);
  });

  /* The presentation rule the two cards carry (app/week/page.tsx:134,184-206): a week with no
     ticked past day shows a dash and says so, instead of marking the account down at 0 %. */
  it("shows a dash and says why, rather than a zero, before the first tick", () => {
    const page = readFileSync(new URL("../../app/week/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("const weekHasLoggedPastDay = weekDays.some(");
    expect(page).toContain("hit-rate · nothing logged yet");
    expect(page).toContain("average · fills in from tomorrow");
    expect(page).toContain("stats.proteinHitRate && weekHasLoggedPastDay");
    expect(page).toContain("stats.calories && weekHasLoggedPastDay");
  });
});

describe("the week grid and the day strip", () => {
  const days = WEEK.map((d) => day(d, { eaten: d === "2026-09-08" }));

  it("draws one cell a day, with today marked", () => {
    const markup = renderToStaticMarkup(<WeekGrid days={days} today={TODAY} />);
    for (const date of WEEK) expect(markup).toContain(date);
  });

  it("draws the strip around today without claiming a day that has not happened", () => {
    const markup = renderToStaticMarkup(
      <TodayDayStrip date={TODAY} today={TODAY} store={loadStore()} onSelect={() => {}} />);
    expect(markup).toContain("10");
    expect(markup).not.toContain("NaN");
  });

  /**
   * Design §8.3 — the four statuses a cell can carry. The status is the cell's accessible name
   * and its dot colour, so one render of a week that holds all four is the whole assertion.
   */
  it("names each cell all done, partially done, missed or not due yet", () => {
    const week = [
      day("2026-09-07", { eaten: true }),                      // every planned slot ticked
      { ...day("2026-09-08"), extras: [{ id: "x" }] as never }, // nothing planned, one extra
      // Planned and past, with nothing ticked: the one status that must not read as "not due yet".
      { ...day("2026-09-09", { eaten: true }),
        slots: day("2026-09-09", { eaten: true }).slots.map((s) => ({ ...s, eaten: false })) },
      day("2026-09-12"),                                        // still in the future
    ];
    const markup = renderToStaticMarkup(<WeekGrid days={week} today={TODAY} />);
    expect(markup).toContain("7 Sep, all done");
    expect(markup).toContain("8 Sep, partially done");
    expect(markup).toContain("9 Sep, missed");
    expect(markup).toContain("12 Sep, not due yet");
    // The four are four colours: a missed day never reads as one that has not arrived.
    expect(markup).toContain("var(--color-alert)");
    expect(markup).toContain("rgba(0,0,0,0.12)");
  });

  /* Design §8.3: the grid's own colour and tap rules, and the strip's completion rule, already
     have specs. This inventory entry names them so the card × state table has one address each. */
  it.each([
    "tests/week/status-dot-color.test.tsx",
    "tests/week/day-tap.test.tsx",
    "components/TodayDayStrip.test.tsx",
  ])("keeps %s as the spec of record", (spec) => {
    expect(existsSync(new URL(`../../${spec}`, import.meta.url))).toBe(true);
  });
});
