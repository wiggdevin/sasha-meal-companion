/**
 * W142: the day_completeness purpose carries counts and clock hours only, and the nudge is advisory.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CALL_REGISTRY } from "@/lib/ai/call-registry";
import { dayCompletenessPayload, jevProvenance } from "@/lib/ai/payloads";
import {
  DAY_COMPLETENESS_THRESHOLD, dayCompletenessState, type DayCompletenessState,
} from "@/lib/day-completeness";
import { judgeDayCompleteness } from "@/lib/server/day-completeness";
import type { StoredDay } from "@/lib/types";

const STATE: DayCompletenessState = {
  isToday: true, localHour: 21, mealsEaten: 1, entryCount: 0, lastEntryHour: 8,
};

describe("day_completeness payload", () => {
  it("is a registered Jev D1 purpose with its own builder", () => {
    expect(CALL_REGISTRY.day_completeness).toEqual(
      { provider: "typesafe", dataClass: "D1", builder: "dayCompletenessPayload" });
    expect(jevProvenance(dayCompletenessPayload(STATE))).toBe("day_completeness");
  });

  it("holds only counts and hours: a smuggled name, note or health field never reaches it", () => {
    const smuggled = { ...STATE, name: "Oats", note: "hurt on 9/12", conditions: ["crohn's"], weightLb: 150 };
    const payload = dayCompletenessPayload(smuggled);
    expect(payload.state).toEqual({ day: {
      isToday: true, localHour: 21, mealsEaten: 1, entryCount: 0, lastEntryHour: 8 } });
    const body = JSON.stringify(payload);
    for (const leaked of ["Oats", "hurt on", "crohn", "150"]) expect(body).not.toContain(leaked);
    expect(Object.keys(payload.questions)).toEqual(["day_incomplete"]);
  });

  it("derives its state from the stored day without any food name", () => {
    const day: StoredDay = {
      date: "2026-10-04",
      eaten: { "meal-1": "2026-10-04T08:10:00" },
      extras: [{ id: "a", name: "Secret snack", at: "2026-10-04T19:05:00" } as never,
        { id: "b", name: "Other", at: "2026-10-04T12:00:00" } as never],
    };
    const now = new Date("2026-10-04T21:30:00");
    const state = dayCompletenessState(day, "2026-10-04", "2026-10-04", now);
    expect(state).toEqual({ isToday: true, localHour: 21, mealsEaten: 1, entryCount: 2, lastEntryHour: 19 });
    expect(JSON.stringify(state)).not.toContain("Secret");
    expect(dayCompletenessState(day, "2026-10-03", "2026-10-04", now).localHour).toBeNull();
  });
});

describe("judgeDayCompleteness", () => {
  const answering = (noul: number) => vi.fn().mockResolvedValue({ day_incomplete: { type: "noul", noul } });

  it("nudges only above the 0.80 threshold", async () => {
    expect(DAY_COMPLETENESS_THRESHOLD).toBe(0.8);
    expect(await judgeDayCompleteness(STATE, "u1", answering(0.81))).toBe(true);
    expect(await judgeDayCompleteness(STATE, "u1", answering(0.8))).toBe(false);
    expect(await judgeDayCompleteness(STATE, "u1", answering(0.2))).toBe(false);
  });

  it("shows nothing on a Jev error, a null answer or a malformed one", async () => {
    expect(await judgeDayCompleteness(STATE, "u1", vi.fn().mockRejectedValue(new Error("down")))).toBe(false);
    expect(await judgeDayCompleteness(STATE, "u1", vi.fn().mockResolvedValue(null))).toBe(false);
    expect(await judgeDayCompleteness(STATE, "u1",
      vi.fn().mockResolvedValue({ day_incomplete: { type: "noul", noul: Number.NaN } }))).toBe(false);
  });
});
