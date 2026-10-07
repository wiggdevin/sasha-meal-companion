/**
 * Phase 18 W3 UI: the client reader for `GET /api/foods/taste` (lib/foods/taste-client.ts).
 * Same bind/unbind pattern as tests/foods/allergen-check-client.test.ts; the server contract is
 * lib/server/taste-admission.ts's `TasteResponse`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { DeadlineExceeded } from "@/lib/fetch-with-deadline";
import { loadTaste, TASTE_RULE_REVIEW_COPY, type TasteRow } from "@/lib/foods/taste-client";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const PROVENANCE = {
  match: "universe" as const, estimated: false,
  sources: { log: 1, recipe: 0, tick: 0, mixed_dish: 0 }, collapsed: 0,
  choices: { swap_pick: 0, plan_add: 0, shopping_manual: 0 },
};

function row(over: Partial<TasteRow> = {}): TasteRow {
  return {
    key: "u:oats", name: "Oats", days180: 5, lastOn: "2026-10-03", favored: false, favorable: false,
    h: 1.25, q: 0, provenance: PROVENANCE, ...over,
  };
}

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

beforeEach(() => { bindAccount(USER_ID); });
afterEach(() => { unbindAccount(); });

describe("loadTaste", () => {
  it("reads a good body as ok, in the server's own order", async () => {
    const items = [row({ key: "u:oats", name: "Oats" }), row({ key: "u:rice", name: "Rice", h: 0.5 })];
    const fetchImpl = answer(200, { version: "taste-1", asOf: "2026-10-06", windowDays: 180,
      m: 1, episodes: 2, rulesRevision: 3, items });

    const result = await loadTaste({ fetchImpl });

    expect(result).toEqual({ status: "ok", items });
  });

  it("drops a malformed item but keeps the rest, in order", async () => {
    const good1 = row({ key: "u:oats", name: "Oats" });
    const good2 = row({ key: "u:rice", name: "Rice" });
    const fetchImpl = answer(200, { version: "taste-1", items: [
      good1,
      { ...row({ key: "u:bad-days" }), days180: "five" }, // wrong type
      { ...row({ key: "u:bad-date" }), lastOn: "not-a-date" }, // bad date shape
      { ...row({ key: "u:bad-match" }), provenance: { ...PROVENANCE, match: "other" } },
      { ...row({ key: "u:bad-sources" }), provenance: { ...PROVENANCE, sources: { log: 1 } } }, // incomplete
      { name: "No key" }, // missing required fields entirely
      good2,
    ] });

    const result = await loadTaste({ fetchImpl });

    expect(result).toEqual({ status: "ok", items: [good1, good2] });
  });

  it("reads favorable: true as given, a missing favorable as false, and drops a row whose favorable is not a boolean", async () => {
    const { favorable: _omit, ...older } = row({ key: "u:old", name: "Old" });
    const fetchImpl = answer(200, { version: "taste-1", items: [
      row({ key: "u:yes", name: "Yes", favorable: true }),
      older,
      { ...row({ key: "u:bad", name: "Bad" }), favorable: "yes" },
    ] });

    const result = await loadTaste({ fetchImpl });

    expect(result.status).toBe("ok");
    const items = result.status === "ok" ? result.items : [];
    expect(items.map((item) => [item.key, item.favorable])).toEqual([["u:yes", true], ["u:old", false]]);
  });

  it("answers unavailable when the envelope's version does not match", async () => {
    const fetchImpl = answer(200, { version: "taste-2", items: [row()] });

    expect(await loadTaste({ fetchImpl })).toEqual({ status: "unavailable" });
  });

  it("answers unavailable when items is missing or not an array", async () => {
    const fetchImpl = answer(200, { version: "taste-1" });

    expect(await loadTaste({ fetchImpl })).toEqual({ status: "unavailable" });
  });

  it("answers rule_review on a 409 rule_review_required, with the eligible-foods path's own copy", async () => {
    const fetchImpl = answer(409, { error: "rule_review_required", message: "some server text" });

    expect(await loadTaste({ fetchImpl })).toEqual({
      status: "rule_review", message: TASTE_RULE_REVIEW_COPY,
    });
  });

  it("answers unavailable on a 409 for any other reason", async () => {
    const fetchImpl = answer(409, { error: "account_mismatch" });

    expect(await loadTaste({ fetchImpl })).toEqual({ status: "unavailable" });
  });

  it("answers unavailable on a 401", async () => {
    const fetchImpl = answer(401, { error: "unauthorized" });

    expect(await loadTaste({ fetchImpl })).toEqual({ status: "unavailable" });
  });

  it("answers unavailable on a 500", async () => {
    const fetchImpl = answer(500, { error: "internal" });

    expect(await loadTaste({ fetchImpl })).toEqual({ status: "unavailable" });
  });

  it("answers unavailable on a timeout", async () => {
    const fetchImpl = (async () => { throw new DeadlineExceeded("search", 6_000); }) as unknown as typeof fetch;

    expect(await loadTaste({ fetchImpl })).toEqual({ status: "unavailable" });
  });

  it("answers unavailable when no account is bound", async () => {
    unbindAccount();
    const fetchImpl = answer(200, { version: "taste-1", items: [row()] });

    expect(await loadTaste({ fetchImpl })).toEqual({ status: "unavailable" });
  });
});
