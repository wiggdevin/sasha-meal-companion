// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CaloriesCard from "@/components/settings/CaloriesCard";
import ProteinLockCard from "@/components/settings/ProteinLockCard";
import ScheduleSection from "@/components/settings/ScheduleSection";

afterEach(cleanup);

describe("Settings input wells", () => {
  it("keeps every schedule time input visible and tied to its visible label", () => {
    const { container } = render(
      <ScheduleSection shiftMinutes={0} slotTimes={{}}
        onShiftChange={() => {}} onSlotTimeChange={() => {}} />,
    );

    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="time"]')];
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      expect(input.className).toContain("well");
      expect(input.labels).toHaveLength(1);
      expect(input.labels?.[0]?.textContent?.trim()).not.toBe("");
    }
  });

  it("puts target and day-shift steppers in labeled inset wells", () => {
    render(
      <>
        <CaloriesCard trainingKcal={2200} restKcal={1750}
          trainingCaption={null} restCaption={null} trainingAlert={null} restAlert={null}
          onTrainingChange={() => {}} onRestChange={() => {}} />
        <ProteinLockCard proteinLocked={false} proteinG={135} proteinCaption={null}
          onToggleLock={() => {}} onProteinChange={() => {}} />
        <ScheduleSection shiftMinutes={0} slotTimes={{}}
          onShiftChange={() => {}} onSlotTimeChange={() => {}} />
      </>,
    );

    for (const label of ["Training day", "Rest day", "Protein"]) {
      const control = screen.getByRole("button", { name: `Increase ${label}` });
      expect(control.closest(".well")?.textContent).toContain(label);
    }
    const shift = screen.getByRole("group", { name: "Shift the whole day" });
    expect(shift.className).toContain("well");
  });

  it("passes a chosen meal count from the labeled stepper", () => {
    const onMealsPerDayChange = vi.fn();
    render(<ScheduleSection shiftMinutes={0} slotTimes={{}} mealsPerDay={4}
      onMealsPerDayChange={onMealsPerDayChange}
      onShiftChange={() => {}} onSlotTimeChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "More meals" }));
    fireEvent.click(screen.getByRole("button", { name: "Fewer meals" }));
    expect(onMealsPerDayChange.mock.calls).toEqual([[5], [3]]);
  });
});
