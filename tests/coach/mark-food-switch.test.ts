// @vitest-environment jsdom
/**
 * PR #248 review r1 sweep: the coach's Eats/Avoid mark captures the account at the tap. When the
 * account changes while the mark runs, nothing is queued or written for the new account.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({
  current: vi.fn(async (_refId: string, _h?: unknown): Promise<null> => null),
  set: vi.fn(async (_name: string, _status: unknown, _opts?: unknown) => null),
  nextIntent: 0,
}));
vi.mock("@/lib/foods/prefs-client", () => ({
  currentPrefStatus: (refId: string, h?: unknown) => prefs.current(refId, h),
  setFoodMembership: (name: string, status: unknown, opts?: unknown) => prefs.set(name, status, opts),
  reserveFoodMembershipIntent: () => ({ id: ++prefs.nextIntent }),
  isLatestFoodMembershipIntent: (intent: { id: number }) => intent.id === prefs.nextIntent,
}));

import { markFood } from "@/components/CoachChat";
import { applyFoodListMark } from "@/lib/coach/apply-prefs";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { defaultStore, getFoods, saveStore } from "@/lib/store";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REF = { foodRefId: "ref-1", revisionId: "1", name: "Oats", blocked: false };
const OATS = { id: "f-oats", name: "Oats", status: "neutral" } as const;

function seed(userId: string): void {
  unbindAccount();
  bindAccount(userId);
  const store = defaultStore();
  saveStore({ ...store, foods: { ...store.foods, [OATS.id]: { ...OATS } as never } });
}

function storedStatus(userId: string): unknown {
  const raw = localStorage.getItem(`smc:u:${userId}:store`);
  return raw === null ? undefined : (JSON.parse(raw) as { foods: Record<string, { status?: unknown }> })
    .foods[OATS.id]?.status;
}

beforeEach(() => {
  localStorage.clear();
  prefs.current.mockReset().mockResolvedValue(null);
  prefs.set.mockReset().mockResolvedValue(null);
  prefs.nextIntent = 0;
  seed(B);
  seed(A);
});

describe("markFood across a switch", () => {
  it("queues nothing for B when the account changes during the status read", async () => {
    prefs.current.mockImplementation(async () => { bindAccount(B); return null; });
    await markFood(REF, "eats").catch(() => {});
    expect(prefs.set).not.toHaveBeenCalled();
    expect(storedStatus(B)).toBe("neutral"); // B's food is untouched
  });

  it("writes nothing into B's store when the account changes during the membership save", async () => {
    prefs.set.mockImplementation(async () => { bindAccount(B); return null; });
    await markFood(REF, "eats").catch(() => {});
    expect(prefs.set).toHaveBeenCalledWith("Oats", "eats",
      expect.objectContaining({ account: expect.objectContaining({ userId: A }) }));
    expect(storedStatus(B)).toBe("neutral");
  });

  it("marks the food for the account that tapped", async () => {
    await markFood(REF, "avoid");
    expect(getFoods()[OATS.id]?.status).toBe("avoid");
  });

  it("keeps the later Coach card choice when the earlier status read resolves last", async () => {
    let release!: () => void;
    const held = new Promise<null>((resolve) => { release = () => resolve(null); });
    prefs.current.mockImplementationOnce(() => held).mockResolvedValue(null);
    const earlier = markFood(REF, "eats");
    await markFood(REF, "avoid");
    release();
    await earlier;
    expect(prefs.set.mock.calls.map((call) => call[1])).toEqual(["avoid"]);
    expect(getFoods()[OATS.id]?.status).toBe("avoid");
  });

  it("does not create an Undo token or overwrite local food for a stale Coach action", async () => {
    let release!: () => void;
    const held = new Promise<null>((resolve) => { release = () => resolve(null); });
    prefs.current.mockImplementationOnce(() => held).mockResolvedValue(null);
    const action = (kind: "add_to_eats" | "add_to_avoid") => ({
      kind, actionId: kind, flagged: [], name: OATS.name, foodRefId: REF.foodRefId,
      catalogFoodRevisionId: 1, kcalPer100g: 10, proteinPer100g: 1,
      carbsPer100g: 1, fatPer100g: 0, verdict: "allowed",
    }) as Parameters<typeof applyFoodListMark>[0];
    const earlier = applyFoodListMark(action("add_to_eats"));
    const later = await applyFoodListMark(action("add_to_avoid"));
    release();
    const stale = await earlier;
    expect(later.status).toBe("applied");
    expect(stale.status).toBe("failed");
    expect(prefs.set.mock.calls.map((call) => call[1])).toEqual(["avoid"]);
    expect(getFoods()[OATS.id]?.status).toBe("avoid");
  });
});
