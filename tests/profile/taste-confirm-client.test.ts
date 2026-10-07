// @vitest-environment jsdom
/**
 * Phase 18 W5b-2: the phone half of confirmed taste chips. Offline nothing is sent and the caller
 * is told the confirm waits; a network failure, a 429 or a 5xx is `retry` (the same action id
 * again); any other 4xx is `refused` with its code; a 200 settles the server's row as a pull.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHandle } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import { resetTestAccount } from "@/tests/helpers/account";

const { applyServerUserSettings } = vi.hoisted(() => ({ applyServerUserSettings: vi.fn(async () => true) }));
vi.mock("@/lib/sync/client", () => ({ applyServerUserSettings }));

const { confirmTasteChips, newTasteActionId, undoTasteChips } = await import("@/lib/profile/taste-confirm-client");

const ACTION = "6f1c2f0e-4b7a-4a8e-9d2b-0c7d5e2a9b11";
const REQUEST = { actionId: ACTION, source: "settings" as const, dislikes: ["t:soft" as const], cuisines: [] };
const ROW = { rev: 5, diet_prefs: { taste: { dislikes: ["t:soft"] } } };
let h: AccountHandle;

const synced = vi.fn();
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  h = await resetTestAccount();
  applyServerUserSettings.mockClear();
  synced.mockClear();
  window.removeEventListener(SYNCED_EVENT, synced);
  window.addEventListener(SYNCED_EVENT, synced);
});

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("confirmTasteChips", () => {
  it("offline: sends nothing and says the confirm waits", async () => {
    const fetchImpl = vi.fn();
    expect(await confirmTasteChips(REQUEST, { account: h, fetchImpl, online: () => false }))
      .toEqual({ ok: false, reason: "offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("200: answers the receipt and settles the server's row", async () => {
    const body = { status: "applied", actionId: ACTION, added: { dislikes: ["t:soft"], cuisines: [] },
      present: { dislikes: [], cuisines: [] }, capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: ROW };
    const fetchImpl = vi.fn(json(200, body));
    const outcome = await confirmTasteChips(REQUEST, { account: h, fetchImpl, online: () => true });
    expect(outcome).toEqual({ ok: true, result: body });
    expect(applyServerUserSettings).toHaveBeenCalledWith(h, ROW);
    expect(synced).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/profile/taste/confirm");
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
  });

  it("a 5xx, a 429 or a network failure is retry; another 4xx is refused with its code", async () => {
    for (const status of [502, 503, 429]) {
      expect(await confirmTasteChips(REQUEST, { account: h, online: () => true,
        fetchImpl: vi.fn(json(status, { error: "x", message: "Try again." })) })).toMatchObject({ ok: false, reason: "retry" });
    }
    expect(await confirmTasteChips(REQUEST, { account: h, online: () => true,
      fetchImpl: vi.fn(async () => { throw new TypeError("offline"); }) })).toMatchObject({ ok: false, reason: "retry" });
    // The server answered 200 but the body was lost on the way: retry with the same id.
    expect(await confirmTasteChips(REQUEST, { account: h, online: () => true,
      fetchImpl: vi.fn(async () => new Response("{\"status\":\"app", { status: 200 })) }))
      .toMatchObject({ ok: false, reason: "retry" });
    expect(await confirmTasteChips(REQUEST, { account: h, online: () => true,
      fetchImpl: vi.fn(json(409, { error: "action_conflict", message: "used" })) }))
      .toEqual({ ok: false, reason: "refused", status: 409, code: "action_conflict", message: "used" });
    expect(applyServerUserSettings).not.toHaveBeenCalled();
    expect(synced).not.toHaveBeenCalled();
  });
});

describe("undoTasteChips", () => {
  it("posts only the action id and settles the row", async () => {
    const body = { status: "undone", actionId: ACTION, removed: { dislikes: ["t:soft"], cuisines: [] },
      gone: { dislikes: [], cuisines: [] }, undoneAt: "2026-10-06T00:00:00Z", settings: ROW };
    const fetchImpl = vi.fn(json(200, body));
    expect(await undoTasteChips(ACTION, { account: h, fetchImpl, online: () => true })).toEqual({ ok: true, result: body });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, JSON.parse(String(init.body))]).toEqual(["/api/profile/taste/undo", { actionId: ACTION }]);
    expect(applyServerUserSettings).toHaveBeenCalledWith(h, ROW);
  });

  it("mints a fresh uuid per tap", () => {
    const a = newTasteActionId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(newTasteActionId()).not.toBe(a);
  });
});
