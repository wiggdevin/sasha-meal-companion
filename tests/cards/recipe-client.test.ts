// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import { getCatalogFavorite, searchCatalogRecipes, setCatalogFavorite } from "@/lib/recipe-catalog-client";
import { acceptRecipePlan, previewRecipePlan } from "@/lib/recipe-plan-client";

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });
afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); });

it("searches the account route without a browse write", async () => {
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ recipes: [], count: 0, limitations: [] }),
    { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", send);
  await searchCatalogRecipes({ query: "stew", cuisine: "French", maxMinutes: 50, limit: 3 }, new AbortController().signal);
  expect(send).toHaveBeenCalledOnce();
  const [url, init] = send.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("/api/recipes?q=stew");
  expect(url).toContain("cuisine=French");
  expect(init.method).toBeUndefined();
  expect((init.headers as Headers).get("x-smc-account")).toBe(TEST_USER);
});

it("uses the catalog favorite bridge with a revision check", async () => {
  const send = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ favorite: false, revision: 2 }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ favorite: true, revision: 3 }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  expect(await getCatalogFavorite("r1")).toEqual({ favorite: false, revision: 2 });
  expect(await setCatalogFavorite("r1", true, 2)).toEqual({ favorite: true, revision: 3 });
  const [url, init] = send.mock.calls[1] as [string, RequestInit];
  expect(url).toBe("/api/recipes/r1/favorite");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(String(init.body))).toMatchObject({ favorite: true, expectedRevision: 2 });
});

it("maps an absent favorite revision to the route's null create precondition", async () => {
  const send = vi.fn().mockResolvedValue(new Response(JSON.stringify({ favorite: true, revision: 1 }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  await setCatalogFavorite("r1", true, 0);
  expect(JSON.parse(String((send.mock.calls[0][1] as RequestInit).body)).expectedRevision).toBeNull();
});

it("keeps the server preview ID and idempotency key as the only plan acceptance proof", async () => {
  const send = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ previewId: "proof-1" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ selection: { id: "selection-1" } }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  await previewRecipePlan("r1", "2026-09-27", "meal-2", 0.5);
  await acceptRecipePlan("r1", "proof-1", "request-1", true);
  expect(JSON.parse(String((send.mock.calls[0][1] as RequestInit).body))).toEqual({
    date: "2026-09-27", slotId: "meal-2", servingFraction: 0.5,
  });
  expect(JSON.parse(String((send.mock.calls[1][1] as RequestInit).body))).toEqual({
    previewId: "proof-1", requestId: "request-1", acceptApproximate: true,
  });
});
