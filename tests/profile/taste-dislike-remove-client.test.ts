// @vitest-environment jsdom
/**
 * Followups #1: the phone half of remove-one-dislike. Offline nothing is sent; a network failure,
 * a 429 or a 5xx is `retry` (the same action id again); any other 4xx is `refused` with its code;
 * a 200 settles the server's row as a pull. Mirrors tests/profile/taste-confirm-client.test.ts.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHandle } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import { resetTestAccount } from "@/tests/helpers/account";

const { applyServerUserSettings } = vi.hoisted(() => ({ applyServerUserSettings: vi.fn(async () => true) }));
vi.mock("@/lib/sync/client", () => ({ applyServerUserSettings }));

const {
  removeTasteDislike, undoRemoveTasteDislike, newTasteDislikeActionId,
} = await import("@/lib/profile/taste-dislike-remove-client");

const ACTION = "6f1c2f0e-4b7a-4a8e-9d2b-0c7d5e2a9b11";
const KEY = "t:soft" as const;
const ROW = { rev: 5, diet_prefs: { taste: { dislikes: [] } } };
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

describe("newTasteDislikeActionId", () => {
  it("mints a fresh uuid each call", () => {
    const a = newTasteDislikeActionId();
    const b = newTasteDislikeActionId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("removeTasteDislike", () => {
  it("offline: sends nothing and says the remove waits", async () => {
    const fetchImpl = vi.fn();
    expect(await removeTasteDislike(KEY, { account: h, fetchImpl, online: () => false }))
      .toEqual({ ok: false, reason: "offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("200: mints an action id, posts the key, and settles the server's row", async () => {
    const body = { status: "removed", actionId: ACTION, key: KEY, settings: ROW };
    const fetchImpl = vi.fn(json(200, body));
    const outcome = await removeTasteDislike(KEY, { account: h, fetchImpl, online: () => true });
    expect(outcome).toEqual({ ok: true, result: body });
    expect(applyServerUserSettings).toHaveBeenCalledWith(h, ROW);
    expect(synced).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/profile/taste/dislikes/remove");
    const sent = JSON.parse(String(init.body)) as { actionId: string; key: string };
    expect(sent.key).toBe(KEY);
    expect(sent.actionId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("a retry reuses the same action id when the caller passes it back", async () => {
    const fetchImpl = vi.fn(json(200, { status: "existing", actionId: ACTION, key: KEY, settings: ROW }));
    await removeTasteDislike(KEY, { account: h, fetchImpl, online: () => true, actionId: ACTION });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { actionId: string }).actionId).toBe(ACTION);
  });

  it("a 5xx, a 429 or a network failure is retry; another 4xx is refused with its code", async () => {
    for (const status of [502, 503, 429]) {
      expect(await removeTasteDislike(KEY, { account: h, online: () => true,
        fetchImpl: vi.fn(json(status, { error: "x", message: "Try again." })) })).toMatchObject({ ok: false, reason: "retry" });
    }
    expect(await removeTasteDislike(KEY, { account: h, online: () => true,
      fetchImpl: vi.fn(async () => { throw new TypeError("offline"); }) })).toMatchObject({ ok: false, reason: "retry" });
    // The server answered 200 but the body was lost on the way: retry with the same id.
    expect(await removeTasteDislike(KEY, { account: h, online: () => true,
      fetchImpl: vi.fn(async () => new Response("{\"status\":\"rem", { status: 200 })) }))
      .toMatchObject({ ok: false, reason: "retry" });
    expect(await removeTasteDislike(KEY, { account: h, online: () => true,
      fetchImpl: vi.fn(json(409, { error: "action_conflict", message: "used" })) }))
      .toEqual({ ok: false, reason: "refused", status: 409, code: "action_conflict", message: "used" });
    expect(applyServerUserSettings).not.toHaveBeenCalled();
    expect(synced).not.toHaveBeenCalled();
  });
});

describe("undoRemoveTasteDislike", () => {
  it("posts only the action id and settles the row", async () => {
    const body = { status: "undone", actionId: ACTION, key: KEY, restored: true, capped: false, settings: ROW };
    const fetchImpl = vi.fn(json(200, body));
    const outcome = await undoRemoveTasteDislike(ACTION, { account: h, fetchImpl, online: () => true });
    expect(outcome).toEqual({ ok: true, result: body });
    expect(applyServerUserSettings).toHaveBeenCalledWith(h, ROW);
    expect(synced).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/profile/taste/dislikes/remove/undo");
    expect(JSON.parse(String(init.body))).toEqual({ actionId: ACTION });
  });

  it("a 404 unknown_action is refused, not retry", async () => {
    const fetchImpl = vi.fn(json(404, { error: "unknown_action", message: "No such action." }));
    expect(await undoRemoveTasteDislike(ACTION, { account: h, fetchImpl, online: () => true }))
      .toEqual({ ok: false, reason: "refused", status: 404, code: "unknown_action", message: "No such action." });
    expect(applyServerUserSettings).not.toHaveBeenCalled();
  });

  it("offline: sends nothing", async () => {
    const fetchImpl = vi.fn();
    expect(await undoRemoveTasteDislike(ACTION, { account: h, fetchImpl, online: () => false }))
      .toEqual({ ok: false, reason: "offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
