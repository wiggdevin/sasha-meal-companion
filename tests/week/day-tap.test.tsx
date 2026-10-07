/**
 * T3 — Week tab: tap a past day to see that day. The Sol audit amendment
 * (2026-09-12 21:20Z) makes each day cell an <a href="/?d=YYYY-MM-DD">, so this
 * stays a Node-environment static render: it asserts the seven hrefs and the
 * computed aria labels, and pins the pure URL-date parser the Today screen uses
 * to honour ?d= on mount. The tap itself is a real document load — a manual
 * phone gate, not a testing-library interaction.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WeekGrid from "@/components/week/WeekGrid";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import { parseUrlDate, viewedDateFromSearch } from "@/lib/url-date";

// Monday 7 Sep .. Sunday 13 Sep 2026, with Wednesday the 9th as "today".
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

describe("WeekGrid day cells link to that day", () => {
  it("renders seven listitems, each linking to /?d=YYYY-MM-DD", () => {
    const markup = renderWeek();
    expect(markup.match(/role="listitem"/g)).toHaveLength(7);
    for (const date of WEEK) {
      expect(markup).toContain(`href="/?d=${date}"`);
    }
  });

  it("labels each cell with its computed status, not a fixed phrase", () => {
    const markup = renderWeek();
    expect(markup).toContain('aria-label="Mon 7 Sep, unplanned"');
    expect(markup).toContain('aria-label="Wed 9 Sep, unplanned"');
    expect(markup).toContain("Not planned");
  });
});

describe("parseUrlDate", () => {
  it("accepts a well-formed ISO date, leap day included", () => {
    expect(parseUrlDate("2026-09-08")).toBe("2026-09-08");
    expect(parseUrlDate("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects malformed and impossible dates", () => {
    expect(parseUrlDate("2026-02-30")).toBeNull();
    expect(parseUrlDate("2026-13-01")).toBeNull();
    expect(parseUrlDate("2026-00-10")).toBeNull();
    expect(parseUrlDate("2026-9-8")).toBeNull();
    expect(parseUrlDate("20260908")).toBeNull();
    expect(parseUrlDate("")).toBeNull();
    expect(parseUrlDate(null)).toBeNull();
  });
});

describe("viewedDateFromSearch", () => {
  it("opens on a valid ?d and keeps today for anything else", () => {
    expect(viewedDateFromSearch("?d=2026-09-08", "2026-09-12")).toBe("2026-09-08");
    expect(viewedDateFromSearch("?d=2026-02-30", "2026-09-12")).toBe("2026-09-12");
    expect(viewedDateFromSearch("", "2026-09-12")).toBe("2026-09-12");
  });
});
