import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadConstraints, saveConstraints, type Profile } from "./constraints-client";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const profile: Profile = {
  avoid_allergens: ["gluten", "dairy", "apple"],
  avoid_food_ref_ids: [],
  banned_categories: ["simple_sugars"],
  conditions: [],
  notes: null,
};

/** A fetch that answers once with `status` and `body`, whatever it is asked. */
function answering(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("saveConstraints", () => {
  it("returns an error result instead of throwing when fetch rejects mid-request", async () => {
    // A dropped connection (a normal phone-first-PWA moment) makes fetch() itself throw,
    // not resolve with a non-ok response. Before the fix nothing catches this, so the
    // caller never learns the edit failed.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const result = await saveConstraints({ baseRev: 0, avoidAllergens: ["soy"] }, 0, { fetchImpl });

    expect(result).toEqual({ status: "error", message: "Could not save. Try again." });
  });

  it("hands back the server's copy on a conflict, because the server's copy wins", async () => {
    const fetchImpl = answering(409, { value: profile, current_rev: 7 });

    const result = await saveConstraints({ baseRev: 3 }, 3, { fetchImpl });

    expect(result).toEqual({ status: "conflict", profile, rev: 7 });
  });

  it("points a pending historical rule removal to the explicit review", async () => {
    const result = await saveConstraints({ baseRev: 3, avoidAllergens: [] }, 3, {
      fetchImpl: answering(409, { error: "rule_review_required" }),
    });
    expect(result).toEqual({ status: "error",
      message: "Review the older food rules above before removing one." });
  });

  // D1 §6.1: there is no floor left for the server to defend, so 422 floor_violation is gone and
  // an empty allergen list is an ordinary accepted change. Any other refusal still reads as one.
  it("reports an unexpected refusal without claiming a rule is locked", async () => {
    const fetchImpl = answering(422, { message: "gluten" });

    const result = await saveConstraints({ baseRev: 1, avoidAllergens: [] }, 1, { fetchImpl });

    expect(result).toEqual({ status: "error", message: "Could not save." });
  });
});

describe("loadConstraints", () => {
  it("returns null instead of throwing when the connection drops mid-request", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(loadConstraints({ fetchImpl })).resolves.toBeNull();
  });

  it("returns null on a refusal, so the rules render without a state to show", async () => {
    await expect(loadConstraints({ fetchImpl: answering(401, {}) })).resolves.toBeNull();
  });
});
