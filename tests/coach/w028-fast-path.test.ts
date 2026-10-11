/**
 * W028 (audit 2026-10-10 F16): the Jev fast path uses the day the user stated and the whole amount,
 * a compound food phrase never becomes one arbitrary mark, and zero placeholders never become
 * Sunday training days.
 */
import { describe, expect, it } from "vitest";
import { actionSpecFor, coachActionWireSchema } from "@/lib/coach/actions";
import { extractNumbers, isFastPathEligible, type ClassifiedIntentResult } from "@/lib/coach/intent";
import { addLocalDays, foodArgs, statedDay } from "@/lib/coach/intent-args";
import { fastPathAction } from "@/lib/server/coach-turn/fast-path-copy";
import { foodMentions } from "@/lib/server/coach-turn/intent";

const TODAY = "2026-09-19";
const raw = {
  direction: { choice: "later" as const, confidence: 0.98 },
  scope: { choice: "remaining" as const, confidence: 0.96 },
};

/** The classified result the pre-pass builds for one message, through the kind's own reader. */
function classified(intent: "log_water" | "log_weight" | "shift_schedule", message: string) {
  const read = actionSpecFor(intent)!.intent!.extract({
    numbers: extractNumbers(message), raw, message,
  });
  return { intent, confidence: 0.97, args: read.args, argConfidence: read.argConfidence,
    raw } as unknown as ClassifiedIntentResult;
}

describe("compound amounts parse whole (A029)", () => {
  it.each([
    ["log 1 1/2 cups of water", [{ value: 1.5, unit: "cup", raw: "1 1/2 cups" }]],
    ["log 1/2 cup of water", [{ value: 0.5, unit: "cup", raw: "1/2 cup" }]],
    ["drink half a cup", [{ value: 0.5, unit: "cup", raw: "half a cup" }]],
    ["a cup and a half of water", [{ value: 1.5, unit: "cup", raw: "a cup and a half" }]],
    ["2 and a half cups", [{ value: 2.5, unit: "cup", raw: "2 and a half cups" }]],
    ["push my meals back an hour and a half", [{ value: 1.5, unit: "hour", raw: "an hour and a half" }]],
    ["move meals 1 hour 30 minutes later", [{ value: 90, unit: "min", raw: "1 hour 30 minutes" }]],
    ["move meals an hour and 15 min later", [{ value: 75, unit: "min", raw: "an hour and 15 min" }]],
    ["half an hour later", [{ value: 30, unit: "min", raw: "half an hour" }]],
    ["drink 250 ml then 2 cups", [{ value: 250, unit: "ml", raw: "250 ml" },
      { value: 2, unit: "cup", raw: "2 cups" }]],
  ] as const)("reads %s", (message, expected) => {
    expect(extractNumbers(message)).toEqual(expected);
  });

  it("shifts by the whole 90 minutes, not the first part", () => {
    const result = classified("shift_schedule", "push my meals back an hour and a half");
    expect(isFastPathEligible(result)).toBe(true);
    expect(fastPathAction(result, TODAY)).toMatchObject({ minutes: 90, date: TODAY });
    expect(fastPathAction(classified("shift_schedule", "move meals 1 hour 30 minutes later"), TODAY))
      .toMatchObject({ minutes: 90 });
  });

  it("logs 1 1/2 cups as 360 ml", () => {
    const result = classified("log_water", "log 1 1/2 cups of water");
    expect(fastPathAction(result, TODAY)).toEqual({ kind: "log_water", ml: 360 });
  });
});

