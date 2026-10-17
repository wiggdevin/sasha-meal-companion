// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TodayDayStrip, {
  completionFor, mondayFor, resolveStripDay, shiftCalendarDay, weekCaption, weekFlickOffset,
} from "./TodayDayStrip";
import { defaultStore } from "@/lib/store";
import { resolveDay } from "@/lib/resolve";
import { starterChoices, starterDefaultIds, starterFood } from "@/lib/foods/starter";
import { todayResolveInputs, type TodayLive } from "@/lib/today/resolve-inputs";
import type { Store } from "@/lib/types";

// A call-through capture of every date the strip's status cache actually resolves (Sol R2 perf
// review): the real function, recorded, so a test can prove a future date was never asked for and
// that an unchanged re-render asks for nothing new.
const stripResolves = vi.hoisted(() => ({ dates: [] as string[] }));
vi.mock("@/lib/today/resolve-strip-day", async (original) => {
  const actual = await original<typeof import("@/lib/today/resolve-strip-day")>();
  return { ...actual, resolveStripDay: (...args: Parameters<typeof actual.resolveStripDay>) => {
    stripResolves.dates.push(args[1]);
    return actual.resolveStripDay(...args);
  } };
});

const store = defaultStore();

describe("TodayDayStrip calendar navigation", () => {
  it("moves calendar days across both DST boundaries without repeating or skipping", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(shiftCalendarDay("2026-03-07", 1)).toBe("2026-03-08");
      expect(shiftCalendarDay("2026-03-08", 1)).toBe("2026-03-09");
      expect(shiftCalendarDay("2026-11-01", 1)).toBe("2026-11-02");
      expect(shiftCalendarDay("2026-11-02", -1)).toBe("2026-11-01");
      expect(mondayFor("2026-11-01")).toBe("2026-10-26");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("supports arbitrary past/future weeks, leap days and year boundaries", () => {
    expect(shiftCalendarDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftCalendarDay("2028-02-29", 1)).toBe("2028-03-01");
    expect(mondayFor("2027-01-01")).toBe("2026-12-28");
    expect(shiftCalendarDay("2026-12-28", 7)).toBe("2027-01-04");
    expect(shiftCalendarDay(shiftCalendarDay("2026-09-15", 7000), -7000)).toBe("2026-09-15");
    expect(weekCaption("2026-12-28")).toBe("December 2026 – January 2027");
    expect(weekCaption("2026-09-14")).toBe("September 2026");
  });

  it("selects day +30 with its materialized dish title and components intact", () => {
    const start = "2026-09-20";
    const future = shiftCalendarDay(start, 30);
    const planned = resolveDay(store, future).slots.find((slot) => slot.slot === "meal-1")!;
    const component = { name: "Sourdough toast", qty: 76, unit: "g" as const,
      role: "carb" as const, macros: { kcal: 202, protein: 7, carbs: 37, fat: 2.4 } };
    const materialized = { ...store, days: { ...store.days, [future]: { date: future,
      itemOverrides: { "meal-1": { baseMealId: planned.meal?.id ?? null,
        title: "Toast, bacon & eggs", components: [component] } } } } };
    const selected = resolveDay(materialized, future).slots.find((slot) => slot.slot === "meal-1");
    const markup = renderToStaticMarkup(<TodayDayStrip date={future} today={start}
      store={materialized} onSelect={() => {}} />);
    expect(markup).toContain(`data-date="${future}"`);
    expect(selected?.meal?.name).toBe("Toast, bacon & eggs");
    expect(selected?.components).toEqual([component]);
  });

  it("uses quick deliberate horizontal flicks for exact week jumps", () => {
    expect(weekFlickOffset(-90, 150)).toBe(7);
    expect(weekFlickOffset(90, 150)).toBe(-7);
    expect(weekFlickOffset(-90, 800)).toBe(0);
    expect(weekFlickOffset(-20, 20)).toBe(0);
    expect(weekFlickOffset(-90, 0)).toBe(0);
  });

  it("scores a day complete, partial or empty by WeekGrid's rules, hot chocolate optional", () => {
    const day = resolveDay(store, "2026-09-13");
    expect(completionFor(day, "2026-09-15")).toBe("unplanned");
    expect(completionFor(day, "2026-09-13")).toBe("unplanned");
    const planned = { ...day, slots: day.slots.map((slot) => ({ ...slot, meal: slot.slot === "hot-chocolate"
      ? null : { id: slot.slot, name: slot.label, slot: slot.slot, components: [], macros: slot.macros,
        prepMinutes: 0, tags: [] } })) };
    const done = { ...planned, slots: planned.slots.map((slot) => ({
      ...slot, eaten: slot.slot !== "hot-chocolate",
    })) };
    expect(completionFor(done, "2026-09-15")).toBe("all done");
    expect(completionFor(done, "2026-09-12")).toBe("not due yet");
    const partial = { ...planned, slots: planned.slots.map((slot, index) => ({
      ...slot, eaten: index === 0,
    })) };
    expect(completionFor(partial, "2026-09-15")).toBe("partially done");
  });

  it("distinguishes the selected day from today and keeps the full date visible", () => {
    const markup = renderToStaticMarkup(<TodayDayStrip date="2026-09-14" today="2026-09-15" store={store} onSelect={() => {}} />);
    expect(markup).toContain('data-date="2026-09-14" aria-label="Monday 14 September 2026, unplanned" aria-pressed="true"');
    expect(markup).toContain('data-date="2026-09-15" aria-label="Tuesday 15 September 2026, unplanned" aria-pressed="false" aria-current="date"');
    expect(markup).not.toContain('aria-label="Previous week"');
    expect(markup).not.toContain('aria-label="Next week"');
    expect(markup).toContain('aria-label="Monday, September 14, 2026. Expand calendar"');
    expect(markup).not.toContain('aria-label="Jump to date"');
    expect(markup).not.toContain('aria-label="Month calendar"');
    expect(markup).not.toContain('>Today</button>');
    expect(markup).not.toContain('type="date"');
    expect(markup.match(/role="group"/g)).toHaveLength(1);
    expect(markup.match(/data-date=/g)).toHaveLength(57);
    expect(markup).toContain("snap-center");
    // The strip sits inside a glass surface: charcoal text, never the haloed .ground classes,
    // which read as blurred ghosts on white (Devin, 2026-09-22).
    expect(markup).toMatch(/class="[^"]*text-graphite[^"]*">Mon<\/span>/);
    // The selected day reads cream inside the olive lens (2026-10-01); the others are charcoal,
    // and today, outside the lens, is red.
    expect(markup).toMatch(/class="[^"]*text-on-primary[^"]*">14<\/span>/);
    expect(markup).toMatch(/class="[^"]*text-charcoal[^"]*">16<\/span>/);
    expect(markup).toMatch(/class="[^"]*text-alert[^"]*">15<\/span>/);
    expect(markup).toContain('data-day-lens=""');
    expect(markup).not.toContain("data-day-tick");
    expect(markup).not.toMatch(/class="[^"]*\bground(-muted)?\b[^"]*">(Mon|14)<\/span>/);
  });
});

describe("TodayDayStrip: narrow phones (W157)", () => {
  it("keeps every day a 44 px target in a snap scroller, so a 320 px screen scrolls instead of clipping", () => {
    const markup = renderToStaticMarkup(<TodayDayStrip date="2026-09-14" today="2026-09-15" store={store}
      onSelect={() => {}} />);
    // basis max(44px, 1/7): 7 x 44 = 308 px fits 320 px; below that the row scrolls, each day reachable.
    expect(markup).toContain("basis-[max(44px,100%/7)]");
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("snap-x");
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("snap-center");
  });
});

describe("TodayDayStrip month calendar", () => {
  beforeEach(() => {
    // jsdom has no layout: the strip's recentring and resize observer become no-ops.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false })) as typeof window.matchMedia;
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  const renderStrip = () => {
    const onSelect = vi.fn();
    render(<TodayDayStrip date="2026-09-14" today="2026-09-15" store={store} onSelect={onSelect} />);
    return { onSelect, heading: screen.getByRole("button", { name: /Monday, September 14, 2026/ }) };
  };

  it("keeps a full selected-date heading above the week without a native date picker or visible handle", () => {
    render(<TodayDayStrip date="2026-09-14" today="2026-09-15" store={store} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Monday, September 14, 2026/ })).toBeTruthy();
    expect(screen.queryByLabelText("Jump to date")).toBeNull();
    expect(screen.queryByRole("button", { name: "Month calendar" })).toBeNull();
  });

  it("renders the expanded calendar's four more weeks in place when a date is double-clicked", () => {
    render(<TodayDayStrip date="2026-09-14" today="2026-09-15" store={store} onSelect={() => {}} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: /Monday 14 September 2026/ }));
    const month = screen.getByRole("group", { name: "Following four weeks" });
    expect(within(month).getByRole("button", { name: /Friday 18 September 2026/ })).toBeTruthy();
    expect(within(month).getByRole("button", { name: /Thursday 15 October 2026/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close month calendar" })).toBeNull();
  });

  it("renders only the week initially", () => {
    const markup = renderToStaticMarkup(<TodayDayStrip date="2026-09-14" today="2026-09-15"
      store={store} onSelect={() => {}} />);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("data-month-calendar");
  });

  it("opens and closes the inline grid from the accessible date heading", () => {
    const { heading } = renderStrip();
    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "Following four weeks" })).toBeTruthy();
    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Following four weeks" })).toBeNull();
  });

  it("opens from empty card space without requiring a tiny target", () => {
    const { heading } = renderStrip();
    fireEvent.doubleClick(screen.getByRole("region", { name: "Choose a day" }));
    expect(heading.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses on a second double-tap, ignoring the dblclick echo of the same gesture", () => {
    vi.useFakeTimers();
    const { heading } = renderStrip();
    const region = screen.getByRole("region", { name: "Choose a day" });
    fireEvent.doubleClick(region);
    fireEvent.doubleClick(region); // Android Chromium's dblclick after a touch double-tap
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    vi.advanceTimersByTime(500);
    fireEvent.doubleClick(region);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens from two stationary touch taps but not from a swipe", () => {
    vi.useFakeTimers();
    const { heading } = renderStrip();
    const region = screen.getByRole("region", { name: "Choose a day" });
    const touch = (x: number, y: number) => [{ clientX: x, clientY: y }];
    fireEvent.touchStart(region, { touches: touch(100, 100) });
    fireEvent.touchEnd(region, { changedTouches: touch(170, 100) });
    fireEvent.touchStart(region, { touches: touch(100, 100) });
    fireEvent.touchEnd(region, { changedTouches: touch(100, 100) });
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    vi.advanceTimersByTime(400);
    fireEvent.touchStart(region, { touches: touch(100, 100) });
    fireEvent.touchEnd(region, { changedTouches: touch(100, 100) });
    vi.advanceTimersByTime(120);
    fireEvent.touchStart(region, { touches: touch(100, 100) });
    fireEvent.touchEnd(region, { changedTouches: touch(100, 100) });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
  });

  it("routes a picked date through onSelect and stays expanded", () => {
    const { heading, onSelect } = renderStrip();
    fireEvent.click(heading);
    fireEvent.click(within(screen.getByRole("group", { name: "Following four weeks" }))
      .getByRole("button", { name: /Thursday 24 September 2026/ }));
    expect(onSelect).toHaveBeenCalledWith("2026-09-24");
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "Following four weeks" })
      .querySelector("button[data-date]")?.getAttribute("data-date")).toBe("2026-09-18");
  });

  it("keeps expanded dates continuous after the selected week changes", () => {
    function Controlled() {
      const [date, setDate] = useState("2026-09-14");
      return <TodayDayStrip date={date} today="2026-09-15" store={store} onSelect={setDate} />;
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole("button", { name: /Monday, September 14, 2026/ }));
    const month = screen.getByRole("group", { name: "Following four weeks" });
    fireEvent.click(within(month).getByRole("button", { name: /Thursday 24 September 2026/ }));
    expect(month.querySelector("button[data-date]")?.getAttribute("data-date")).toBe("2026-09-28");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-09-24");
  });

  it("moves the additional rows with the selected strip after navigation", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<TodayDayStrip date="2026-09-14" today="2026-09-15"
      store={store} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Monday, September 14, 2026/ }));
    rerender(<TodayDayStrip date="2026-09-29" today="2026-09-15"
      store={store} onSelect={onSelect} />);
    expect(screen.getByRole("group", { name: "Following four weeks" })
      .querySelector("button[data-date]")?.getAttribute("data-date")).toBe("2026-10-03");
  });

  it("closes on Escape and returns focus to the date heading", () => {
    const { heading } = renderStrip();
    fireEvent.click(heading);
    fireEvent.keyDown(screen.getByRole("group", { name: "Following four weeks" }), { key: "Escape" });
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(heading);
  });
});

