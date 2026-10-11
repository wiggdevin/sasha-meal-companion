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
const PATH = `media/${userId}/3f1b1a2c-0000-4000-8000-000000000030.jpg`;
const json = (body: unknown) => new Request("http://test/api/pantry/photo", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId, client: { fake: true } });
});

describe("POST /api/pantry/photo (draft)", () => {
  it("returns the draft the server built, writing nothing itself", async () => {
    mocks.draft.mockResolvedValue({ items: ["Eggs", "Milk"] });
    const res = await draftRoute(json({ mediaPath: PATH }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: ["Eggs", "Milk"] });
    expect(mocks.draft).toHaveBeenCalledWith({ admin: true }, userId, PATH);
  });

  it("maps a provider failure onto its HttpError status", async () => {
    mocks.draft.mockRejectedValue(new HttpError(503, "provider_unavailable", "Try again later."));
    const res = await draftRoute(json({ mediaPath: PATH }));
    expect(res.status).toBe(503);
  });

  it("rejects a traversal or malformed mediaPath before calling the server (A099)", async () => {
    for (const mediaPath of [`media/${userId}/../aaaaaaaa-0000-4000-8000-00000000000a/x.jpg`,
      `${userId}/3f1b1a2c-0000-4000-8000-000000000030.jpg`, "media/u/x.jpg"]) {
      const res = await draftRoute(json({ mediaPath }));
      expect(res.status, mediaPath).toBe(400);
    }
    expect(mocks.draft).not.toHaveBeenCalled();
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

  // Followups #21: the route's MAX_BYTES was raised from 4 KB to 48 KB; the item caps (40 items,
  // 160-char names) are unchanged. The worst-case encoded body — 40 items at the 160-char name
  // limit, each with a gram amount — must fit under 48 KB and be accepted (not 413), and padding
  // it past 48 KB must still be refused.
  it("accepts the largest encoded body (40 items x 160-char names) under the new 48 KB ceiling", async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ name: "x".repeat(160), grams: 123.5 + i }));
    const body = { requestId: "11111111-1111-4111-8111-111111111111", items };
    const encodedBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    expect(encodedBytes).toBeLessThan(48 * 1024);

    const written = items.map((item, i) => ({ id: `p${i}`, userId, name: item.name, identity: {},
      confirmedGrams: item.grams, confirmedAt: "2026-10-07T00:00:00Z", revision: 1, source: "photo" as const }));
    mocks.confirm.mockResolvedValue({ written, failed: [] });
    mocks.mark.mockResolvedValue(written.map((w) => ({ ...w, ruleMark: null })));

    const res = await confirmRoute(json(body));
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.items).toHaveLength(40);
  });

  it("still rejects a body padded past the new 48 KB ceiling", async () => {
    const items = Array.from({ length: 40 }, () => ({ name: "x".repeat(160), grams: 1,
      // Padding field the Zod shape doesn't know about -- oversized body, same 413 the old 4 KB
      // ceiling answered, just at the new size.
      note: "y".repeat(2000) }));
    const body = { requestId: "11111111-1111-4111-8111-111111111111", items };
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(48 * 1024);
    const res = await confirmRoute(json(body));
    expect(res.status).toBe(413);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
