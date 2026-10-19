// @vitest-environment jsdom
/**
 * UI makeover W7: saved-list rename and delete on the phone (lib/shopping/list-client.ts).
 * Both go through `accountFetch` on the commit budget to the period route, on the revision the
 * caller saw; 409 is ShoppingStaleRevision, any other refusal ShoppingRequestFailed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ accountFetch: vi.fn() }));
vi.mock("@/lib/device/account", async (original) => {
  const real = await original<typeof import("@/lib/device/account")>();
  spies.accountFetch.mockImplementation(real.accountFetch);
  return { ...real, accountFetch: spies.accountFetch };
});

import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { deleteShoppingPeriod, renameShoppingPeriod } from "@/lib/shopping/list-client";
import { ShoppingRequestFailed, ShoppingStaleRevision } from "@/lib/shopping-client";

const PERIOD = "00000000-0000-4000-8000-0000000000f1";
const REQUEST = "00000000-0000-4000-8000-0000000000e1";

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); spies.accountFetch.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); });

function stub(status: number, body: unknown) {
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", send);
  return send;
}
function sent(send: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = send.mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

describe("renameShoppingPeriod", () => {
  it("PATCHes the trimmed title on the expected revision and answers the period", async () => {
    const send = stub(200, { period: { id: PERIOD, title: "Weekly shop", revision: 4 } });
    const period = await renameShoppingPeriod(PERIOD, "  Weekly shop ", 3, REQUEST);
    expect(period).toMatchObject({ id: PERIOD, title: "Weekly shop", revision: 4 });
    const { url, init, body } = sent(send);
    expect(url).toBe(`/api/shopping/periods/${PERIOD}`);
    expect(init.method).toBe("PATCH");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(body).toEqual({ expectedRevision: 3, requestId: REQUEST, patch: { title: "Weekly shop" } });
    expect(spies.accountFetch).toHaveBeenCalledTimes(1);
    expect(spies.accountFetch.mock.calls[0][3]).toEqual({ budget: "commit" });
  });

  it("sends null for a blank title and for null", async () => {
    let send = stub(200, { period: { id: PERIOD, title: null } });
    await renameShoppingPeriod(PERIOD, "   ", 1, REQUEST);
    expect(sent(send).body).toEqual({ expectedRevision: 1, requestId: REQUEST, patch: { title: null } });
    vi.unstubAllGlobals();
    send = stub(200, { period: { id: PERIOD, title: null } });
    await renameShoppingPeriod(PERIOD, null, 2, REQUEST);
    expect(sent(send).body).toEqual({ expectedRevision: 2, requestId: REQUEST, patch: { title: null } });
  });

  it("encodes the period id in the path", async () => {
    const send = stub(200, { period: { id: "a/b" } });
    await renameShoppingPeriod("a/b", "x", 1, REQUEST);
    expect(sent(send).url).toBe("/api/shopping/periods/a%2Fb");
  });

  it("throws ShoppingStaleRevision on 409", async () => {
    stub(409, { error: "stale_revision" });
    await expect(renameShoppingPeriod(PERIOD, "x", 1, REQUEST)).rejects.toBeInstanceOf(ShoppingStaleRevision);
  });

  it("throws ShoppingRequestFailed with the status on 404 and on other refusals", async () => {
    stub(404, { error: "not_found" });
    const gone = await renameShoppingPeriod(PERIOD, "x", 1, REQUEST).catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(ShoppingRequestFailed);
    expect(gone).toMatchObject({ status: 404, message: "This list is gone. Refresh your lists." });
    vi.unstubAllGlobals();
    stub(400, { error: "bad_request" });
    const bad = await renameShoppingPeriod(PERIOD, "x", 1, REQUEST).catch((error: unknown) => error);
    expect(bad).toBeInstanceOf(ShoppingRequestFailed);
    expect(bad).toMatchObject({ status: 400 });
  });
});

describe("deleteShoppingPeriod", () => {
  it("DELETEs with the expected revision and request id only", async () => {
    const send = stub(200, { deleted: true });
    await expect(deleteShoppingPeriod(PERIOD, 5, REQUEST)).resolves.toBeUndefined();
    const { url, init, body } = sent(send);
    expect(url).toBe(`/api/shopping/periods/${PERIOD}`);
    expect(init.method).toBe("DELETE");
    expect(init.cache).toBe("no-store");
    expect(body).toEqual({ expectedRevision: 5, requestId: REQUEST });
    expect(spies.accountFetch.mock.calls[0][3]).toEqual({ budget: "commit" });
  });

  it("throws ShoppingStaleRevision on 409", async () => {
    stub(409, { error: "stale_revision" });
    await expect(deleteShoppingPeriod(PERIOD, 1, REQUEST)).rejects.toBeInstanceOf(ShoppingStaleRevision);
  });

  it("throws ShoppingRequestFailed on 404, and on a 503 with its status", async () => {
    stub(404, { error: "not_found" });
    const gone = await deleteShoppingPeriod(PERIOD, 1, REQUEST).catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(ShoppingRequestFailed);
    expect(gone).not.toBeInstanceOf(ShoppingStaleRevision);
    expect(gone).toMatchObject({ status: 404 });
    vi.unstubAllGlobals();
    stub(503, { error: "shopping_unavailable" });
    const down = await deleteShoppingPeriod(PERIOD, 1, REQUEST).catch((error: unknown) => error);
    expect(down).toBeInstanceOf(ShoppingRequestFailed);
    expect(down).toMatchObject({ status: 503, message: "That didn't save (503). Try again." });
  });
});
