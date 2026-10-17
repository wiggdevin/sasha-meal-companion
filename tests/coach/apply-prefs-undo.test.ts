// @vitest-environment jsdom
/**
 * AI audit 2026-10-01: Undo on an Eats/Avoid card puts back the status from before THAT action.
 * When the food has been marked again since (a newer card, or the Foods tab), the newer mark wins
 * and Undo must not clobber it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({
  set: vi.fn(async (_name: string, _status: unknown, _opts?: unknown) => null),
  membership: vi.fn((_userId: string, _name: string): unknown => undefined),
}));
vi.mock("@/lib/foods/prefs-client", () => ({
  currentPrefStatus: async () => null,
  setFoodMembership: (name: string, status: unknown, opts?: unknown) => prefs.set(name, status, opts),
  reserveFoodMembershipIntent: () => ({}),
  raiseFoodMembershipIntent: (intent: unknown) => intent,
  readServerMembershipRev: async () => null,
  isLatestFoodMembershipIntent: () => true,
  saveFoodNoteForRef: vi.fn(async () => undefined),
  readFoodMembership: (userId: string, name: string) => prefs.membership(userId, name),
}));

import { undoFoodListMark } from "@/lib/coach/apply-prefs";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { defaultStore, saveStore } from "@/lib/store";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const avoidOats = { kind: "add_to_avoid" as const, foodRefId: "ref-oats", localId: null,
  name: "Oats", previous: null, refs: [{ refId: "ref-oats", previous: null }] };

beforeEach(() => {
  localStorage.clear();
  prefs.set.mockClear();
  prefs.membership.mockReset().mockReturnValue(undefined);
  unbindAccount();
  bindAccount(A);
  saveStore(defaultStore());
});

describe("undoFoodListMark against a newer mark", () => {
  it("leaves a newer Eats mark alone when undoing an earlier Avoid", async () => {
    prefs.membership.mockReturnValue({ status: "eats", note: null, rev: 9 });
    await expect(undoFoodListMark(avoidOats)).rejects.toThrow(/changed since/i);
    expect(prefs.set).not.toHaveBeenCalled();
  });

  it("puts back the earlier status while the food still holds this action's mark", async () => {
    prefs.membership.mockReturnValue({ status: "avoid", note: null, rev: 9 });
    await undoFoodListMark(avoidOats);
    expect(prefs.set).toHaveBeenCalledWith("Oats", null, expect.anything());
  });

  it("leaves a newer re-add alone when undoing an earlier removal", async () => {
    prefs.membership.mockReturnValue({ status: "avoid", note: null, rev: 9 });
    await expect(undoFoodListMark({ ...avoidOats, kind: "remove_from_avoid",
      previous: { status: "avoid", note: null } })).rejects.toThrow(/changed since/i);
    expect(prefs.set).not.toHaveBeenCalled();
  });

  it("leaves Avoid → Eats → Avoid since alone: same status, later revision (review t4r10 #7)", async () => {
    prefs.membership.mockReturnValue({ status: "avoid", note: null, rev: 30 });
    await expect(undoFoodListMark({ ...avoidOats, markRev: 10 })).rejects.toThrow(/changed since/i);
    expect(prefs.set).not.toHaveBeenCalled();
    prefs.membership.mockReturnValue({ status: "avoid", note: null, rev: 10 });
    await undoFoodListMark({ ...avoidOats, markRev: 10 });
    expect(prefs.set).toHaveBeenCalledWith("Oats", null, expect.anything());
  });

  // W029: the server wrote this action's mark at a later revision than it asked for.
  it("undoes a mark the server wrote at a later revision than this action asked for", async () => {
    prefs.membership.mockReturnValue({ status: "avoid", note: null, rev: 31, sentRev: 10 });
    await undoFoodListMark({ ...avoidOats, markRev: 10 });
    expect(prefs.set).toHaveBeenCalledWith("Oats", null, expect.anything());
  });

  it("still undoes when this device has no membership record for the food", async () => {
    await undoFoodListMark(avoidOats);
    expect(prefs.set).toHaveBeenCalledWith("Oats", null, expect.anything());
  });
});
