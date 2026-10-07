import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const { GET, PUT } = await import("@/app/api/constraints/route");

const ROW = {
  user_id: "u1", rev: 3, conditions: ["ulcerative colitis"], notes: null,
  avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
  banned_categories: ["simple_sugars"], custom_rules: [],
};

/** The shapes lib/server/constraints.ts uses: a maybeSingle read and an update…select. */
function fakeClient() {
  return {
    from() {
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: ROW, error: null }),
        update(next: Record<string, unknown>) {
          applied.push(next);
          return { eq: () => chain2, select: () => chain2 };
        },
      };
      const chain2 = {
        eq: () => chain2, select: () => chain2,
        maybeSingle: async () => ({ data: { ...ROW, ...(applied.at(-1) ?? {}) }, error: null }),
      };
      return chain;
    },
  } as never;
}

let applied: Record<string, unknown>[] = [];

const put = (b: unknown) => new Request("https://app.test/api/constraints",
  { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

describe("/api/constraints", () => {
  beforeEach(() => {
    resetRateLimits();
    applied = [];
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: fakeClient() });
  });

  it("answers 409 with the current value when baseRev is stale", async () => {
    const res = await PUT(put({ baseRev: 2, conditions: ["ulcerative colitis"] }));
    expect(res.status).toBe(409);
    expect((await res.json()).value).toMatchObject({ conditions: ["ulcerative colitis"] });
  });

  // D1 §6.1: the rules belong to the account, so the route has no list of its own to defend and
  // 422 floor_violation is gone. Dropping an allergen is an ordinary accepted change.
  it("accepts dropping any allergen, including one the old floor locked", async () => {
    const res = await PUT(put({ baseRev: 3, avoidAllergens: ["gluten", "apple"] }));
    expect(res.status).toBe(200);
    expect(applied.at(-1)).toMatchObject({ avoid_allergens: ["gluten", "apple"], rev: 4 });
  });

  it("answers 401 with no session", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    const res = await GET(new Request("https://app.test/api/constraints"));
    expect(res.status).toBe(401);
  });
});
