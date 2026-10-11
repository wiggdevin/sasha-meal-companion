// @vitest-environment jsdom
/**
 * W020: `add_to_shopping_list` runs as one account from the gate to the last write, against the
 * real access and shopping clients (only `fetch` is stubbed). A switch part-way rejects the apply
 * and nothing more is written — not to the new account's list, and no rollback under it.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountChanged, ACCOUNT_HEADER, bindAccount, unbindAccount } from "@/lib/device/account";
import { applyAddToShoppingList, SHOPPING_SWITCH_PARTIAL_REASON } from "@/lib/coach/apply-shopping";
import { TEST_USER } from "@/tests/helpers/account";

type Call = { url: string; method: string; account: string | null };

const action = { kind: "add_to_shopping_list" as const, names: ["eggs", "oat milk"],
  actionId: "a1", flagged: [] as string[] };
const PERIOD = { id: "p1", startDate: "2026-10-01", endDate: "2026-10-07", revision: 1 };
const ctx = { tz: "America/Denver", now: new Date("2026-10-02T12:00:00Z") };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Answers like the routes do; `switchOn` signs another account in while that request is in flight. */
function stubRoutes(switchOn: (call: Call, index: number) => boolean): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? "GET",
      account: new Headers(init.headers).get(ACCOUNT_HEADER) };
    calls.push(call);
    if (switchOn(call, calls.length - 1)) { unbindAccount(); bindAccount("other-user"); }
    if (url === "/api/recipes/access") return json({ enabled: true });
    if (url === "/api/shopping/periods") return json({ periods: [PERIOD] });
    if (url.endsWith("/lines") && call.method === "POST") {
      const sent = JSON.parse(String(init.body)) as { requestId: string; line: { name: string } };
      return json({ line: { id: sent.requestId, periodId: PERIOD.id, name: sent.line.name, revision: 1 } }, 201);
    }
    return json({ deleted: true });
  }));
  return calls;
}

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });
afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); });

it("rejects with no write when the account switches during the access check", async () => {
  const calls = stubRoutes((call) => call.url === "/api/recipes/access");
  await expect(applyAddToShoppingList(action, ctx)).rejects.toBeInstanceOf(AccountChanged);
  expect(calls).toEqual([{ url: "/api/recipes/access", method: "GET", account: TEST_USER }]);
});

it("rejects with no write when the account switches while the list is read", async () => {
  const calls = stubRoutes((call) => call.url === "/api/shopping/periods");
  await expect(applyAddToShoppingList(action, ctx)).rejects.toBeInstanceOf(AccountChanged);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(calls.every((call) => call.account === TEST_USER)).toBe(true);
});

it("writes nothing more, and rolls nothing back, once the account switches during the adds", async () => {
  const calls = stubRoutes((call) => call.method === "POST");
  const error = await applyAddToShoppingList(action, ctx).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AccountChanged);
  // The first add may have landed on the first account's list: the card says so, with no Undo.
  expect((error as Error).message).toBe(SHOPPING_SWITCH_PARTIAL_REASON);
  // The switch lands while the first add is in flight: the second is refused before it is sent,
  // and there is no retry, no DELETE and no request as the new account.
  expect(calls.every((call) => call.account === TEST_USER)).toBe(true);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
});
