/**
 * Phase 13 §9 R1, client half of the barcode card's "I checked the label" button
 * (components/coach/editors/AllergenCheck.tsx). Posts through `accountFetch` (Phase 9 §0.5a) so
 * the request carries the bound account's `x-smc-account` header and is dropped if the account
 * changes mid-flight — see lib/health/weigh-in-client.ts for the same accountFetch/accountJson
 * shape, and lib/foods/starter-client.test.ts for the bindAccount/unbindAccount test pattern.
 *
 * review round 2 (correct/FIX): the POST carries the "commit" budget — the same one
 * lib/foods/label-check-client.ts's own write to this route already uses — so a stalled server
 * cannot leave the barcode card's button stuck in "Saving" forever with nothing to abort it
 * (lib/fetch-with-deadline.ts, T0 §2).
 */
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";

const ENDPOINT = "/api/foods/allergen-check";

export type AllergenCheckOptions = {
  fetchImpl?: typeof fetch;
  account?: AccountHandle;
  /**
   * Phase 13 §9 R1, round 10 finding #2: the allergen keys shown on THIS card, bound at the
   * moment it rendered (`match.policy.allergens.map(f => f.allergen)`) — the same way
   * `expectedRevisions` below binds the revision. The server records a check only for these keys,
   * never for whatever the account's profile currently avoids: an allergen another tab adds
   * between render and tap must not be marked checked for a label the caller never saw it on.
   */
  allergenKeys: string[];
  /**
   * Phase 13 §9 R1 (finding #6): the catalog revision id the caller actually looked at, keyed by
   * food ref id. The server skips a ref whose active revision has since moved rather than marking
   * whichever product is active on arrival — see lib/server/allergen-evidence.ts markLabelChecked.
   * Round 10 finding #3: required — the route refuses 422 without it.
   */
  expectedRevisions: Record<string, number>;
};

/**
 * Marks (or, with `checked: false`, clears) the exact product behind `foodRefIds` as checked.
 * Resolves false on any failure — no account bound, offline, a refusal, or the server finding the
 * expected revision stale — never throws, so the button only has to show what it got back.
 */
export async function markAllergenChecked(
  foodRefIds: string[], checked: boolean, opts: AllergenCheckOptions,
): Promise<boolean> {
  try {
    const h = opts.account ?? accountHandle();
    const res = await accountFetch(h, ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        foodRefIds, checked,
        allergenKeys: opts.allergenKeys, expectedRevisions: opts.expectedRevisions,
      }),
    }, { budget: "commit", fetchImpl: opts.fetchImpl });
    if (!res.ok) return false;
    const body = await accountJson<{ foodKeys?: unknown }>(h, res);
    // A stale expected revision (or no matching ref at all) leaves foodKeys empty: nothing was
    // actually marked, so this must not report success (finding #6).
    return Array.isArray(body.foodKeys) && body.foodKeys.length > 0;
  } catch (e) {
    rethrowAccountChanged(e);
    return false;
  }
}
