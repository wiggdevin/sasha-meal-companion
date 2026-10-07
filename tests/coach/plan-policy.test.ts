// A plan never holds a food the account's rules block (GPT-6 Sol audit B1, 2026-10-04).
import { describe, expect, it } from "vitest";
import { PLAN_WRITE_KINDS, refusePlanBlocked } from "@/lib/coach/plan-policy";
import type { CoachAction } from "@/lib/coach/actions";

const base = { actionId: "a1", date: "2026-10-04", slot: "meal-2" };
const action = (kind: string, flagged: string[]) => ({ ...base, kind, flagged }) as unknown as CoachAction;

describe("refusePlanBlocked", () => {
  it("refuses a plan write that carries a blocked item, with the reason", () => {
    const out = refusePlanBlocked([action("set_slot_meal", ["Peanut butter"])]);
    expect(out.actions).toEqual([]);
    expect(out.refusals).toEqual([expect.stringContaining("Peanut butter")]);
  });

  it("keeps clean plan writes", () => {
    const clean = action("add_slot_item", []);
    expect(refusePlanBlocked([clean])).toEqual({ actions: [clean], refusals: [] });
  });

  it("never refuses a log: logging marks, it does not refuse (ruling 2026-09-14)", () => {
    const log = action("log_meal", ["Peanut butter"]);
    expect(refusePlanBlocked([log]).actions).toEqual([log]);
  });

  it("covers every action that writes a plan slot's food", () => {
    expect([...PLAN_WRITE_KINDS].sort()).toEqual(["add_slot_item", "set_slot_item", "set_slot_meal"]);
  });
});
