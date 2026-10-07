/**
 * PR #248 review r4 #1 (sweep of lib/coach/apply-*.ts): a meal series and its Undo write one date
 * per await. Once the account changes, no further date is written — not the next one, and no
 * rollback — because `saveMealEdit` would file it under the account bound now.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";

const mocks = vi.hoisted(() => ({ saveMealEdit: vi.fn() }));
vi.mock("@/lib/plan-day-client", () => ({ saveMealEdit: mocks.saveMealEdit }));
vi.mock("@/lib/coach/apply-shared", async (orig) => ({
  ...(await orig<typeof import("@/lib/coach/apply-shared")>()),
  slotContext: () => ({ baseMealId: "breakfast", components: [], planned: [], previous: null }),
}));

import { applySetSlotMeal, undoSlot } from "@/lib/coach/apply-slot";
import type { CoachAction } from "@/lib/coach/actions";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATES = ["2026-09-16", "2026-09-17", "2026-09-18"];

const item = { name: "Chicken breast", grams: 150, kcalPer100g: 165, proteinPer100g: 31,
  carbsPer100g: 0, fatPer100g: 3.6, foodRefId: "ref-1", verdict: "allowed" };

beforeEach(() => {
  vi.clearAllMocks();
  unbindAccount();
  bindAccount(A);
});

describe("meal series across a switch", () => {
  it("writes no further date, and no rollback, once the account changes", async () => {
    mocks.saveMealEdit.mockImplementationOnce(async () => { bindAccount(B); })
      .mockResolvedValue(undefined);
    await expect(applySetSlotMeal({
      actionId: "a-series", kind: "set_slot_meal", from: DATES[0], dates: DATES,
      slot: "meal-1", title: "Chicken", items: [item], flagged: [],
    } as unknown as Extract<CoachAction, { kind: "set_slot_meal" }>))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(mocks.saveMealEdit).toHaveBeenCalledTimes(1);
  });

  it("an Undo restores no further date once the account changes", async () => {
    mocks.saveMealEdit.mockImplementationOnce(async () => { bindAccount(B); })
      .mockResolvedValue(undefined);
    const dates = DATES.map((date) => ({ date, slot: "meal-1" as const, baseMealId: null,
      planned: [], previous: null }));
    await expect(undoSlot({ kind: "set_slot_meal", dates })).rejects.toBeInstanceOf(AccountChanged);
    expect(mocks.saveMealEdit).toHaveBeenCalledTimes(1);
  });
});