describe("a stated day (A024)", () => {
  it.each([
    ["I drank 3 cups of water", "today"],
    ["I drank 3 cups of water today", "today"],
    ["I drank 3 cups of water yesterday", { offset: -1 }],
    ["3 cups last night", { offset: -1 }],
    ["move my meals 30 minutes later tomorrow", { offset: 1 }],
    ["I weighed 128 lb on Friday", "other"],
    ["I weighed 128 lb 3 days ago", "other"],
    ["log 2 cups on 2026-09-01", "other"],
    ["log 2 cups on Sept 3", "other"],
    ["2 cups yesterday and 1 today", "other"],
    ["log 1/2 cup of water", "today"],
  ] as const)("reads %s", (message, expected) => {
    expect(statedDay(message)).toEqual(expected);
  });

  it("moves a date by calendar days across a month", () => {
    expect(addLocalDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("logs yesterday's water on yesterday", () => {
    const result = classified("log_water", "I drank 3 cups of water yesterday");
    expect(isFastPathEligible(result)).toBe(true);
    expect(fastPathAction(result, TODAY)).toEqual({ kind: "log_water", ml: 720, date: "2026-09-18" });
  });

  it("logs yesterday's weigh-in on yesterday", () => {
    const result = classified("log_weight", "I weighed 58 kg yesterday");
    expect(fastPathAction(result, TODAY)).toEqual({ kind: "log_weight", kg: 58, date: "2026-09-18" });
  });

  it("shifts tomorrow's meals, not today's", () => {
    const result = classified("shift_schedule", "move my meals 30 minutes later tomorrow");
    expect(fastPathAction(result, TODAY)).toMatchObject({ date: "2026-09-20", minutes: 30 });
  });

  it.each([
    ["log_water", "I drank 3 cups of water on Monday"],
    ["log_water", "I'll drink 3 cups of water tomorrow"],
    ["log_weight", "I weighed 128 lb 2 days ago"],
    ["shift_schedule", "move yesterday's meals 30 minutes later"],
    ["shift_schedule", "move my meals 30 minutes later on Saturday"],
  ] as const)("leaves %s '%s' to the model turn", (intent, message) => {
    const result = classified(intent, message);
    expect(result.args.missing).toContain("date");
    expect(isFastPathEligible(result)).toBe(false);
  });

  it("keeps an undated message on today, as before", () => {
    expect(fastPathAction(classified("log_water", "log 2 cups of water"), TODAY))
      .toEqual({ kind: "log_water", ml: 480 });
    expect(fastPathAction(classified("shift_schedule", "move my meals 30 minutes later"), TODAY))
      .toMatchObject({ date: TODAY });
  });
});

describe("a compound food phrase is never one mark (A027)", () => {
  it("names one food per list clause", () => {
    expect(foodMentions("add peanuts to my avoid list, and take pork off my eats list"))
      .toEqual(["peanuts", "pork"]);
    expect(foodMentions("add peanuts and shellfish to my avoid list"))
      .toEqual(["peanuts and shellfish"]);
    expect(foodMentions("add salmon back to my eats")).toEqual(["salmon"]);
  });

  it.each([
    [["peanuts and shellfish"]], [["eggs, milk"]], [["beans & rice"]], [["peanuts", "pork"]],
  ])("leaves %j to the model turn", (names) => {
    expect(foodArgs(names)).toEqual({ missing: ["name"] });
  });

  it("still fast-paths one plain food", () => {
    expect(foodArgs(["peanuts"])).toEqual({ name: "peanuts" });
  });
});

describe("zero placeholders are not Sunday (A160)", () => {
  const parse = (numericArgs: number[], stringArgs: string[] = []) =>
    coachActionWireSchema.safeParse({ kind: "update_profile", numericArgs, stringArgs });

  it("a goal-only update padded with zeros sets no training days", () => {
    const parsed = parse([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ["", "", "maintain"]);
    expect(parsed.success && parsed.data).toEqual({ kind: "update_profile", goal: "maintain" });
  });

  it("a single padding zero beside a named field sets no training days", () => {
    const parsed = parse([0, 0, 1990, 0, 0]);
    expect(parsed.success && parsed.data).toEqual({ kind: "update_profile", birthYear: 1990 });
  });

  it("repeated zeros among weekdays are padding; real weekdays stay", () => {
    const parsed = parse([0, 0, 0, 0, 1, 3, 5, 0, 0, 0]);
    expect(parsed.success && parsed.data).toEqual({ kind: "update_profile",
      trainingWeekdays: [1, 3, 5] });
  });

  it("Sunday among other weekdays, or alone, is still Sunday", () => {
    expect(parse([0, 0, 0, 0, 0, 3]).success && parse([0, 0, 0, 0, 0, 3]).data)
      .toEqual({ kind: "update_profile", trainingWeekdays: [0, 3] });
    expect(parse([0, 0, 0, 0, 0]).success && parse([0, 0, 0, 0, 0]).data)
      .toEqual({ kind: "update_profile", trainingWeekdays: [0] });
  });
});
