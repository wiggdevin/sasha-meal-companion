import { describe, expect, it } from "vitest";
import { ORBIT_KEYS, orbitNodes, nutrientBalance, sleepAmount, type OrbitBody } from "@/lib/today/health-orbit";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { Macros } from "@/lib/types";

const targets: Macros = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
const consumed: Macros = { kcal: 1200, protein: 90, carbs: 80, fat: 30 };
const ROW: DailyHealthRow = {
  local_date: "2026-09-30", steps: 8012, active_kcal: 412, sleep_minutes: 444, body_mass_kg: null,
  sources: [], resting_heart_rate: null, hrv_sdnn: null, readiness_score: 82, provenance: {},
};
const ready = (row: DailyHealthRow | null): OrbitBody =>
  ({ capability: "enabled", loading: false, row, offline: false, fetchedAt: null });
const node = (body: OrbitBody | undefined, key: string, water = { cups: 3, goal: 8 }) =>
  orbitNodes({ targets, consumed, water, body }).find((n) => n.key === key)!;

describe("health orbit model", () => {
  it("has seven nodes in the approved order", () => {
    expect(ORBIT_KEYS).toEqual(["calories", "carbs", "protein", "fat", "water", "activity", "recovery"]);
    expect(orbitNodes({ targets, consumed, water: undefined, body: undefined }).map((n) => n.key))
      .toEqual(ORBIT_KEYS);
  });

  it("never confuses calories eaten with active burn", () => {
    const eaten = node(ready(ROW), "calories");
    const burn = node(ready(ROW), "activity");
    expect(eaten.name).toBe("Calories eaten");
    expect(eaten.label).toBe("Eaten");
    expect(eaten.amount).toBe("1,200 kcal");
    expect(burn.name).toBe("Active burn");
    expect(burn.label).toBe("Active");
    expect(burn.amount).toBe("412 kcal");
  });

  it("reports remaining, or an honest overage, against the target", () => {
    expect(nutrientBalance(1200, 2000)).toEqual({ remaining: 800, over: 0 });
    expect(nutrientBalance(2250, 2000)).toEqual({ remaining: 0, over: 250 });
    expect(node(undefined, "fat").progress).toBeCloseTo(30 / 70);
    const over = orbitNodes({ targets, consumed: { ...consumed, kcal: 2250 }, water: undefined, body: undefined })[0];
    expect(over.over).toBe(true);
    expect(over.spoken).toBe("Calories eaten: 2,250 of 2,000 kcal, 250 kcal over");
  });

  it("keeps loading, off and missing body data truthful instead of zero", () => {
    expect(node(undefined, "activity").state).toBe("loading");
    expect(node({ ...ready(null), capability: "unknown" }, "activity").amount).toBe("…");
    expect(node({ ...ready(null), loading: true }, "recovery").state).toBe("loading");
    const off = node({ ...ready(null), capability: "disabled" }, "activity");
    expect(off.state).toBe("off");
    expect(off.amount).toBe("Off");
    const empty = node(ready({ ...ROW, active_kcal: null, steps: null }), "activity");
    expect(empty.state).toBe("empty");
    expect(empty.amount).toBe("—");
    expect(empty.amount).not.toContain("0");
  });

  it("falls back to steps and readiness only when those are what the day has", () => {
    const steps = node(ready({ ...ROW, active_kcal: null }), "activity");
    expect(steps.label).toBe("Steps");
    expect(steps.amount).toBe("8,012");
    const sleep = node(ready(ROW), "recovery");
    expect(sleep.label).toBe("Sleep");
    expect(sleep.amount).toBe("7h 24m");
    const readiness = node(ready({ ...ROW, sleep_minutes: null }), "recovery");
    expect(readiness.label).toBe("Readiness");
    expect(readiness.amount).toBe("82");
    expect(sleepAmount(45)).toBe("45m");
  });

  it("shows water as loading until the day is read, then cups against the goal", () => {
    const loading = orbitNodes({ targets, consumed, water: undefined, body: undefined })[4];
    expect(loading.state).toBe("loading");
    expect(loading.amount).toBe("…");
    expect(node(undefined, "water").amount).toBe("3 cups");
    expect(node(undefined, "water").spoken).toBe("Water: 3 of 8 cups");
    expect(node(undefined, "water", { cups: 1, goal: 0 }).spoken).toBe("Water: 1 cup");
  });
});
