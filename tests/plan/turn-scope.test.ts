import { describe, expect, it } from "vitest";
import { planTurnFields } from "@/components/plan/turn-scope";

describe("planTurnFields", () => {
  const at = new Date("2026-10-04T15:20:00Z");

  it("scopes a card turn to its slot and viewed date with the real clock", () => {
    expect(planTurnFields("meal-2", "2026-10-06", true, "scope", at)).toEqual({
      scope: { kind: "component", slotId: "meal-2", date: "2026-10-06" }, now: at.toISOString(),
    });
    // A non-meal slot is scoped too: the component scope accepts every slot id.
    expect(planTurnFields("coffee", "2026-10-06", false, "scope", at)).toEqual({
      scope: { kind: "component", slotId: "coffee", date: "2026-10-06" }, now: at.toISOString(),
    });
  });

  it("keeps the older Plan-sheet fields behind the legacy switch, never beside a scope", () => {
    const opening = planTurnFields("meal-2", "2026-10-06", true, "legacy", at);
    expect(opening).toEqual({ surface: "plan", planningSlot: "meal-2",
      now: new Date("2026-10-06T12:00:00").toISOString() });
    expect(planTurnFields("meal-2", "2026-10-06", false, "legacy", at)).toMatchObject({ planSlot: "meal-2" });
    expect(opening).not.toHaveProperty("scope");
  });
});
