import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), draft: vi.fn(), confirm: vi.fn(), mark: vi.fn(),
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ admin: true }) }));
// Pantry photo is gated the same way as every other /api/shopping/* route (the shopping-pilot
// allowlist) — mock requireRecipeUser directly rather than requireUser underneath it.
vi.mock("@/lib/server/recipe-access", () => ({ requireRecipeUser: mocks.auth }));
vi.mock("@/lib/server/pantry-photo", () => ({ draftPantryPhoto: mocks.draft, confirmPantryPhoto: mocks.confirm }));
vi.mock("@/lib/server/shopping-rule-marks", () => ({ markShoppingItems: mocks.mark }));

const { POST: draftRoute } = await import("@/app/api/pantry/photo/route");
const { POST: confirmRoute } = await import("@/app/api/pantry/photo/confirm/route");

const userId = "00000000-0000-4000-8000-000000000001";
const json = (body: unknown) => new Request("http://test/api/pantry/photo", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId, client: { fake: true } });
});

describe("POST /api/pantry/photo (draft)", () => {
  it("returns the draft the server built, writing nothing itself", async () => {
    mocks.draft.mockResolvedValue({ items: ["Eggs", "Milk"] });
    const res = await draftRoute(json({ mediaPath: "media/u/x.jpg" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: ["Eggs", "Milk"] });
    expect(mocks.draft).toHaveBeenCalledWith({ admin: true }, userId, "media/u/x.jpg");
  });

  it("maps a provider failure onto its HttpError status", async () => {
    mocks.draft.mockRejectedValue(new HttpError(503, "provider_unavailable", "Try again later."));
    const res = await draftRoute(json({ mediaPath: "media/u/x.jpg" }));
    expect(res.status).toBe(503);
  });

  it("rejects a missing mediaPath before calling the server", async () => {
    const res = await draftRoute(json({}));
    expect(res.status).toBe(400);
    expect(mocks.draft).not.toHaveBeenCalled();
  });
});

describe("POST /api/pantry/photo/confirm", () => {
  it("writes confirmed items with null grams allowed and returns them marked", async () => {
    const written = [{ id: "p1", userId, name: "Eggs", identity: {}, confirmedGrams: null,
      confirmedAt: "2026-10-07T00:00:00Z", revision: 1, source: "photo" as const }];
    mocks.confirm.mockResolvedValue({ written, failed: [] });
    mocks.mark.mockResolvedValue([{ ...written[0], ruleMark: null }]);
    const res = await confirmRoute(json({ requestId: "11111111-1111-4111-8111-111111111111",
      items: [{ name: "Eggs", grams: null }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ name: "Eggs", source: "photo", ruleMark: null });
    expect(body.failed).toEqual([]);
    expect(mocks.confirm).toHaveBeenCalledWith({ fake: true }, userId,
      [{ name: "Eggs", grams: null }], "11111111-1111-4111-8111-111111111111");
  });

  it("reports a per-item failure alongside whatever the batch did write", async () => {
    const written = [{ id: "p1", userId, name: "Eggs", identity: {}, confirmedGrams: null,
      confirmedAt: "2026-10-07T00:00:00Z", revision: 1, source: "photo" as const }];
    const failed = [{ name: "Milk", status: 409, code: "pantry_identity_exists",
      message: "This food is already in your pantry. Reload and edit its confirmed amount." }];
    mocks.confirm.mockResolvedValue({ written, failed });
    mocks.mark.mockResolvedValue([{ ...written[0], ruleMark: null }]);
    const res = await confirmRoute(json({ requestId: "11111111-1111-4111-8111-111111111111",
      items: [{ name: "Eggs", grams: null }, { name: "Milk", grams: 500 }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.failed).toEqual(failed);
  });

  it("rejects an empty item list before calling the server", async () => {
    const res = await confirmRoute(json({ requestId: "11111111-1111-4111-8111-111111111111", items: [] }));
    expect(res.status).toBe(400);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
