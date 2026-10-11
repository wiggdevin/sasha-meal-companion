// @vitest-environment jsdom
// W024 (owner decision zero-ends-focus): a pantry amount edit, a removal or a photo confirm can
// change the shopping-focus keys, so the phone re-reads its held focus at once, not on the next
// once-a-minute sync refresh.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountHandle, bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { confirmPantryForLine, removePantryItem } from "@/lib/shopping-client";
import { confirmPantryPhoto } from "@/lib/shopping/pantry-photo-client";
import { forgetShoppingFocus } from "@/lib/shopping/focus-client";
import type { PantryItem, ShoppingLine } from "@/lib/shopping/types";

const identity = { foodRefId: "rice", catalogFoodRevisionId: 1, purchaseState: "raw" as const, variantKey: "raw" };
const item = { id: "p1", userId: TEST_USER, name: "rice", identity, confirmedGrams: 200,
  confirmedAt: "2026-10-05T12:00:00Z", revision: 2, source: "manual" } as PantryItem;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stubFetch() {
  const send = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/shopping/focus")) return json({ until: null, active: false, keys: [] });
    if (url === "/api/shopping/pantry" && (!init?.method || init.method === "GET")) return json({ items: [item] });
    if (url === "/api/shopping/pantry") return json({ item: { ...item, confirmedGrams: 0, revision: 3 } });
    if (url.startsWith("/api/shopping/pantry/")) return json({ deleted: true });
    if (url === "/api/pantry/photo/confirm") return json({ items: [], failed: [] });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", send);
  return send;
}
const focusReads = (send: ReturnType<typeof stubFetch>) =>
  send.mock.calls.filter(([url]) => String(url).startsWith("/api/shopping/focus")).length;

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); forgetShoppingFocus(); });
afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); forgetShoppingFocus(); });

it("re-reads focus after a pantry amount is set to 0 g", async () => {
  const send = stubFetch();
  await confirmPantryForLine({ name: "rice", identity } as ShoppingLine, 0);
  await vi.waitFor(() => expect(focusReads(send)).toBe(1));
});

it("re-reads focus after a pantry row is removed", async () => {
  const send = stubFetch();
  await removePantryItem(item);
  await vi.waitFor(() => expect(focusReads(send)).toBe(1));
});

it("re-reads focus after a pantry photo confirm", async () => {
  const send = stubFetch();
  await confirmPantryPhoto(accountHandle(), "req-1", [{ name: "rice", grams: null }]);
  await vi.waitFor(() => expect(focusReads(send)).toBe(1));
});
