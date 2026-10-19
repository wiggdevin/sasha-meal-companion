// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { OverviewData } from "@/components/today/overview/types";
import { defaultStore } from "@/lib/store";
import type { HealthWindow } from "@/lib/trends/sources";
import type { LoggedFood, Macros, Store, StoredDay } from "@/lib/types";

const motionState = vi.hoisted(() => ({ reduce: false }));
const health = vi.hoisted(() => ({ value: { status: "ok", rows: [] } as HealthWindow }));

vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => motionState.reduce,
}));
vi.mock("@/lib/device/account", async (original) => ({
  ...(await original<typeof import("@/lib/device/account")>()),
  currentAccountOrNull: () => ({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", epoch: 1 }),
}));
vi.mock("@/lib/trends/sources", async (original) => ({
  ...(await original<typeof import("@/lib/trends/sources")>()),
  readHealthWindow: async () => health.value,
  readWaterWindow: async () => new Map([["2026-10-18", 6]]),
  readWaterGoal: async () => () => 8,
}));

const { default: TrendsSlot } = await import("@/components/today/overview/TrendsSlot");

const TODAY = "2026-10-19";
const DAY: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };

function entry(id: string, kcal: number): LoggedFood {
  return { id, foodId: "f", name: "Pasta", portionLabel: "1 plate", qty: 1, grams: 300,
    macros: { kcal, protein: 40, carbs: 10, fat: 5 }, at: `${TODAY}T12:00:00Z` };
}

function store(): Store {
  const s = defaultStore();
  const days: Record<string, StoredDay> = {
    "2026-10-14": { date: "2026-10-14", extras: [entry("a", 1840)] },
    "2026-10-16": { date: "2026-10-16", extras: [entry("b", 2100)] },
  };
  s.days = days;
  s.settings = { ...s.settings, activeTargetProfile: { revision: 1, rev: 1, effectiveFrom: "2026-09-01",
    training: DAY, rest: DAY, pins: { trainingKcal: null, restKcal: null, proteinG: null } } as never };
  return s;
}

function data(over: Partial<OverviewData> = {}): OverviewData {
  return { date: TODAY, today: TODAY, when: "today", targets: DAY, consumed: DAY, partial: false,
    water: { cups: 4, goal: 8 }, next: null, planned: 0, store: store(), ...over };
}

async function mount(over: Partial<OverviewData> = {}) {
  const utils = render(<TrendsSlot data={data(over)} active />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return utils;
}

const open = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => { motionState.reduce = false; health.value = { status: "ok", rows: [] }; });
afterEach(cleanup);

describe("TrendsSlot", () => {
  it("collapsed is one row of three mini charts with each 7-day figure", async () => {
    await mount();
    const minis = screen.getAllByRole("button", { expanded: false });
    expect(minis.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Calories: 1,970 kcal avg. Open chart", "Sleep: No data. Open chart", "Activity: No data. Open chart",
    ]);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("opens in place with the chart, a hidden data table and 44 px columns", async () => {
    await mount();
    open(/^Calories:/);
    expect(screen.getByRole("button", { name: /^Calories:.*Close chart/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("img").getAttribute("aria-label"))
      .toBe("Calories, last 7 days: averages 1,970 kcal over 2 days.");
    const table = screen.getByRole("table");
    expect(table.className).toContain("sr-only");
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    const css = readFileSync("components/charts/Charts.module.css", "utf8");
    expect(css).toMatch(/\.hit \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
    expect(screen.getAllByRole("button", { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) · / })).toHaveLength(7);
  });

  it("shows a column's readout on tap, and a missing day as a gap, never 0", async () => {
    await mount();
    open(/^Calories:/);
    fireEvent.click(screen.getByRole("button", { name: /^Wed · / }));
    expect(document.querySelector("[aria-live]")?.textContent).toBe("Wed · 1,840 kcal · target 2,000 kcal");
    expect(screen.getByRole("button", { name: "Thu · nothing logged" })).toBeTruthy();
    expect(document.querySelectorAll("[data-bar]")).toHaveLength(2);
    expect(screen.getByText("Within 10% of your calorie target on 2 of 2 days.")).toBeTruthy();
  });

  it("says Connect health instead of drawing sleep when health is off", async () => {
    health.value = { status: "off" };
    await mount();
    open(/^Sleep:/);
    const link = screen.getByRole("link", { name: "Connect health to see sleep" });
    expect(link.getAttribute("href")).toBe("/settings");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says workouts aren't recorded yet on the activity chart", async () => {
    health.value = { status: "ok", rows: [{ local_date: "2026-10-18", steps: 6000, active_kcal: 320, sleep_minutes: 430,
      body_mass_kg: null, sources: [], resting_heart_rate: null, hrv_sdnn: null, readiness_score: null, provenance: {} }] };
    await mount();
    open(/^Activity:/);
    expect(screen.getByText("Workouts aren't recorded yet.")).toBeTruthy();
    expect(screen.getByRole("img")).toBeTruthy();
  });

  it("switches to 4 weeks of weekly means with the day count", async () => {
    await mount();
    open(/^Calories:/);
    fireEvent.click(screen.getByRole("tab", { name: "4 weeks" }));
    expect(screen.getByRole("button", { name: "Week of Oct 13 · 1,970 kcal a day · target 2,000 kcal · 2 of 7 days" })).toBeTruthy();
  });

  it("has no target before the first revision", async () => {
    const s = store();
    s.settings = { ...s.settings, activeTargetProfile: null as never, targetHistory: [] };
    await mount({ store: s });
    open(/^Calories:/);
    expect(screen.getByText("Targets start once your profile is finished.")).toBeTruthy();
    expect(document.querySelectorAll("[data-target]")).toHaveLength(0);
  });

  it("draws bars without the rise under reduced motion", async () => {
    motionState.reduce = true;
    await mount();
    open(/^Calories:/);
    for (const bar of document.querySelectorAll("[data-bar]")) expect(bar.getAttribute("style") ?? "").not.toContain("scaleY(0)");
    cleanup();
    motionState.reduce = false;
    await mount();
    open(/^Calories:/);
    expect([...document.querySelectorAll("[data-bar]")].every((bar) => (bar.getAttribute("style") ?? "").includes("scaleY(0)")))
      .toBe(true);
  });
});
