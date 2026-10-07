// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lbToKg } from "@/lib/health/units";
import { defaultSettings } from "@/lib/store";
import type { WaterSettings } from "@/lib/water-client";

const water = vi.hoisted(() => ({
  read: null as unknown as WaterSettings,
  readWaterSettings: vi.fn(),
  setWaterPrefs: vi.fn(),
  setGoal: vi.fn(),
}));

vi.mock("@/lib/water-client", () => ({
  readWaterSettings: water.readWaterSettings,
  setWaterPrefs: water.setWaterPrefs,
  setGoal: water.setGoal,
}));
// No weigh-in on this phone: the synced profile weight is the one the goal uses.
vi.mock("@/lib/today/water-and-weight", () => ({ waterGoalWeightKg: () => null }));
vi.mock("@/lib/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/store")>()),
  loadStore: () => ({ version: 1, firstOpenedAt: "2026-09-01", settings: defaultSettings(), days: {}, foods: {} }),
  saveStore: vi.fn(),
}));

const { default: WaterSection } = await import("@/components/settings/WaterSection");

const settings = { ...defaultSettings(), weightUnit: "lb" as const };

beforeEach(() => {
  water.readWaterSettings.mockImplementation(async () => water.read);
  water.setWaterPrefs.mockImplementation(async (patch) => ({ ...water.read.prefs, ...patch }));
  water.setGoal.mockImplementation(async (cups: number) => cups);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Settings › Water", () => {
  it("shows the auto goal from the weight, and a unit change rewrites every figure", async () => {
    water.read = { stored: { water_goal_cups: 8, water_goal_cups_training: 8, water_goal_cups_rest: 8 },
      prefs: {}, profileWeightKg: lbToKg(215) };
    render(<WaterSection settings={settings} />);
    expect(await screen.findByText("From your weight (215 lb): 128 oz a day, 144 oz on training days."))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Auto (from your weight)" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Cups" }));
    expect(screen.getByText("From your weight (215 lb): 16 cups a day, 18 cups on training days.")).toBeTruthy();
    expect(water.setWaterPrefs).toHaveBeenCalledExactlyOnceWith({ unit: "cups" });
  });

  it("keeps a goal set by hand and says the auto goal is available", async () => {
    water.read = { stored: { water_goal_cups_training: 10, water_goal_cups_rest: 7 }, prefs: { unit: "oz" },
      profileWeightKg: lbToKg(215) };
    render(<WaterSection settings={settings} />);
    expect(await screen.findByText("Auto (from your weight) is available: 128 oz a day, 144 oz on training days."))
      .toBeTruthy();
    expect(screen.getByRole("group", { name: "Training days water goal" }).textContent).toContain("80 oz");
    expect(screen.getByRole("group", { name: "Rest days water goal" }).textContent).toContain("56 oz");

    fireEvent.click(screen.getByRole("button", { name: "Raise the training days goal" }));
    expect(water.setGoal).toHaveBeenCalledExactlyOnceWith(11, "training-10");

    fireEvent.click(screen.getByRole("button", { name: "Auto (from your weight)" }));
    await vi.waitFor(() => expect(water.setWaterPrefs).toHaveBeenCalledWith({ goal: "auto" }));
  });

  it("starts a first goal of its own from the auto numbers", async () => {
    water.read = { stored: {}, prefs: {}, profileWeightKg: lbToKg(215) };
    render(<WaterSection settings={settings} />);
    fireEvent.click(await screen.findByRole("button", { name: "My own goal" }));
    await vi.waitFor(() => expect(water.setGoal).toHaveBeenCalledTimes(2));
    expect(water.setGoal.mock.calls).toEqual([[18, "training-10"], [16, "rest"]]);
  });

  it("says 64 oz until the profile has a weight", async () => {
    water.read = { stored: {}, prefs: {}, profileWeightKg: null };
    render(<WaterSection settings={settings} />);
    expect(await screen.findByText("64 oz a day until your profile has a weight.")).toBeTruthy();
  });
});
