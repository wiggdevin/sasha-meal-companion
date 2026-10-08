// @vitest-environment jsdom
/**
 * Onboarding v2 question-set beats, each on its own (QUESTION-SET-v2.md §1b–§4): the week and the
 * inferred activity chip, the tap-only safety round, the pace chips in lb a week after the clamp,
 * "Your day" pre-filled with the US chip on, and the under-18 stop.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WeekBeat from "./WeekBeat";
import SafetyRound from "./SafetyRound";
import PaceBeat from "./PaceBeat";
import YourDayBeat from "./YourDayBeat";
import MinorStop from "./MinorStop";
import { paceChoices, type PaceChoices } from "@/lib/profile/pace";

vi.mock("@/components/Onboarding/DietaryProfilePicker", () => ({
  default: () => <div data-testid="rule-editor" />,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const TODAY = new Date("2026-10-08T12:00:00.000Z");
function paceFor(profile: { sex: "female" | "male"; age: number; heightCm: number; weightLb: number;
  goal: "lose_fat" | "gain_muscle" }): PaceChoices {
  return paceChoices({
    profile: { sex: profile.sex, birthYear: 2026 - profile.age, heightCm: profile.heightCm,
      weightKg: profile.weightLb / 2.2046226218, activityLevel: "sedentary", goal: profile.goal },
    today: TODAY, trainingDays: 0,
  });
}

describe("WeekBeat", () => {
  it("shows the inferred activity as a chip before Next, and the person can change it", () => {
    const onDone = vi.fn();
    render(<WeekBeat initial={null} onDone={onDone} />);
    expect(screen.queryByTestId("activity-chip")).toBeNull();
    for (const day of ["Mon", "Wed", "Fri"]) fireEvent.click(screen.getByRole("button", { name: day }));
    fireEvent.click(screen.getByRole("radio", { name: "Mostly sitting" }));
    expect(screen.getByTestId("activity-chip").textContent).toMatch(/Activity: Light/);
    fireEvent.click(screen.getByRole("button", { name: "Change activity" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Activity level" }))
      .getByRole("radio", { name: "Moderate" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onDone).toHaveBeenCalledWith({ trainingWeekdays: [1, 3, 5], noWorkouts: false,
      dailyMovement: "mostly_sitting", activityOverride: "moderate", skipped: false });
  });

  it("skips with a named default: no workout days, sedentary", () => {
    const onDone = vi.fn();
    render(<WeekBeat initial={null} onDone={onDone} />);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Skip this" }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ skipped: true, trainingWeekdays: [] }));
  });
});

describe("SafetyRound", () => {
  it("'No, none of these' finishes the round in one tap", () => {
    const onDone = vi.fn();
    render(<SafetyRound initial={null} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "No, none of these" }));
    expect(onDone).toHaveBeenCalledWith({ picks: [], pregnancy: null, medicines: [], conditionText: "",
      rulesEdited: false });
  });

  it("offers pregnancy to every adult and needs one of its follow-ups before Continue", () => {
    const onDone = vi.fn();
    render(<SafetyRound initial={null} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Pregnant or breastfeeding" }));
    const next = screen.getByRole("button", { name: "Continue" });
    expect(next.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Pregnant" }));
    screen.getByText(/Your clinician's advice comes first/);
    fireEvent.click(next);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ picks: ["pregnancy"], pregnancy: "pregnant" }));
  });

  it("asks which medicine in plain names, says doses are not changed, and opens the rule editor", () => {
    const onDone = vi.fn();
    render(<SafetyRound initial={null} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Medicine that affects food" }));
    fireEvent.click(screen.getByRole("button", { name: /GLP-1 \(like Ozempic/ }));
    screen.getByText(/does not change doses or timing/);
    fireEvent.click(screen.getByRole("button", { name: "Add food rules" }));
    screen.getByTestId("rule-editor");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ medicines: ["glp1"], rulesEdited: true }));
  });

  it("keeps the optional condition text local and says the plan does not change for it", () => {
    const onDone = vi.fn();
    render(<SafetyRound initial={null} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "A health condition" }));
    fireEvent.change(screen.getByLabelText(/Want to name it/), { target: { value: "kidney disease" } });
    screen.getByText(/doesn’t change your plan for health conditions yet/);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ conditionText: "kidney disease" }));
  });
});

describe("PaceBeat", () => {
  const steadyCase = paceFor({ sex: "male", age: 40, heightCm: 177.8, weightLb: 200, goal: "lose_fat" });

  it("offers 1–3 chips in lb a week after the clamp, with Steady pre-selected", () => {
    if (steadyCase.kind !== "choices") throw new Error("expected choices");
    const onDone = vi.fn();
    render(<PaceBeat pace={steadyCase} goal="lose_fat" currentLb={200} heightCm={177.8} today="2026-10-08"
      insulin={false} initialBp={null} initialGoalLb={null} onDone={onDone} />);
    const chips = within(screen.getByRole("radiogroup", { name: "Pace" })).getAllByRole("radio");
    expect(chips.length).toBeGreaterThanOrEqual(1);
    expect(chips.length).toBeLessThanOrEqual(3);
    for (const chip of chips) expect(chip.textContent).toMatch(/lb a week/);
    const checked = chips.find((chip) => chip.getAttribute("aria-checked") === "true");
    expect(checked?.textContent).toMatch(/^Steady/);
    fireEvent.click(screen.getByRole("button", { name: "Use Steady" }));
    expect(onDone).toHaveBeenCalledWith({ bp: -50, goalWeightLb: null });
  });

  it("shows 'about Month YYYY' only when the pace moves toward the goal weight", () => {
    if (steadyCase.kind !== "choices") throw new Error("expected choices");
    render(<PaceBeat pace={steadyCase} goal="lose_fat" currentLb={200} heightCm={177.8} today="2026-10-08"
      insulin={false} initialBp={null} initialGoalLb={null} onDone={vi.fn()} />);
    const field = screen.getByLabelText(/goal weight/);
    fireEvent.change(field, { target: { value: "185" } });
    screen.getByText(/you’d reach 185 lb about [A-Z][a-z]+ 20\d\d\./);
    fireEvent.change(field, { target: { value: "220" } });
    expect(screen.queryByText(/you’d reach/)).toBeNull();
    screen.getByText(/That goal is above your weight now/);
  });

  it("pre-selects Gentle with the referral line for insulin or a sulfonylurea on a loss goal", () => {
    if (steadyCase.kind !== "choices") throw new Error("expected choices");
    render(<PaceBeat pace={steadyCase} goal="lose_fat" currentLb={200} heightCm={177.8} today="2026-10-08"
      insulin initialBp={null} initialGoalLb={null} onDone={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /^Gentle/ }).getAttribute("aria-checked")).toBe("true");
    screen.getByText(/check with your clinician before eating less/);
  });

  it("the direction guard shows no chips and no date: the plan holds the minimum", () => {
    const minimum = paceFor({ sex: "female", age: 60, heightCm: 152.4, weightLb: 100, goal: "lose_fat" });
    expect(minimum.kind).toBe("minimum");
    if (minimum.kind !== "minimum") return;
    const onDone = vi.fn();
    render(<PaceBeat pace={minimum} goal="lose_fat" currentLb={100} heightCm={152.4} today="2026-10-08"
      insulin={false} initialBp={null} initialGoalLb={null} onDone={onDone} />);
    expect(screen.queryByRole("radiogroup", { name: "Pace" })).toBeNull();
    expect(screen.queryByLabelText(/goal weight/)).toBeNull();
    screen.getByText(/stays at your nutrition minimum/);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onDone).toHaveBeenCalledWith({ bp: minimum.storeBp, goalWeightLb: null });
  });
});

describe("YourDayBeat", () => {
  it("is pre-filled with the plan's own meals and times, the US chip on, one tap accepts", () => {
    const onDone = vi.fn();
    render(<YourDayBeat derivedCount={3} initial={null} onDone={onDone} />);
    screen.getByText("3 meals: 8:00 AM, 12:30 PM, 6:30 PM. Looks right?");
    expect(screen.getByRole("button", { name: "I’m in the U.S." }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Looks right" }));
    expect(onDone).toHaveBeenCalledWith({ mealsPerDay: null, firstMealTime: null, inUs: true });
  });

  it("moves every time with the first meal and lets the person switch the US chip off", () => {
    const onDone = vi.fn();
    render(<YourDayBeat derivedCount={3} initial={null} onDone={onDone} />);
    fireEvent.click(screen.getByRole("radio", { name: "4" }));
    fireEvent.click(screen.getByRole("radio", { name: "7:30 AM" }));
    screen.getByText("4 meals: 7:30 AM, 11:00 AM, 2:30 PM, 6:00 PM. Looks right?");
    fireEvent.click(screen.getByRole("button", { name: "I’m in the U.S." }));
    fireEvent.click(screen.getByRole("button", { name: "Looks right" }));
    expect(onDone).toHaveBeenCalledWith({ mealsPerDay: 4, firstMealTime: "07:30", inUs: false });
  });
});

describe("MinorStop", () => {
  it("says plans are for adults and offers a way to look around", () => {
    const onBrowse = vi.fn();
    render(<MinorStop onBrowse={onBrowse} onChangeAge={vi.fn()} />);
    screen.getByText(/plans are built for adults 18 and over/);
    fireEvent.click(screen.getByRole("button", { name: "Look around" }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });
});
