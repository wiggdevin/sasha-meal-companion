import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { eligibleFoods } from "@/lib/server/eligible-foods";
import { mealSnapshot } from "@/lib/server/meal-snapshot";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { GET } from "@/app/api/foods/eligible/route";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/eligible-foods", () => ({ eligibleFoods: vi.fn() }));
vi.mock("@/lib/server/meal-snapshot", () => ({ mealSnapshot: vi.fn() }));

const V1 = { eligibleRefIds: ["r"], eligibleFoodIds: [], eligibleCatalogFoodIds: [], excluded: [], rulesRevision: 2 };

beforeEach(() => {
  resetRateLimits();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} } as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(eligibleFoods).mockResolvedValue(V1);
  vi.mocked(mealSnapshot).mockResolvedValue({ schemaVersion: 2, accountId: "u1" } as Awaited<ReturnType<typeof mealSnapshot>>);
});

describe("GET /api/foods/eligible", () => {
  it("answers v1 unchanged when no version is asked for (old clients)", async () => {
    const res = await GET(new Request("http://x/api/foods/eligible"));
    expect(await res.json()).toEqual(V1);
    expect(mealSnapshot).not.toHaveBeenCalled();
  });

  it("answers the snapshot for ?v=2, for the caller's own account", async () => {
    const res = await GET(new Request("http://x/api/foods/eligible?v=2"));
    expect(await res.json()).toEqual({ schemaVersion: 2, accountId: "u1" });
    expect(mealSnapshot).toHaveBeenCalledWith({}, "u1");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
