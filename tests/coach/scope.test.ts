// Scoped AI input (lib/coach/scope.ts): the request field, the allowed actions per scope, the
// slot/date pin of a meal card, the viewed date, the thread kind and the transcript guidance.
import { describe, expect, it } from "vitest";
import {
  actionsInScope, allowedKinds, scopeDate, scopeGuidance, scopeSlot,
} from "@/lib/coach/scope";
import { coachTurnRequestSchema, threadKindFor, type CoachScope } from "@/lib/coach/types";
import { accountClock } from "@/lib/server/day-context";
import { planSlotOf } from "@/lib/server/coach-turn/plan-slot";

const base = { threadId: null, messageId: "00000000-0000-4000-8000-000000000001", text: "hi" };
const card: CoachScope = { kind: "component", slotId: "meal-2", date: "2026-10-04" };
const today: CoachScope = { kind: "page", page: "today", date: "2026-10-04" };

describe("the scope request field", () => {
  it("accepts every scope kind and keeps an absent scope absent", () => {
    for (const scope of [card, today, { kind: "page", page: "foods" }, { kind: "global" }]) {
      expect(coachTurnRequestSchema.safeParse({ ...base, scope }).success).toBe(true);
    }
    expect(coachTurnRequestSchema.parse(base)).not.toHaveProperty("scope");
  });

  it("rejects unknown pages, slots, dates and extra keys", () => {
    for (const scope of [{ kind: "page", page: "activity" }, { kind: "component", slotId: "meal-9",
      date: "2026-10-04" }, { kind: "component", slotId: "meal-1", date: "Oct 4" },
    { kind: "global", page: "today" }]) {
      expect(coachTurnRequestSchema.safeParse({ ...base, scope }).success).toBe(false);
    }
  });

  it("never combines with the Plan sheet or recipe-widget narrowing", () => {
    expect(coachTurnRequestSchema.safeParse({ ...base, scope: today, surface: "plan" }).success)
      .toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, scope: card, planSlot: "meal-2" }).success)
      .toBe(false);
  });

  it("lets page and global turns cite saved chats; a meal card cannot", () => {
    const history = { historySourceThreadId: "00000000-0000-4000-8000-000000000002" };
    expect(coachTurnRequestSchema.safeParse({ ...base, ...history, scope: today }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, ...history, scope: { kind: "global" } })
      .success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, ...history, scope: card }).success).toBe(false);
  });
});

describe("allowed actions", () => {
  it("global or no scope allows everything", () => {
    expect(allowedKinds(undefined)).toBeNull();
    expect(allowedKinds({ kind: "global" })).toBeNull();
  });

  it("each page owns its own actions", () => {
    expect(allowedKinds({ kind: "page", page: "foods" })?.has("add_to_avoid")).toBe(true);
    expect(allowedKinds({ kind: "page", page: "foods" })?.has("log_meal")).toBe(false);
    expect(allowedKinds({ kind: "page", page: "body" })?.has("log_weight")).toBe(true);
    expect(allowedKinds({ kind: "page", page: "settings" })?.has("set_targets")).toBe(true);
    expect(allowedKinds(today)?.has("log_water")).toBe(true);
    expect(allowedKinds(today)?.has("update_profile")).toBe(false);
  });

  it("a meal card runs only its own slot's actions on its own date", () => {
    const actions = [
      { kind: "set_slot_item", slot: "meal-2", date: "2026-10-04" },
      { kind: "set_slot_item", slot: "meal-3", date: "2026-10-04" },
      { kind: "set_slot_item", slot: "meal-2", date: "2026-10-05" },
      { kind: "set_slot_meal", slot: "meal-2", date: "2026-10-04", from: "2026-10-04",
        through: "2026-10-10" },
      { kind: "log_water", cups: 2 },
      { kind: "log_meal", slot: "meal-2", date: "2026-10-04" },
    ] as const;
    expect(actionsInScope(actions, card).map((a) => `${a.kind}:${"slot" in a ? a.slot : ""}`))
      .toEqual(["set_slot_item:meal-2", "log_meal:meal-2"]);
    expect(actionsInScope(actions, undefined)).toHaveLength(actions.length);
  });
});

describe("date, slot, thread kind and guidance", () => {
  it("the scope's date becomes the turn's day; the clock stays real", () => {
    const req = { ...base, now: "2026-10-06T15:00:00Z", tz: "UTC", scope: card };
    expect(accountClock(req, 0)).toEqual({ now: "2026-10-06T15:00:00.000Z", tz: "UTC",
      date: "2026-10-04" });
    expect(accountClock({ ...req, scope: { kind: "global" } }, 0).date).toBe("2026-10-06");
    expect(scopeDate({ kind: "page", page: "foods" })).toBeNull();
  });

  it("a meal card pins its slot and keeps its turns out of the chat list", () => {
    expect(scopeSlot(card)).toBe("meal-2");
    expect(planSlotOf({ ...base, scope: card })).toBe("meal-2");
    expect(planSlotOf({ ...base, scope: today })).toBeNull();
    expect(threadKindFor(undefined, card)).toBe("plan");
    expect(threadKindFor(undefined, today)).toBe("chat");
    expect(threadKindFor(undefined, undefined)).toBe("chat");
  });

  it("guidance names the scope; global adds nothing", () => {
    expect(scopeGuidance(undefined)).toEqual([]);
    expect(scopeGuidance({ kind: "global" })).toEqual([]);
    expect(scopeGuidance(card)[0]).toContain("meal-2 meal card for 2026-10-04");
    expect(scopeGuidance({ kind: "page", page: "foods" })[0]).toContain("Foods");
  });
});
