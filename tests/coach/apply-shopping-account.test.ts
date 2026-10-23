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

/** Answers like the routes do; `switchOn` signs another account in while that request is in flight.
 *  `lose` commits the request, then loses its answer (the fetch rejects); `live` is the list as
 *  the server holds it, keyed by line id. */
function stubRoutes(switchOn: (call: Call, index: number) => boolean,
  lose: (call: Call & { name?: string }) => boolean = () => false,
  live = new Map<string, string>()): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? "GET",
      account: new Headers(init.headers).get(ACCOUNT_HEADER) };
    calls.push(call);
    if (switchOn(call, calls.length - 1)) { unbindAccount(); bindAccount("other-user"); }
    const answer = (name?: string): Response => {
      if (url === "/api/recipes/access") return json({ enabled: true });
      if (url.split("?")[0] === "/api/shopping/periods") return json({ periods: [PERIOD] });
      if (url.endsWith("/lines") && call.method === "POST") {
        const sent = JSON.parse(String(init.body)) as { requestId: string; line: { name: string } };
        live.set(sent.requestId, sent.line.name);
        return json({ line: { id: sent.requestId, periodId: PERIOD.id, name: sent.line.name, revision: 1 } }, 201);
      }
      live.delete(decodeURIComponent(url.split("/").pop() ?? ""));
      return json({ deleted: true, name });
    };
    const name = init.body
      ? (JSON.parse(String(init.body)) as { line?: { name: string } }).line?.name : undefined;
    const response = answer(name);
    if (lose({ ...call, name })) throw new TypeError("Failed to fetch");
    return response;
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
  const calls = stubRoutes((call) => call.url.startsWith("/api/shopping/periods?"));
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

it("rejects, with no rollback, when the list read fails after the account switched", async () => {
  // The read rejects, so accountFetch never runs its post-answer check: the apply still must.
  const calls = stubRoutes((call) => call.url.startsWith("/api/shopping/periods?"),
    (call) => call.url.startsWith("/api/shopping/periods?"));
  await expect(applyAddToShoppingList(action, ctx)).rejects.toBeInstanceOf(AccountChanged);
  expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(calls.every((call) => call.account === TEST_USER)).toBe(true);
});

it("says an add may still be on the list when it committed but both answers were lost", async () => {
  const live = new Map<string, string>();
  const calls = stubRoutes(() => false, (call) => call.method === "POST" && call.name === "oat milk", live);
  const result = await applyAddToShoppingList(action, ctx);
  // eggs is taken back; oat milk saved (one row, both tries under one request id) and may stay.
  expect([...live.values()]).toEqual(["oat milk"]);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(3);
  expect(result).toEqual({ status: "failed",
    reason: "Not every item saved. oat milk may still be on your list, and this card can't undo it. "
      + "Check Shopping and remove it there." });
});

it("never says a line is still on the list when its rollback delete committed but lost its answer", async () => {
  const live = new Map<string, string>();
  stubRoutes(() => false, (call) => (call.method === "POST" && call.name === "oat milk")
    || call.method === "DELETE", live);
  const result = await applyAddToShoppingList(action, ctx);
  expect([...live.values()]).toEqual(["oat milk"]);
  expect(result).toEqual({ status: "failed",
    reason: "Not every item saved. eggs and oat milk may still be on your list, and this card can't "
      + "undo them. Check Shopping and remove them there." });
  expect((result as { reason: string }).reason).not.toMatch(/is still|are still/);
});
