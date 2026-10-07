/**
 * Phase 18 W5b-2: `POST /api/profile/taste/confirm` and `POST /api/profile/taste/undo` at the route
 * edge, with the session client's RPC mocked. The database behaviour itself (locks, caps, receipts,
 * repeats, Undo) is proven against Postgres in tests/migrations/taste-chips-confirm-db.test.ts.
 *
 * - Dark: 404 `not_enabled` while TASTE_CHIPS_ENABLED is unset, and no RPC is called.
 * - The request shape is strict: canonical dislikes only, vocabulary cuisines, no repeats, at least
 *   one chip, `coach` exactly with `source: "coach"`, a uuid action id.
 * - Only the caller's session client and own user id reach the RPC; each database answer maps to its
 *   documented status; a malformed-request refusal (22023) is a 400 and any other failure a 502.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const confirm = await import("@/app/api/profile/taste/confirm/route");
const undo = await import("@/app/api/profile/taste/undo/route");

const rpc = vi.fn();
const ACTION = "6f1c2f0e-4b7a-4a8e-9d2b-0c7d5e2a9b11";
const MESSAGE = "0b9f8a77-3c1d-4e2f-8a6b-5d4c3b2a1f00";
const ROW = { user_id: "u1", rev: 7, cuisines: ["korean"], diet_prefs: { taste: { dislikes: ["t:soft"] } } };

function post(path: string, body: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const confirmPost = (body: unknown) => confirm.POST(post("/api/profile/taste/confirm", body));
const undoPost = (body: unknown) => undo.POST(post("/api/profile/taste/undo", body));
const valid = { actionId: ACTION, source: "settings", dislikes: ["t:soft"], cuisines: ["korean"] };

beforeEach(() => {
  vi.stubEnv("TASTE_CHIPS_ENABLED", "1");
  resetRateLimits();
  rpc.mockReset();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: { rpc } as never });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("dark until TASTE_CHIPS_ENABLED", () => {
  it("answers 404 not_enabled on both routes and calls no RPC", async () => {
    vi.stubEnv("TASTE_CHIPS_ENABLED", "");
    for (const response of [await confirmPost(valid), await undoPost({ actionId: ACTION })]) {
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe("not_enabled");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the confirm request shape", () => {
  const bad: [string, unknown][] = [
    ["not a uuid", { ...valid, actionId: "tap-1" }],
    ["non-canonical family", { ...valid, dislikes: ["f:Okra"] }],
    ["unknown tag", { ...valid, dislikes: ["t:nope"] }],
    ["unknown cuisine", { ...valid, cuisines: ["martian"] }],
    ["repeated dislike", { ...valid, dislikes: ["t:soft", "t:soft"] }],
    ["repeated cuisine", { ...valid, cuisines: ["korean", "korean"] }],
    ["seventh cuisine", { ...valid, cuisines: ["american", "italian", "korean", "chinese", "japanese", "african", "caribbean"] }],
    ["51 dislikes", { ...valid, dislikes: Array.from({ length: 51 }, (_, i) => `f:food${i}`) }],
    ["no chip", { ...valid, dislikes: [], cuisines: [] }],
    ["coach without card", { ...valid, source: "coach" }],
    ["card without coach source", { ...valid, coach: { messageId: MESSAGE, proposalId: "p1" } }],
    ["bad message id", { ...valid, source: "coach", coach: { messageId: "m1", proposalId: "p1" } }],
    ["unknown field", { ...valid, likes: ["f:salmon"] }],
    ["unknown source", { ...valid, source: "jev" }],
  ];
  it.each(bad)("refuses %s with 400 and no RPC", async (_, body) => {
    const response = await confirmPost(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("bad_request");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("confirm", () => {
  it("sends the caller's own id and the request, and answers the receipt and the row", async () => {
    rpc.mockResolvedValue({ data: { status: "applied", action_id: ACTION,
      added: { dislikes: [], cuisines: ["korean"] }, present: { dislikes: ["t:soft"], cuisines: [] },
      capped: { dislikes: [], cuisines: [] }, undone_at: null, settings: ROW }, error: null });
    const response = await confirmPost({ ...valid, source: "coach", coach: { messageId: MESSAGE, proposalId: "p1" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpc).toHaveBeenCalledWith("taste_chips_confirm", {
      p_user_id: "u1", p_action_id: ACTION, p_source: "coach", p_dislikes: ["t:soft"], p_cuisines: ["korean"],
      p_coach: { messageId: MESSAGE, proposalId: "p1" },
    });
    expect(await response.json()).toEqual({ status: "applied", actionId: ACTION,
      added: { dislikes: [], cuisines: ["korean"] }, present: { dislikes: ["t:soft"], cuisines: [] },
      capped: { dislikes: [], cuisines: [] }, undoneAt: null, settings: ROW });
  });

  it("answers a repeat (existing) the same way", async () => {
    rpc.mockResolvedValue({ data: { status: "existing", action_id: ACTION, added: { dislikes: ["t:soft"], cuisines: [] },
      present: { dislikes: [], cuisines: [] }, capped: { dislikes: [], cuisines: [] }, undone_at: null,
      settings: ROW }, error: null });
    const body = await (await confirmPost(valid)).json();
    expect(body).toMatchObject({ status: "existing", added: { dislikes: ["t:soft"], cuisines: [] } });
  });

  const refusals: [string, number, string][] = [
    ["action_conflict", 409, "action_conflict"],
    ["settings_not_synced", 409, "settings_not_synced"],
    ["settings_unreadable", 409, "settings_unreadable"],
    ["unknown_proposal", 404, "unknown_proposal"],
    ["chip_not_proposed", 422, "chip_not_proposed"],
  ];
  it.each(refusals)("maps %s to %i", async (status, code, error) => {
    rpc.mockResolvedValue({ data: { status }, error: null });
    const response = await confirmPost(valid);
    expect(response.status).toBe(code);
    expect((await response.json()).error).toBe(error);
  });

  it("a 22023 refusal is the caller's 400; any other failure is a 502", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "bad_chips" } });
    expect((await confirmPost(valid)).status).toBe(400);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "40P01", message: "deadlock" } });
    const failed = await confirmPost(valid);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("taste_confirm_failed");
    rpc.mockResolvedValueOnce({ data: { status: "applied" }, error: null });
    expect((await confirmPost(valid)).status).toBe(502);
  });
});

describe("undo", () => {
  it("sends only the caller's id and the action id, and answers removed and gone", async () => {
    rpc.mockResolvedValue({ data: { status: "undone", action_id: ACTION, undone_at: "2026-10-06T00:00:00Z",
      removed: { dislikes: ["t:bitter"], cuisines: [] }, gone: { dislikes: ["t:soft"], cuisines: [] },
      settings: ROW }, error: null });
    const response = await undoPost({ actionId: ACTION });
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("taste_chips_undo", { p_user_id: "u1", p_action_id: ACTION });
    expect(await response.json()).toEqual({ status: "undone", actionId: ACTION, undoneAt: "2026-10-06T00:00:00Z",
      removed: { dislikes: ["t:bitter"], cuisines: [] }, gone: { dislikes: ["t:soft"], cuisines: [] }, settings: ROW });
  });

  it("answers 404 unknown_action for no receipt and 400 for a malformed body", async () => {
    rpc.mockResolvedValue({ data: { status: "not_found" }, error: null });
    const missing = await undoPost({ actionId: ACTION });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("unknown_action");
    expect((await undoPost({ actionId: "x" })).status).toBe(400);
    expect((await undoPost({ actionId: ACTION, keys: ["t:soft"] })).status).toBe(400);
  });
});
