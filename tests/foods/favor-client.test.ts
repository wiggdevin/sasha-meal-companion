/**
 * Phase 18 D6: the client for `POST /api/foods/favor` (lib/foods/favor-client.ts). Every status the
 * route answers (app/api/foods/favor/route.ts) maps to one outcome; only an account change throws.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import { DeadlineExceeded } from "@/lib/fetch-with-deadline";
import { favorTasteKey } from "@/lib/foods/favor-client";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

beforeEach(() => { bindAccount(USER_ID); });
afterEach(() => { unbindAccount(); });

describe("favorTasteKey", () => {
  it("posts { key } as JSON to the favor route with the phone's own day", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ favored: true, refs: 2, skippedAvoid: 0, rulesRevision: 4 }), { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await favorTasteKey("u:oats", { fetchImpl });

    expect(outcome).toEqual({ status: "favored", rulesRevision: 4 });
    expect(seen!.url).toMatch(/^\/api\/foods\/favor\?date=\d{4}-\d{2}-\d{2}$/);
    expect(seen!.init.method).toBe("POST");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ key: "u:oats" });
  });

  it("counts a 200 as written even when its body cannot be read", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect(await favorTasteKey("u:oats", { fetchImpl })).toEqual({ status: "favored", rulesRevision: null });
  });

  it.each([
    [404, { error: "unknown_key" }, "gone"],
    [409, { error: "rule_review_required" }, "rule_review"],
    [409, { error: "rules_changed", rulesVersion: 9 }, "changed"],
    [409, { error: "membership_changed" }, "changed"],
    [422, { error: "nothing_to_favor" }, "blocked"],
    [429, { error: "rate_limited" }, "busy"],
    [400, { error: "bad_request" }, "failed"],
    [401, { error: "unauthorized" }, "failed"],
    [413, { error: "too_large" }, "failed"],
    [503, { error: "admission_unavailable" }, "failed"],
    [409, { error: "something_else" }, "failed"],
    [404, { error: "not_found" }, "failed"],
  ])("maps %i %j to %s", async (status, body, expected) => {
    expect((await favorTasteKey("u:oats", { fetchImpl: answer(status, body) })).status).toBe(expected);
  });

  it("answers failed on a timeout or a network error", async () => {
    const timeout = (async () => { throw new DeadlineExceeded("commit", 10_000); }) as unknown as typeof fetch;
    const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await favorTasteKey("u:oats", { fetchImpl: timeout })).toEqual({ status: "failed" });
    expect(await favorTasteKey("u:oats", { fetchImpl: offline })).toEqual({ status: "failed" });
  });

  it("throws when the account changes while the request is in flight", async () => {
    const fetchImpl = (async () => {
      unbindAccount();
      bindAccount("22222222-2222-4222-8222-222222222222");
      return new Response(JSON.stringify({ favored: true, refs: 1, skippedAvoid: 0, rulesRevision: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(favorTasteKey("u:oats", { fetchImpl })).rejects.toBeInstanceOf(AccountChanged);
  });
});
