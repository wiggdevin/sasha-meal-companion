// @vitest-environment jsdom
/**
 * W014 review round 1 (A031): an Avoid or Eats mark moves the Avoid/Eats watermark from any store
 * writer, so a stored verdict (an offline barcode match) is never replayed past one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { foodMembershipEpoch, noteFoodStatuses } from "@/lib/foods/rules-epoch";
import { loadStore, saveStore } from "@/lib/store";
import { F } from "@/tests/helpers/meal-foods";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  unbindAccount();
  localStorage.clear();
});

describe("the Avoid/Eats watermark", () => {
  it("moves when a food's status changes, and only then", () => {
    const before = foodMembershipEpoch();
    noteFoodStatuses({ a: { status: "eats" } }, { a: { status: "eats" }, b: undefined });
    expect(foodMembershipEpoch()).toBe(before);
    noteFoodStatuses({ a: { status: "eats" } }, { a: { status: "avoid" } });
    expect(foodMembershipEpoch()).toBe(before + 1);
    noteFoodStatuses({}, { b: { status: "avoid" } });
    expect(foodMembershipEpoch()).toBe(before + 2);
  });

  it("moves on a store save that marks a food Avoid, silent pulls included", () => {
    bindAccount(ACCOUNT);
    const base = loadStore();
    const eats = { ...base, foods: { ...base.foods, [F.oats.id]: { ...F.oats, status: "eats" as const } } };
    saveStore(eats);
    const before = foodMembershipEpoch();
    saveStore({ ...eats, settings: { ...eats.settings, shiftMinutes: eats.settings.shiftMinutes + 5 } });
    expect(foodMembershipEpoch()).toBe(before);
    saveStore({ ...eats, foods: { ...eats.foods, [F.oats.id]: { ...F.oats, status: "avoid" } } },
      { silent: true });
    expect(foodMembershipEpoch()).toBeGreaterThan(before);
  });
});
