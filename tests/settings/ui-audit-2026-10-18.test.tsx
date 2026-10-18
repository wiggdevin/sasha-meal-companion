// @vitest-environment jsdom
/**
 * UI audit 2026-10-18 §3 (Settings targets and health): health off or a failed read settles the
 * rows, the profile card never fakes progress or flashes "unavailable" while loading, the targets
 * sheet shows its save and announces its error, and a dismissed share sheet downloads nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";

const health = vi.hoisted(() => ({ read: vi.fn(), probe: vi.fn(), daily: vi.fn() }));
vi.mock("@/lib/health/capability", () => ({
  readBodyCapability: () => health.read(),
  probeBodyCapability: () => health.probe(),
}));
vi.mock("@/lib/health-client", async (original) => ({
  ...(await original<typeof import("@/lib/health-client")>()),
  fetchDaily: (...args: unknown[]) => health.daily(...args),
}));

import { settingsDaily } from "@/components/settings/use-settings-controller";
import { profileProgress, profileStatusLabel } from "@/components/settings/AppProfileCard";
import TargetModeSheet from "@/components/TargetModeSheet";
import ScheduleSection from "@/components/settings/ScheduleSection";

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("Settings health rows settle", () => {
  it("answers health off as disabled, never null, so the rows say 'Not available yet'", async () => {
    health.read.mockReturnValue("disabled");
    expect(await settingsDaily({} as never, "a", "b"))
      .toEqual({ response: null, fetchedAt: null, offline: false, disabled: true });
    expect(health.daily).not.toHaveBeenCalled();
  });

  it("answers a failed probe as a failed check, so the rows say 'Couldn't check'", async () => {
    health.read.mockReturnValue("unknown");
    health.probe.mockRejectedValue(new Error("network"));
    expect(await settingsDaily({} as never, "a", "b"))
      .toEqual({ response: null, fetchedAt: null, offline: true, disabled: false });
  });
});

describe("the profile card", () => {
  it("fills the ring from the profile fields actually set", () => {
    const settings = { ...defaultSettings(), sex: "female", birthYear: 1990, heightCm: 165 } as Settings;
    expect(profileProgress(defaultSettings())).toBe(0);
    expect(profileProgress(settings)).toBe(50);
  });

  it("shows no tag while the targets load, and 'unavailable' only after a failed read", () => {
    expect(profileStatusLabel(true, "loading")).toBeNull();
    expect(profileStatusLabel(true, "ready")).toBe("Plan ready");
    expect(profileStatusLabel(true, "failed")).toBe("Targets unavailable");
    expect(profileStatusLabel(true, "needs_profile")).toBe("No targets yet");
    expect(profileStatusLabel(false, "loading")).toBe("Setup needed");
  });
});

describe("the targets sheet", () => {
  const initial = {
    mode: "grams" as const, kcalTrain: 2200, kcalRest: 1900,
    grams: { proteinG: 140, fatG: 70, carbG: 220 },
    percent: { proteinPct: 25, fatPct: 30, carbPct: 45 },
  };
  const floors = { proteinG: 100, fatG: 40 } as never;

  it("disables Save while a save is in flight and announces a failure", () => {
    const markup = renderToStaticMarkup(
      <TargetModeSheet initial={initial} floors={floors} saving saveError="Couldn't save"
        onClose={() => {}} onSave={() => {}} />,
    );
    expect(markup).toMatch(/role="alert"[^>]*>Couldn&#x27;t save/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-status="pending"|<button[^>]*data-status="pending"[^>]*disabled=""/);
  });
});

describe("Add to Calendar", () => {
  it("downloads nothing when the share sheet is dismissed", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    vi.stubGlobal("navigator", { ...navigator, share: vi.fn().mockRejectedValue(abort), canShare: () => true });
    const before = window.location.href;
    render(<ScheduleSection shiftMinutes={0} slotTimes={{}} onShiftChange={() => {}} onSlotTimeChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to Calendar" }));
    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.href).toBe(before);
    expect(screen.queryByText(/Downloaded\./)).toBeNull();
  });
});
