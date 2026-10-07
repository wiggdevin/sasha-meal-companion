/**
 * Phase 13 §9 R1, client half: "I checked this product's label" (components/FoodSheet.tsx's
 * `LabelCheck`). Resolves the food's server refs from the account's ref cache and posts them to
 * /api/foods/allergen-check. Returns the allergens the check now covers, or null when the food has
 * no server refs yet or the request failed.
 *
 * ROUND 10 finding #5 (REVERTS the round-8 decision below): this now goes through `accountFetch` +
 * `accountJson` for the BOUND account only, the same shape lib/foods/allergen-check-client.ts
 * already uses — never an explicit `userId` override. Phase 9 §0.5a is binding: a client acts only
 * for the account bound on this device. The override this file used to carry let a caller post a
 * label check attributed to any `userId` regardless of what (if anything) is actually bound here —
 * exactly the class of risk `accountFetch`'s own `assertCurrent` gate exists to close everywhere
 * else, and the one tests/device/account-fetch.test.ts's "is the only way client code calls an app
 * /api/ route" gate is built to catch. The override's own justification (an explicit-userId caller
 * "not always the current bound account") named no real caller and none used it outside this
 * file's own tests; it is deleted rather than kept as a second, ungated path into the same route.
 *
 * finding #6: a food's cache entry can carry BOTH a `userRefId` (their own row) and a
 * `catalogRefId` (the catalog product it is mapped to) — two separate revision-keyed evidence
 * rows, not one. Sending both on a single tap marked whichever product the user did NOT inspect as
 * checked too. Exactly one ref goes out: the catalog ref when this food is mapped to one — the
 * revisioned product a printed label actually belongs to — else the user's own row, the same
 * precedence lib/server/catalog.ts's policyRefId already gives the catalog ref elsewhere.
 *
 * finding #7: `expectedRevisions` (lib/server/allergen-evidence.ts markLabelChecked) lets a caller
 * that knows the exact revision it read — the same contract lib/foods/allergen-check-client.ts's
 * markAllergenChecked already carries for the barcode card — say so, so the server refuses a
 * mismatch instead of marking whatever revision is active on arrival. Round 10 finding #3: the
 * route now requires it (a request without it is refused 422), so it is required here too.
 *
 * round 10 finding #2: `allergenKeys` — the allergen keys the caller bound at the moment the sheet
 * resolved them (components/FoodSheet.tsx's `loadConstraints()` read), the same way
 * `expectedRevisions` binds the revision — is required. The server records a check only for these
 * keys, never the account's current profile: an allergen another tab adds between the sheet
 * opening and the tap must not be marked checked for a label the caller never saw it on.
 *
 * ORCHESTRATOR fix (round 7, item 2): `foodRefId`, when given, is used exactly as passed — this
 * function no longer re-reads `readPrefRefCache` on its own to pick one. A caller that bound its
 * ref AND its `expectedRevisions` together at one moment (components/FoodSheet.tsx, when the sheet
 * opened) must send both unchanged at tap; re-deriving the ref here from whatever the cache holds
 * NOW could pick a DIFFERENT ref than the one `expectedRevisions` was keyed for — a background
 * mapping change between open and tap — and `markLabelChecked` would then find no expectation for
 * that (new) ref's id and mark whatever is active, silently losing the whole guard. Omitting
 * `foodRefId` (an older caller) keeps the previous cache-read behavior.
 */
import { accountFetch, accountHandle, accountJson, rethrowAccountChanged } from "@/lib/device/account";
import { readPrefRefCache } from "@/lib/foods/prefs-client";

const ENDPOINT = "/api/foods/allergen-check";

export async function markFoodLabelChecked(
  foodId: string, checked: boolean,
  opts: {
    fetchImpl?: typeof fetch;
    allergenKeys: string[];
    expectedRevisions: Record<string, number>;
    foodRefId?: string | null;
  },
): Promise<string[] | null> {
  try {
    const h = accountHandle();
    const foodRefId = opts.foodRefId !== undefined ? opts.foodRefId
      : (readPrefRefCache(h.userId)[foodId]?.catalogRefId
        ?? readPrefRefCache(h.userId)[foodId]?.userRefId);
    if (!foodRefId) return null;
    // The same "commit" budget the pre-revert raw `fetchWithDeadline` call used (review round 2,
    // correct/FIX): a stalled server must not leave the FoodSheet button stuck in "saving"
    // forever. `accountFetch` races this budget itself when one is given.
    const res = await accountFetch(h, ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        foodRefIds: [foodRefId], checked,
        allergenKeys: opts.allergenKeys, expectedRevisions: opts.expectedRevisions,
      }),
    }, { budget: "commit", fetchImpl: opts.fetchImpl });
    if (!res.ok) return null;
    const body = await accountJson<{ allergens?: unknown; foodKeys?: unknown }>(h, res);
    const keys = Array.isArray(body.foodKeys) ? body.foodKeys : [];
    return keys.length > 0 && Array.isArray(body.allergens)
      ? body.allergens.filter((item): item is string => typeof item === "string") : null;
  } catch (e) {
    rethrowAccountChanged(e);
    return null;
  }
}