/**
 * Parity with Today (defect found by a GPT-6 Sol review, predates Phase 19 R2): the strip used to
 * resolve every day with the bare `resolveDay(store, day)`, without `eligibleFoodIds` — so its
 * completion dots could miss generated meals Today and the rebalance panel both show. The strip now
 * routes each day through the same builder (lib/today/resolve-inputs.ts) Today uses, via the
 * exported `resolveStripDay` helper.
 */
describe("TodayDayStrip: resolves each day like Today (lib/today/resolve-inputs.ts)", () => {
  const DATE = "2026-10-06";

  beforeEach(() => {
    stripResolves.dates.length = 0;
    // jsdom has no layout: the strip's recentring and resize observer become no-ops.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false })) as typeof window.matchMedia;
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  /** An onboarded account whose Eats are the reviewed starter foods, so meals really generate
   *  (tests/rebalance/panel-client.test.ts's starterAccount fixture, copied). */
  function starterAccount(): { store: Store; foods: Record<string, unknown> } {
    const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
    const foods = Object.fromEntries(starterDefaultIds(starterChoices([], rules)).map((id) => {
      const food = starterFood(id, "eats"); return [food.id, food];
    }));
    const base = defaultStore();
    base.foods = foods as Store["foods"];
    base.settings = { ...base.settings, onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
      mealsPerDay: 3, ruleReviewReady: true,
      activeTargetProfile: { revision: 1,
        training: { kcal: 2000, protein: 140, carbs: 180, fat: 72 },
        rest: { kcal: 2000, protein: 140, carbs: 180, fat: 72 },
        pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
    return { store: base, foods };
  }

  it("resolveStripDay equals Today's builder-backed resolve, and is not the old bare resolveDay (not vacuous: generated meals exist only with eligible ids)", () => {
    const { store: starter, foods } = starterAccount();
    const live: TodayLive = { eligibleFoodIds: new Set(Object.keys(foods)), accepted: null,
      recipeAccessEnabled: false, ruleReviewReady: true };

    const viaStrip = resolveStripDay(starter, DATE, live);
    const viaToday = resolveDay(...todayResolveInputs(starter, DATE, live).args);
    expect(viaStrip).toEqual(viaToday);

    const bare = resolveDay(starter, DATE);
    expect(viaStrip).not.toEqual(bare);
    expect(viaStrip.slots.some((slot) => slot.meal !== null)).toBe(true);
    expect(bare.slots.some((slot) => slot.meal !== null)).toBe(false);
  });

  it("without a live object, resolveStripDay reproduces the strip's old unprojected resolve", () => {
    const { store: starter } = starterAccount();
    expect(resolveStripDay(starter, DATE)).toEqual(resolveDay(starter, DATE));
  });

  it("the live prop reaches every rendered day: a generated-meal date reads differently with it than without (render + waitFor: the status cache is async off the render path)", async () => {
    const { store: starter, foods } = starterAccount();
    const live: TodayLive = { eligibleFoodIds: new Set(Object.keys(foods)), accepted: null,
      recipeAccessEnabled: false, ruleReviewReady: true };
    const withLive = render(<TodayDayStrip date={DATE} today={DATE} store={starter} onSelect={() => {}} live={live} />);
    // Generated meals exist (unlogged) on DATE === today: completionFor's own "today, nothing eaten
    // yet" rule reads that as "not due yet" — the SAME word the free future-day shortcut uses, but
    // for a different reason, and only the cache (not the shortcut, since DATE is not > today) can
    // produce it here, because it had to resolve real generated slots to find them unlogged.
    await waitFor(() => expect(screen.getByRole("button", { name: /Tuesday 6 October 2026/ }).getAttribute("aria-label"))
      .toContain("not due yet"), { timeout: 10_000 });
    withLive.unmount();
    cleanup();

    render(<TodayDayStrip date={DATE} today={DATE} store={starter} onSelect={() => {}} />);
    // Without eligibleFoodIds nothing generates at all: "unplanned" is the correct, settled answer,
    // not a stand-in for "not yet computed" (the fixture's required slots never exist either way).
    await waitFor(() => expect(screen.getByRole("button", { name: /Tuesday 6 October 2026/ }).getAttribute("aria-label"))
      .toContain("unplanned"), { timeout: 10_000 });
  });

  it("never asks the resolver for a future date: completionFor's own date check decides it for free", async () => {
    const { store: starter, foods } = starterAccount();
    const live: TodayLive = { eligibleFoodIds: new Set(Object.keys(foods)), accepted: null,
      recipeAccessEnabled: false, ruleReviewReady: true };
    const future = shiftCalendarDay(DATE, 10);
    render(<TodayDayStrip date={future} today={DATE} store={starter} onSelect={() => {}} live={live} />);
    // The strip's window still spans some past/today dates from this anchor, so some real work
    // does run; the future date's own exclusion from the queue holds regardless of how far that
    // work has gotten, so no extra settling wait is needed once it has started at all.
    await waitFor(() => expect(stripResolves.dates.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(stripResolves.dates).not.toContain(future);
  });

  it("does not recompute on a re-render with the same store and live (effect deps unchanged)", async () => {
    const { store: starter, foods } = starterAccount();
    const live: TodayLive = { eligibleFoodIds: new Set(Object.keys(foods)), accepted: null,
      recipeAccessEnabled: false, ruleReviewReady: true };
    const onSelect = () => {};
    // The window centred on DATE === today has exactly WINDOW_RADIUS + 1 = 29 past/today dates
    // (offsets -28..0); monthOpen is false here, so that is the whole queue. A shared, loaded
    // machine can stretch the chunked wall-clock time a lot without anything being wrong, so this
    // waits generously rather than asserting a tight bound.
    const { rerender } = render(<TodayDayStrip date={DATE} today={DATE} store={starter} onSelect={onSelect} live={live} />);
    await waitFor(() => expect(stripResolves.dates.length).toBe(29), { timeout: 10_000 });

    rerender(<TodayDayStrip date={DATE} today={DATE} store={starter} onSelect={onSelect} live={live} />);
    // Give any (incorrectly) rescheduled recompute a chance to run before proving there was none.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stripResolves.dates.length).toBe(29);
  });
});
