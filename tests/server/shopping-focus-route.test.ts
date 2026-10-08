/**
 * Phase 18 W11 (docs/specs/phase-18-open-world-foods.md §W11): the focus routes. Acceptance 4 (an
 * account without shopping access gets a clear refusal and no write), and Sol W11 r1 BLOCK 3/4: no
 * request field carries a timestamp (an `exact` body is refused), and Undo sends only the write's
 * action id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), day: vi.fn(), state: vi.fn(), set: vi.fn(), undo: vi.fn(), resolve: vi.fn(),
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/server/recipe-access", () => ({ requireRecipeUser: mocks.auth }));
vi.mock("@/lib/server/shopping-focus", () => ({
  focusDay: mocks.day, readShoppingFocusState: mocks.state, setShoppingFocus: mocks.set,
  undoShoppingFocus: mocks.undo, resolveFocusEnd: mocks.resolve,
}));

const { GET, POST } = await import("@/app/api/shopping/focus/route");
const { POST: UNDO } = await import("@/app/api/shopping/focus/undo/route");

const userId = "00000000-0000-4000-8000-000000000001";
const actionId = "00000000-0000-4000-8000-0000000000a1";
const DAY = { date: "2026-10-05", zone: "America/Los_Angeles" };
const req = (body?: unknown, url = "http://test/api/shopping/focus") => new Request(url,
  body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId, client: { fake: true } });
  mocks.day.mockResolvedValue(DAY);
});

describe("W11 acceptance 4: no shopping access", () => {
  for (const [name, call] of [
    ["GET", () => GET(req())],
    ["POST", () => POST(req({ on: true }))],
    ["undo", () => UNDO(req({ actionId }, "http://test/api/shopping/focus/undo"))],
  ] as const) {
    it(`${name} refuses before reading or writing anything`, async () => {
      mocks.auth.mockRejectedValue(new HttpError(404, "recipe_pilot_unavailable", "Not available."));
      const res = await call();
      expect(res.status).toBe(404);
      for (const fn of [mocks.state, mocks.set, mocks.undo, mocks.resolve]) expect(fn).not.toHaveBeenCalled();
    });
  }
});

describe("POST /api/shopping/focus", () => {
  it("turns focus on with the server-decided end on the account's day", async () => {
    mocks.resolve.mockResolvedValue("2026-10-10T06:59:59.999Z");
    mocks.set.mockResolvedValue({ actionId, until: "2026-10-10T06:59:59.999Z", previous: null });
    const res = await POST(req({ on: true, date: "2026-10-05", zone: "America/Los_Angeles" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actionId, until: "2026-10-10T06:59:59.999Z", previous: null });
    expect(mocks.day).toHaveBeenCalledWith({ fake: true }, userId,
      { clientDay: "2026-10-05", requestZone: "America/Los_Angeles" }, expect.any(Date));
    expect(mocks.resolve).toHaveBeenCalledWith({ fake: true }, userId, expect.any(Date), DAY, undefined);
    expect(mocks.set).toHaveBeenCalledWith(userId, "2026-10-10T06:59:59.999Z");
  });

  it("turns focus off, writing null and never resolving an end", async () => {
    mocks.set.mockResolvedValue({ actionId, until: null, previous: "2026-10-09T00:00:00.000Z" });
    const res = await POST(req({ on: false }));
    expect(res.status).toBe(200);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledWith(userId, null);
  });

  it("refuses any timestamp field: `exact` is gone from the public route", async () => {
    for (const body of [{ on: true, exact: "2026-10-09T00:00:00.000Z" }, { on: false, exact: null },
      { on: true, until: "2099-01-01T00:00:00.000Z" }]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
    }
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("rejects a malformed body before calling anything", async () => {
    expect((await POST(req({ on: "yes" }))).status).toBe(400);
    expect((await POST(req({ on: true, days: 32 }))).status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});

describe("POST /api/shopping/focus/undo", () => {
  const undoReq = (body: unknown) => req(body, "http://test/api/shopping/focus/undo");

  it("undoes by the action id alone", async () => {
    mocks.undo.mockResolvedValue({ status: "undone", until: null });
    const res = await UNDO(undoReq({ actionId }));
    expect(await res.json()).toEqual({ status: "undone", until: null });
    expect(mocks.undo).toHaveBeenCalledWith(userId, actionId);
  });

  it("passes a superseded answer through: a later choice is never overwritten", async () => {
    mocks.undo.mockResolvedValue({ status: "superseded", until: "2026-10-20T00:00:00.000Z" });
    const res = await UNDO(undoReq({ actionId }));
    expect(await res.json()).toEqual({ status: "superseded", until: "2026-10-20T00:00:00.000Z" });
  });

  it("refuses a timestamp or a malformed id", async () => {
    expect((await UNDO(undoReq({ actionId, exact: null }))).status).toBe(400);
    expect((await UNDO(undoReq({ actionId: "nope" }))).status).toBe(400);
    expect(mocks.undo).not.toHaveBeenCalled();
  });
});

describe("GET /api/shopping/focus", () => {
  it("answers the end, whether it is active, and the dated keys", async () => {
    const keys = [{ key: "rice", from: "2026-10-01", to: "2026-10-07" }];
    mocks.state.mockResolvedValue({ until: "2099-01-01T00:00:00.000Z", keys });
    const on = await GET(req(undefined, "http://test/api/shopping/focus?date=2026-10-05&zone=UTC"));
    expect(await on.json()).toEqual({ until: "2099-01-01T00:00:00.000Z", active: true, keys });
    expect(mocks.day).toHaveBeenCalledWith({ fake: true }, userId,
      { clientDay: "2026-10-05", requestZone: "UTC" }, expect.any(Date));

    mocks.state.mockResolvedValue({ until: null, keys: [] });
    const off = await GET(req());
    expect(await off.json()).toEqual({ until: null, active: false, keys: [] });
  });
});
