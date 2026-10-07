import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ requireUser: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/server/auth", async (actual) => ({
  ...await actual<typeof import("@/lib/server/auth")>(), requireUser: mocked.requireUser,
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: mocked.rate }));

import { GET } from "@/app/api/foods/diet/route";

function client(row: { diet_prefs: Record<string, unknown>; rev: number }) {
  const readEq = vi.fn(() => ({ maybeSingle: async () => ({ data: row, error: null }) }));
  const from = vi.fn(() => ({ select: () => ({ eq: readEq }) }));
  return { from, readEq };
}

beforeEach(() => { mocked.requireUser.mockReset(); mocked.rate.mockReset(); });

describe("diet flags route", () => {
  it("reads only the authenticated account row", async () => {
    const db = client({ diet_prefs: { flags: ["vegan"], text: "gentle" }, rev: 4 });
    mocked.requireUser.mockResolvedValue({ client: db, userId: "account-a" });
    const response = await GET(new Request("http://localhost/api/foods/diet"));
    expect(response.status).toBe(200);
    expect(db.readEq).toHaveBeenCalledWith("user_id", "account-a");
    expect(await response.json()).toMatchObject({ rev: 4, dietPrefs: { flags: ["vegan"] } });
  });

  it("does not expose a second direct settings writer", async () => {
    const route = await import("@/app/api/foods/diet/route");
    expect("PUT" in route).toBe(false);
  });
});
