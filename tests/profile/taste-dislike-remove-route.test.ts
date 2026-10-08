/**
 * Followups #1: `POST /api/profile/taste/dislikes/remove` and its `/undo`, at the route edge, with
 * the session client's RPC mocked. Not gated by `TASTE_CHIPS_ENABLED` (a dislike pill can already
 * exist from the sync path with chips off) — the dark-flag behaviour tested on
 * tests/profile/taste-confirm-route.test.ts does not apply here.
 *
 * - The request shape is strict: a canonical dislike key only, a uuid action id.
 * - Only the caller's session client and own user id reach the RPC; each database answer maps to
 *   its documented status; a malformed-request refusal (22023) is a 400 and any other failure a 502.
 * - No log line in this path ever includes the dislike key (checked against a console.error spy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const remove = await import("@/app/api/profile/taste/dislikes/remove/route");
const undo = await import("@/app/api/profile/taste/dislikes/remove/undo/route");

const rpc = vi.fn();
const ACTION = "6f1c2f0e-4b7a-4a8e-9d2b-0c7d5e2a9b11";
const ROW = { user_id: "u1", rev: 7, cuisines: ["korean"], diet_prefs: { taste: { dislikes: [] } } };

function post(path: string, body: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const removePost = (body: unknown) => remove.POST(post("/api/profile/taste/dislikes/remove", body));
const undoPost = (body: unknown) => undo.POST(post("/api/profile/taste/dislikes/remove/undo", body));
const valid = { actionId: ACTION, key: "t:soft" };

beforeEach(() => {
  resetRateLimits();
  rpc.mockReset();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: { rpc } as never });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the remove request shape", () => {
  const bad: [string, unknown][] = [
    ["not a uuid", { ...valid, actionId: "tap-1" }],
    ["non-canonical family", { ...valid, key: "f:Okra" }],
    ["unknown tag", { ...valid, key: "t:nope" }],
    ["unknown field", { ...valid, keys: ["t:soft"] }],
    ["missing key", { actionId: ACTION }],
  ];
  it.each(bad)("refuses %s with 400 and no RPC", async (_, body) => {
    const response = await removePost(body);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("bad_request");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("remove", () => {
  it("sends the caller's own id, the action id and the key, and answers removed and the row", async () => {
    rpc.mockResolvedValue({ data: { status: "removed", action_id: ACTION, key: "t:soft", settings: ROW }, error: null });
    const response = await removePost(valid);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpc).toHaveBeenCalledWith("taste_dislike_remove", { p_user_id: "u1", p_action_id: ACTION, p_key: "t:soft" });
    expect(await response.json()).toEqual({ status: "removed", actionId: ACTION, key: "t:soft", settings: ROW });
  });

  it("answers already_gone when the key was not on the row", async () => {
    rpc.mockResolvedValue({ data: { status: "already_gone", action_id: ACTION, key: "t:soft", settings: ROW }, error: null });
    const body = await (await removePost(valid)).json();
    expect(body).toMatchObject({ status: "already_gone" });
  });

  it("answers a repeat (existing) the same way, without acting again", async () => {
    rpc.mockResolvedValue({ data: { status: "existing", action_id: ACTION, key: "t:soft", settings: ROW }, error: null });
    const body = await (await removePost(valid)).json();
    expect(body).toMatchObject({ status: "existing" });
  });

  const refusals: [string, number, string][] = [
    ["action_conflict", 409, "action_conflict"],
    ["settings_not_synced", 409, "settings_not_synced"],
    ["settings_unreadable", 409, "settings_unreadable"],
  ];
  it.each(refusals)("maps %s to %i", async (status, code, error) => {
    rpc.mockResolvedValue({ data: { status }, error: null });
    const response = await removePost(valid);
    expect(response.status).toBe(code);
    expect((await response.json()).error).toBe(error);
  });

  it("a 22023 refusal is the caller's 400; any other failure is a 502", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "bad_key" } });
    expect((await removePost(valid)).status).toBe(400);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "40P01", message: "deadlock" } });
    const failed = await removePost(valid);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("taste_dislike_remove_failed");
    rpc.mockResolvedValueOnce({ data: { status: "removed" }, error: null }); // no key, no settings
    expect((await removePost(valid)).status).toBe(502);
  });

  it("never logs the dislike key, even on a 5xx", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValueOnce({ data: null, error: { code: "40P01", message: "deadlock" } });
    await removePost(valid);
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("t:soft");
    }
  });
});

describe("undo", () => {
  it("sends only the caller's id and the action id, and answers the restore outcome", async () => {
    rpc.mockResolvedValue({ data: { status: "undone", action_id: ACTION, key: "t:soft", restored: true,
      capped: false, settings: ROW }, error: null });
    const response = await undoPost({ actionId: ACTION });
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("taste_dislike_remove_undo", { p_user_id: "u1", p_action_id: ACTION });
    expect(await response.json()).toEqual({ status: "undone", actionId: ACTION, key: "t:soft",
      restored: true, capped: false, settings: ROW });
  });

  it("reports capped when the cap was hit by something else since the remove", async () => {
    rpc.mockResolvedValue({ data: { status: "undone", action_id: ACTION, key: "t:soft", restored: false,
      capped: true, settings: ROW }, error: null });
    const body = await (await undoPost({ actionId: ACTION })).json();
    expect(body).toMatchObject({ restored: false, capped: true });
  });

  it("answers 404 unknown_action for no receipt and 400 for a malformed body", async () => {
    rpc.mockResolvedValue({ data: { status: "not_found" }, error: null });
    const missing = await undoPost({ actionId: ACTION });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("unknown_action");
    expect((await undoPost({ actionId: "x" })).status).toBe(400);
    expect((await undoPost({ actionId: ACTION, key: "t:soft" })).status).toBe(400);
  });

  it("already_undone answers the first Undo's own values, writing nothing further", async () => {
    rpc.mockResolvedValue({ data: { status: "already_undone", action_id: ACTION, key: "t:soft",
      restored: true, capped: false, settings: ROW }, error: null });
    const body = await (await undoPost({ actionId: ACTION })).json();
    expect(body).toMatchObject({ status: "already_undone", restored: true });
  });
});
