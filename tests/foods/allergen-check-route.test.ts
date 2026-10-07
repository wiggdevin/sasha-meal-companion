/**
 * Phase 13 §9 R1, round 10 closing items #2 and #3: POST /api/foods/allergen-check.
 *
 * finding #2: the request itself carries the allergen keys the caller actually inspected — bound
 * client-side when the sheet/card opened (like `expectedRevisions`'s revision) — and the route
 * records a check only for those keys. It never re-reads the account's CURRENT profile: an
 * allergen another tab adds between open and tap must not be marked checked for a label this
 * caller never saw it on.
 *
 * finding #3: `expectedRevisions` is required. A request with none is a stale client that would
 * otherwise let whatever revision is active on arrival be marked — the exact risk finding #6
 * closed for a ref that HAD one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/server/allergen-evidence", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/allergen-evidence")>()),
  markLabelChecked: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const { markLabelChecked } = await import("@/lib/server/allergen-evidence");
const { POST } = await import("@/app/api/foods/allergen-check/route");

const FOOD_REF_ID = "11111111-1111-4111-8111-111111111111";
const FOOD_REF_ID_2 = "22222222-2222-4222-8222-222222222222";

const post = (body: unknown) => new Request("https://app.test/api/foods/allergen-check", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  resetRateLimits();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} as never });
  vi.mocked(markLabelChecked).mockReset().mockResolvedValue(
    { foodKeys: ["catalog_revision:410"], allergens: ["gluten"], stale: [] });
});

describe("POST /api/foods/allergen-check", () => {
  it("records a check only for the request's own allergen keys, never the account's current " +
    "profile (finding #2)", async () => {
    // The account's profile may have grown a new allergen (another tab) between the moment the
    // card/sheet opened and this tap; the request body is the only source of truth for what the
    // caller actually inspected — nothing here reads constraint_profiles.
    const res = await POST(post({
      foodRefIds: [FOOD_REF_ID], checked: true,
      allergenKeys: ["gluten"], expectedRevisions: { [FOOD_REF_ID]: 410 },
    }));
    expect(res.status).toBe(200);
    expect(vi.mocked(markLabelChecked)).toHaveBeenCalledWith(
      expect.anything(), "u1", [FOOD_REF_ID], ["gluten"], true, { [FOOD_REF_ID]: 410 });
  });

  it("refuses 422 when expectedRevisions is missing (finding #3)", async () => {
    const res = await POST(post({
      foodRefIds: [FOOD_REF_ID], checked: true, allergenKeys: ["gluten"],
    }));
    expect(res.status).toBe(422);
    expect(vi.mocked(markLabelChecked)).not.toHaveBeenCalled();
  });

  it("refuses 400 when allergenKeys is missing", async () => {
    const res = await POST(post({
      foodRefIds: [FOOD_REF_ID], checked: true, expectedRevisions: { [FOOD_REF_ID]: 410 },
    }));
    expect(res.status).toBe(400);
    expect(vi.mocked(markLabelChecked)).not.toHaveBeenCalled();
  });

  it("refuses 400 when allergenKeys is empty", async () => {
    const res = await POST(post({
      foodRefIds: [FOOD_REF_ID], checked: true, allergenKeys: [],
      expectedRevisions: { [FOOD_REF_ID]: 410 },
    }));
    expect(res.status).toBe(400);
    expect(vi.mocked(markLabelChecked)).not.toHaveBeenCalled();
  });

  it("sol BLOCK (finding #5, review round 1): refuses 422 when expectedRevisions is an empty " +
    "object — defined, but binds nothing, the same gap as omitting it entirely", async () => {
    const res = await POST(post({
      foodRefIds: [FOOD_REF_ID], checked: true, allergenKeys: ["gluten"], expectedRevisions: {},
    }));
    expect(res.status).toBe(422);
    expect(vi.mocked(markLabelChecked)).not.toHaveBeenCalled();
  });

  it("sol BLOCK (finding #5, review round 1): refuses 422 when a multi-ref request omits the " +
    "expected revision for one of the refs it submits", async () => {
    const res = await POST(post({
      foodRefIds: [FOOD_REF_ID, FOOD_REF_ID_2], checked: true, allergenKeys: ["gluten"],
      // Only the first ref is bound; the second would fall through to markLabelChecked's
      // permissive "no expectation given" behavior and mark whatever revision is active on
      // arrival, never inspected by this caller.
      expectedRevisions: { [FOOD_REF_ID]: 410 },
    }));
    expect(res.status).toBe(422);
    expect(vi.mocked(markLabelChecked)).not.toHaveBeenCalled();
  });

  it("sol FIX (review round 2): accepts a body naming all 40 allergens a profile can actually " +
    "avoid (lib/coach/types.ts's own avoidAllergens schema: `.max(40)`) — this route's own " +
    "`allergenKeys` cap and body-size cap must not be stricter than the profile it is bound to",
    async () => {
      const allergenKeys = Array.from({ length: 40 }, (_, i) => `custom-allergen-${i}`);
      const res = await POST(post({
        foodRefIds: [FOOD_REF_ID], checked: true, allergenKeys,
        expectedRevisions: { [FOOD_REF_ID]: 410 },
      }));
      expect(res.status).toBe(200);
      expect(vi.mocked(markLabelChecked)).toHaveBeenCalledWith(
        expect.anything(), "u1", [FOOD_REF_ID], allergenKeys, true, { [FOOD_REF_ID]: 410 });
    });
});
