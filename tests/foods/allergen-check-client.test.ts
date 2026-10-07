/**
 * Phase 13 §9 R1, client half: components/coach/editors/AllergenCheck.tsx's "I checked the label"
 * button (lib/foods/allergen-check-client.ts). Goes through accountFetch (Phase 9 §0.5a) — see
 * lib/foods/starter-client.test.ts for the same bind/unbind pattern.
 *
 * Round 10 finding #2: `allergenKeys` and `expectedRevisions` are both required now — the caller
 * binds both at the moment the card renders, the same way `match.revisionId` already does, and
 * the server records a check only for the keys given, never the account's current profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_HEADER, bindAccount, unbindAccount } from "@/lib/device/account";
import { DEADLINES } from "@/lib/fetch-with-deadline";
import { markAllergenChecked } from "@/lib/foods/allergen-check-client";

const FOOD_REF_ID = "11111111-1111-4111-8111-111111111111";
const BOUND = { allergenKeys: ["sesame"], expectedRevisions: { [FOOD_REF_ID]: 410 } };

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

beforeEach(() => { bindAccount("user-a"); });
afterEach(() => { unbindAccount(); });

describe("markAllergenChecked", () => {
  it("posts to the allergen-check route carrying the bound account's x-smc-account header, the " +
    "caller's allergen keys and its expected revision", async () => {
    const fetchImpl = answer(200, { foodKeys: ["k1"], allergens: ["sesame"] });

    expect(await markAllergenChecked([FOOD_REF_ID], true, { fetchImpl, ...BOUND })).toBe(true);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/foods/allergen-check");
    expect(new Headers((init as RequestInit).headers).get(ACCOUNT_HEADER)).toBe("user-a");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      foodRefIds: [FOOD_REF_ID], checked: true,
      allergenKeys: ["sesame"], expectedRevisions: { [FOOD_REF_ID]: 410 },
    });
  });

  it("carries the caller's expected revision, so a stale one can be told apart from a fresh one " +
    "(finding #6)", async () => {
    const fetchImpl = answer(200, { foodKeys: ["catalog_revision:410"], allergens: ["sesame"] });

    await markAllergenChecked([FOOD_REF_ID], true, { fetchImpl, ...BOUND });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      foodRefIds: [FOOD_REF_ID], checked: true,
      allergenKeys: ["sesame"], expectedRevisions: { [FOOD_REF_ID]: 410 },
    });
  });

  it("sends only the allergen keys bound at render, not a wider set — an allergen added to the " +
    "profile after the card rendered is never in this request (finding #2)", async () => {
    const fetchImpl = answer(200, { foodKeys: ["catalog_revision:410"], allergens: ["gluten"] });

    await markAllergenChecked([FOOD_REF_ID], true, {
      fetchImpl, allergenKeys: ["gluten"], expectedRevisions: { [FOOD_REF_ID]: 410 },
    });

    const sent = JSON.parse(String(
      ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body));
    expect(sent.allergenKeys).toEqual(["gluten"]);
  });

  it("returns false (not a false success) when the server marked nothing — a stale revision", async () => {
    const fetchImpl = answer(200, { foodKeys: [], allergens: ["sesame"] });

    expect(await markAllergenChecked([FOOD_REF_ID], true, { fetchImpl, ...BOUND })).toBe(false);
  });

  it("fails without a send when no account is bound", async () => {
    unbindAccount();
    const fetchImpl = answer(200, { foodKeys: [], allergens: [] });

    expect(await markAllergenChecked([FOOD_REF_ID], true, { fetchImpl, ...BOUND })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns false when the route refuses", async () => {
    expect(await markAllergenChecked([FOOD_REF_ID], true,
      { fetchImpl: answer(429, { error: "x" }), ...BOUND })).toBe(false);
  });

  it("returns false when the route refuses a stale request with 422 (finding #3)", async () => {
    expect(await markAllergenChecked([FOOD_REF_ID], true,
      { fetchImpl: answer(422, { error: "revision_required" }), ...BOUND })).toBe(false);
  });

  it("returns false on a network error", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    expect(await markAllergenChecked([FOOD_REF_ID], true, { fetchImpl, ...BOUND })).toBe(false);
  });

  it("review r2 correct/FIX: gives up at the commit budget instead of hanging forever — a raw " +
    "fetch with no deadline left the barcode card's button stuck in 'saving' when the server " +
    "never answered (lib/fetch-with-deadline.ts T0 §2)", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const outcome = markAllergenChecked([FOOD_REF_ID], true, { fetchImpl, ...BOUND });
      await vi.advanceTimersByTimeAsync(DEADLINES.commit + 10);
      expect(await outcome).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
