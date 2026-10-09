// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { acceptShopping, addManualShoppingLine, addToCurrentShoppingList, createShoppingPeriod, patchShoppingLine,
  patchShoppingPurchaseWindow, listShoppingPeriods,
  previewShopping } from "@/lib/shopping-client";
import { defaultShoppingDraft } from "@/components/ShoppingControls";
import type { ShoppingLine, ShoppingPurchaseWindow } from "@/lib/shopping/types";

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });
afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); });

it("sends a line patch with its expected revision", async () => {
  const row = { id: "l1", periodId: "p1", revision: 4 } as ShoppingLine;
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ line: { ...row, checked: true } }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  await patchShoppingLine(row, { checked: true });
  const [url, init] = send.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/shopping/periods/p1/lines/l1");
  expect(init.method).toBe("PATCH");
  expect(JSON.parse(String(init.body))).toMatchObject({ expectedRevision: 4, patch: { checked: true } });
  expect(JSON.parse(String(init.body)).requestId).toBeTruthy();
});

it("sends a dated checked mark to its own purchase window revision", async () => {
  const row = { id: "w1", periodId: "p1", revision: 3 } as ShoppingPurchaseWindow;
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ purchaseWindow: {
    ...row, checked: true } }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  await patchShoppingPurchaseWindow(row, { checked: true });
  const [url, init] = send.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/shopping/periods/p1/purchase-windows/w1");
  expect(JSON.parse(String(init.body))).toMatchObject({ expectedRevision: 3,
    patch: { checked: true }, requestId: expect.any(String) });
});

it("creates a period with the route's nested draft and idempotency key", async () => {
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ period: { id: "p1" } }), { status: 201 }));
  vi.stubGlobal("fetch", send);
  const draft = defaultShoppingDraft("2026-09-27", "America/Denver");
  await createShoppingPeriod(draft);
  const payload = JSON.parse(String((send.mock.calls[0][1] as RequestInit).body));
  expect(payload.period).toEqual(draft);
  expect(payload.requestId).toBeTruthy();
});

it("loads saved lists without a date filter", async () => {
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ periods: [] }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  await listShoppingPeriods();
  expect(send.mock.calls[0][0]).toBe("/api/shopping/periods");
});

it("shows a recoverable planning prerequisite instead of a generic conflict", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    error: "rule_review_required", message: "A dated food rule needs review.",
  }), { status: 409 })));
  await expect(previewShopping({ draft: defaultShoppingDraft("2026-09-27", "UTC"), basket: [] }, null))
    .rejects.toThrow(/Confirm your food rules/);
});

it("discards an error body if the bound account changes while it parses", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422,
    json: async () => {
      bindAccount("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      return { error: "needs_profile", message: "Old account profile" };
    },
  }));
  await expect(listShoppingPeriods()).rejects.toBeInstanceOf(AccountChanged);
});

it("keeps a manual item distinct from plan-derived requirements", async () => {
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ line: { id: "m1" } }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  await addManualShoppingLine("p1", "Soap", "manual-request");
  const payload = JSON.parse(String((send.mock.calls[0][1] as RequestInit).body));
  expect(payload.line).toMatchObject({ origin: "manual", category: "manual", name: "Soap",
    identity: null, sources: [], checked: false });
  expect(payload.requestId).toBe("manual-request");
});

it("surfaces a stale edit rather than reporting success", async () => {
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "stale" }), { status: 409 }));
  vi.stubGlobal("fetch", send);
  await expect(patchShoppingLine({ id: "l1", periodId: "p1", revision: 1 } as ShoppingLine,
    { checked: true })).rejects.toThrow(/changed elsewhere/);
});

it("sends only the draft, basket and revision authority to shopping preview, then proof IDs to accept", async () => {
  const send = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ previewId: "proof" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ period: null, lines: [] }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  const draft = defaultShoppingDraft("2026-09-27", "America/Denver");
  const basket = [{ foodRefId: null, foodDbId: "carrot-raw",
    catalogFoodRevisionId: null, purchaseState: "raw" as const, variantKey: "plain" }];
  await previewShopping({ draft, basket }, { id: "period-1", revision: 4 } as never);
  await acceptShopping("proof", "request-1");
  expect(JSON.parse(String((send.mock.calls[0][1] as RequestInit).body))).toEqual({
    periodId: "period-1", expectedRevision: 4, draft, basket,
  });
  expect(JSON.parse(String((send.mock.calls[1][1] as RequestInit).body))).toEqual({
    previewId: "proof", requestId: "request-1",
  });
});

/** 2026-10-02: the assistant and the Today card add to "the list" without the Shopping screen. */
it("adds items to the list that covers today, starting this week's list when there is none", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const periods: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init.method ?? "GET", body });
    if (url.startsWith("/api/shopping/periods?") || url === "/api/shopping/periods" && !init.method)
      return new Response(JSON.stringify({ periods }), { status: 200 });
    if (url === "/api/shopping/periods" && init.method === "POST") {
      const period = { id: "p9", ...body.period, revision: 1 };
      periods.push(period);
      return new Response(JSON.stringify({ period }), { status: 201 });
    }
    if (url === "/api/shopping/periods/p9/lines")
      return new Response(JSON.stringify({ line: { id: `l${calls.length}`, periodId: "p9", ...body.line } }), { status: 201 });
    return new Response("{}", { status: 404 });
  }));
  const first = await addToCurrentShoppingList(["eggs", "oat milk"], "2026-10-02", "America/Denver");
  expect(first.lines.map((line) => line.name)).toEqual(["eggs", "oat milk"]);
  expect(first.failed).toEqual([]);
  expect(calls.filter((call) => call.method === "POST" && call.url === "/api/shopping/periods")).toHaveLength(1);
  await addToCurrentShoppingList(["bread"], "2026-10-04", "America/Denver");
  expect(calls.filter((call) => call.method === "POST" && call.url === "/api/shopping/periods")).toHaveLength(1);
});

it("never writes to a second account's list when the account switches part-way (audit 2026-10-08 §4)",
  async () => {
    const calls: { url: string; account: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, account: new Headers(init.headers).get("x-smc-account") });
      // The other account signs in while the list read is in flight.
      unbindAccount(); bindAccount("other-user");
      return new Response(JSON.stringify({ periods: [] }), { status: 200 });
    }));
    await expect(addToCurrentShoppingList(["eggs"], "2026-10-02", "America/Denver"))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(calls).toEqual([{ url: "/api/shopping/periods", account: TEST_USER }]);
  });

it("treats a line refused for an account change as an account change, not an item to retry", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/shopping/periods" && !init.method)
      return new Response(JSON.stringify({ periods: [{ id: "p1", startDate: "2026-10-01",
        endDate: "2026-10-07", revision: 1 }] }), { status: 200 });
    unbindAccount(); bindAccount("other-user");
    return new Response(JSON.stringify({ line: { id: "l1", periodId: "p1", name: "eggs", revision: 1 } }),
      { status: 201 });
  }));
  await expect(addToCurrentShoppingList(["eggs"], "2026-10-02", "America/Denver"))
    .rejects.toBeInstanceOf(AccountChanged);
});
