// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import GoalRateField, { goalChangePatch, rateClampCopy, rateLabel, rateSentence }
  from "@/components/GoalRateField";

const styles = { fieldClass: "well", labelClassName: "", captionClassName: "" };
afterEach(cleanup);

describe("GoalRateField (step D)", () => {
  it("offers the three presets for a loss goal and marks the default", () => {
    const onChange = vi.fn();
    render(<GoalRateField goal="lose_fat" value={-50} onChange={onChange} {...styles} />);
    const trigger = screen.getByRole("combobox", { name: "Goal rate" });
    expect(trigger.textContent).toContain(rateLabel("lose_fat", -50));
    fireEvent.click(trigger);
    for (const bp of [-25, -50, -75]) {
      expect(screen.getByRole("option", { name: rateLabel("lose_fat", bp) })).toBeTruthy();
    }
    expect(screen.queryByRole("option", { name: rateLabel("gain_muscle", 10) })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: rateLabel("lose_fat", -25) }));
    expect(onChange).toHaveBeenCalledWith(-25);
    expect(document.body.textContent).not.toMatch(/medical|safety limit/i);
  });

  it("asks an account that never confirmed a rate to choose one", () => {
    const markup = renderToStaticMarkup(
      <GoalRateField goal="lose_fat" value={null} onChange={vi.fn()} {...styles} />);
    expect(markup).toContain("Choose a rate");
    expect(markup).toContain("at maintenance until you choose");
    // Onboarding cannot continue without one, so it must not promise maintenance instead.
    const required = renderToStaticMarkup(
      <GoalRateField goal="lose_fat" value={null} onChange={vi.fn()} required {...styles} />);
    expect(required).toContain("Choose a rate to continue");
    expect(required).not.toContain("at maintenance until you choose");
  });

  it("renders no picker for maintain or recomp", () => {
    for (const goal of ["maintain", "recomp"] as const) {
      const markup = renderToStaticMarkup(
        <GoalRateField goal={goal} value={0} onChange={vi.fn()} {...styles} />);
      expect(markup).not.toContain('aria-label="Goal rate"');
    }
  });

  it("shows the clamp copy from the ruling when a limit set the number", () => {
    const capped = { tdeeKcal: 1873, kcalMin: 1430, targetKcal: 1498, bound: "rate_cap" as const,
      effectiveRatePctWeek: -0.4697 };
    expect(rateClampCopy(capped, -75)).toBe("−0.75%/week exceeds the plan limit. Using 20% below "
      + "your current TDEE: 1,498 kcal/day, about −0.47%/week.");
    expect(rateClampCopy({ ...capped, targetKcal: 2060, bound: "rate_cap",
      effectiveRatePctWeek: 0.2382 }, 25)).toBe("+0.25%/week exceeds the plan limit. Using 10% "
      + "above your current TDEE: 2,060 kcal/day, about +0.24%/week.");
    expect(rateClampCopy({ ...capped, targetKcal: 1430, bound: "kcal_min" }, -75))
      .toBe("Your selected rate would fall below your 1,430 kcal/day nutrition minimum. "
        + "Using 1,430 kcal/day; progress may be slower.");
    expect(rateClampCopy({ ...capped, targetKcal: 1673, bound: null }, -25)).toBeNull();
    const markup = renderToStaticMarkup(
      <GoalRateField goal="lose_fat" value={-75} onChange={vi.fn()} outcome={capped} {...styles} />);
    expect(markup).toContain("exceeds the plan limit");
  });

  it("names the pace by goal: +25 is the fast gain, −25 the slow loss", () => {
    expect(rateLabel("gain_muscle", 25)).toMatch(/^Fast/);
    expect(rateLabel("gain_muscle", 10)).toMatch(/^Slow/);
    expect(rateLabel("gain_muscle", 20)).toMatch(/^Steady .*recommended/);
    expect(rateLabel("lose_fat", -25)).toMatch(/^Slow/);
    expect(rateLabel("lose_fat", -75)).toMatch(/^Fast/);
  });

  it("describes the rate in plain words for the plan footer", () => {
    expect(rateSentence("lose_fat", -50)).toBe("losing 0.5% of body weight a week");
    expect(rateSentence("gain_muscle", 10)).toBe("gaining 0.1% of body weight a week");
    expect(rateSentence("recomp", 0)).toBe("at maintenance");
    expect(rateSentence("lose_fat", null)).toBe("at maintenance until you choose a rate");
  });

  it("gives a changed goal its default rate in the same write", () => {
    expect(goalChangePatch("gain_muscle")).toEqual({ goal: "gain_muscle", goalRateBpWeek: 20 });
    expect(goalChangePatch("recomp")).toEqual({ goal: "recomp", goalRateBpWeek: 0 });
    expect(goalChangePatch("")).toEqual({ goal: null, goalRateBpWeek: null });
  });
});
