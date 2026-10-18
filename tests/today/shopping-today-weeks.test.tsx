// @vitest-environment jsdom
// UI audit 2026-10-18 §4: a monthly list's item ticked off for this week is not "to buy" on Today.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { openShoppingItems } from "@/components/today/ShoppingTodayCard";

const period = { id: "p1", startDate: "2026-10-01", endDate: "2026-10-28", revision: 1 };
const lines = [{ id: "a", name: "Eggs", checked: false }, { id: "b", name: "Rice", checked: false }];
const purchaseWindows = [
  { id: "w1", lineId: "a", windowStartDate: "2026-10-01", windowEndDate: "2026-10-07", checked: false },
  { id: "w2", lineId: "a", windowStartDate: "2026-10-08", windowEndDate: "2026-10-14", checked: true },
];
beforeEach(() => {
  unbindAccount(); bindAccount(TEST_USER);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/shopping/periods/p1")
    ? new Response(JSON.stringify({ period, lines, purchaseWindows }), { status: 200 })
    : new Response(JSON.stringify({ periods: [period] }), { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); });

it("leaves out a plan item whose current week is ticked", async () => {
  expect((await openShoppingItems("2026-10-09")).map((line) => line.name)).toEqual(["Rice"]);
  expect((await openShoppingItems("2026-10-03")).map((line) => line.name)).toEqual(["Eggs", "Rice"]);
});
