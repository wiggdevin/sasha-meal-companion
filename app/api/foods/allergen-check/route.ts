/**
 * POST /api/foods/allergen-check — Phase 13 §9 R1: "I checked this product's label". Marks (or,
 * with `checked: false`, clears) the exact product behind the given food refs as checked for
 * every allergen the account avoids. The only way an allergen US labels need not declare, or a
 * product with no ingredient list, becomes allowed. Runs on the caller's RLS client only.
 */
import { z } from "zod";
import { HttpError, requireUser } from "@/lib/server/auth";
import { markLabelChecked } from "@/lib/server/allergen-evidence";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  foodRefIds: z.array(z.string().uuid()).min(1).max(4),
  checked: z.boolean(),
  // finding #2 (round 10): the allergen keys the caller actually inspected — bound client-side
  // when the sheet/card opened (components/coach/editors/AllergenCheck.tsx's own
  // `match.policy.allergens`, components/FoodSheet.tsx's `loadConstraints()` read), the same way
  // `expectedRevisions` below binds the revision. This route never re-reads the account's CURRENT
  // profile for the allergen list any more: an allergen another tab adds to it between the sheet
  // opening and this tap must not be marked checked for a label the caller never actually saw it
  // on.
  //
  // sol FIX (review round 2): the cap here must be at least as high as the profile's own —
  // lib/coach/types.ts's `avoidAllergens` schema allows up to 40 (each up to 40 chars, an
  // account-defined allergen outside the fixed vocabulary). A cap of 20 refused a legitimate
  // request from any account avoiding more than that, contrary to §9 R1's own "no bypass" intent
  // for the allergens it actually avoids.
  allergenKeys: z.array(z.string().min(1).max(40)).min(1).max(40),
  // finding #6: the catalog revision id the caller actually looked at, keyed by food ref id — so a
  // ref whose active revision moved since (a background refresh) is skipped, not silently marked.
  // finding #3 (round 10): kept optional in the schema so a request that omits it still PARSES —
  // the explicit check below answers it with its own 422, distinct from a malformed body's 400.
  expectedRevisions: z.record(z.string().uuid(), z.number().int().positive()).optional(),
}).strict();

export async function POST(req: Request): Promise<Response> {
  try {
    await enforceRateLimit(`foods:allergen-check:pre:ip:${requestIp(req)}`, 240, 60);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`foods:allergen-check:${userId}`, 60, 60);
    // sol FIX (review round 2): 1024 was sized for the OLD 20-key cap; 40 keys at their own
    // 40-char max (plus 4 food refs and their expected revisions) can run past it on a legitimate
    // request, the same undersizing `allergenKeys` itself had. ~4 KB comfortably covers the
    // schema's own worst case with room to spare.
    const body = await readJson(req, Body, 4096);
    // finding #3 (round 10): required, not optional — every client now binds and sends the
    // revision(s) it actually inspected (lib/foods/allergen-check-client.ts,
    // lib/foods/label-check-client.ts). A request with none is a stale client that would
    // otherwise let whatever revision happens to be active on arrival be marked, the exact risk
    // finding #6 closed for a ref that HAD one.
    // sol BLOCK (review round 1, finding #5): `expectedRevisions` being DEFINED is not enough —
    // an empty object, or one that omits some of `foodRefIds`, satisfies that check while
    // markLabelChecked's own per-ref fallback (a ref with no expectation given keeps the PRIOR,
    // unchecked behavior — kept permissive there for the few internal callers that genuinely have
    // no revision to bind) marks whichever revision happens to be active on arrival for every ref
    // it has no entry for. This route's own contract, unlike those callers, is that every client
    // now binds every ref it submits — so every foodRefId must have its own entry here, not just
    // the object as a whole.
    if (body.expectedRevisions === undefined
      || body.foodRefIds.some((id) => !(id in body.expectedRevisions!))) {
      throw new HttpError(422, "revision_required",
        "This request must carry the revision you inspected.");
    }
    const result = await markLabelChecked(client, userId, body.foodRefIds,
      body.allergenKeys, body.checked, body.expectedRevisions);
    return Response.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
