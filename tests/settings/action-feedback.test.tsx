// @vitest-environment jsdom
/**
 * FluidVoice F01-F09: Settings writes use the shared ActionFeedback. A saved change glows on its
 * card with the shared haptic; a failed one shows the shared alert, keeps what was typed and plays
 * no success haptic. Two quick edits are two writes, and each reports its own outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import TargetsSection from "@/components/settings/TargetsSection";
import { defaultSettings } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";

const settings = { ...defaultSettings(), heightCm: 165, heightUnit: "ft_in" as const, weightKg: 60,
  weightUnit: "lb" as const, birthYear: 1996, sex: "female" as const, activityLevel: "moderate" as const,
  goal: "recomp" as const, trainingWeekdays: [1, 3] };
const FAILED = "Couldn't save that change — try again when you have a connection.";
const vibrate = vi.fn(() => true);

beforeEach(() => {
  vibrate.mockClear();
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
});
afterEach(cleanup);

/** The body fields left Settings (owner, 2026-10-05: Edit profile edits them); a training day
 *  toggle is the write these tests drive now. */
function renderTargets(onProfileChange: (patch: object) => void | Promise<unknown>) {
  return render(<TargetsSection settings={settings} onProfileChange={onProfileChange}>{null}</TargetsSection>);
}
function toggleFriday() {
  fireEvent.click(screen.getByRole("button", { name: "Training day Friday" }));
}

describe("Settings profile writes", () => {
  it("glows the card and plays the shared haptic once the write lands", async () => {
    const onChange = vi.fn(async () => {});
    const { container } = renderTargets(onChange);
    await act(async () => { toggleFriday(); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ trainingWeekdays: [1, 3, 5] });
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-feedback-state="success"]')).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the shared alert on failure and plays no success haptic", async () => {
    const onChange = vi.fn(async () => { throw new Error("offline"); });
    renderTargets(onChange);
    await act(async () => { toggleFriday(); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(FAILED);
    expect(alert.querySelector('button[aria-label="Dismiss notification"]')).toBeTruthy();
    expect(vibrate).not.toHaveBeenCalled();
  });
});

describe("Settings goal writes", () => {
  it("sends two quick edits and reports a failure in the second", async () => {
    let finishFirst!: () => void;
    const onProfileChange = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(async () => { throw new Error("offline"); });
    render(<TargetsSection settings={settings} onProfileChange={onProfileChange}>{null}</TargetsSection>);
    const monday = screen.getByRole("button", { name: "Training day Monday" });
    expect(monday.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Training day Friday" }));
    fireEvent.click(screen.getByRole("button", { name: "Training day Sunday" }));
    expect(onProfileChange).toHaveBeenCalledTimes(2);
    await act(async () => { finishFirst(); });
    await act(async () => {});
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain(FAILED);
  });
});

describe("Settings write safety", () => {
  it("handles a rejection at once, even while it waits behind an earlier write", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let finishFirst!: () => void;
      // A plain function: a vi.fn spy attaches its own handler to the promise it returns.
      let calls = 0;
      const onProfileChange = () => (calls += 1) === 1
        ? new Promise<void>((resolve) => { finishFirst = resolve; })
        : Promise.reject(new Error("offline"));
      render(<TargetsSection settings={settings} onProfileChange={onProfileChange}>{null}</TargetsSection>);
      fireEvent.click(screen.getByRole("button", { name: "Training day Friday" }));
      fireEvent.click(screen.getByRole("button", { name: "Training day Sunday" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      await act(async () => { finishFirst(); });
      await act(async () => {});
      expect(screen.getByRole("alert").textContent).toContain(FAILED);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("settles quietly when the account changed before the write landed", async () => {
    await resetTestAccount();
    let finish!: () => void;
    const onChange = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { container } = renderTargets(onChange);
    toggleFriday();
    await resetTestAccount("22222222-2222-4222-8222-222222222222");
    await act(async () => { finish(); });
    await act(async () => {});
    expect(vibrate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-feedback-state="success"]')).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
