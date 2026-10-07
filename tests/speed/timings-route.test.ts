/**
 * T0 §1 — POST /api/timings. JWT, 8 KB, 60/min, and nothing privileged: the rows are inserted
 * with HER client, so `client_timings`' insert policy is what keeps one account's marks out of
 * another's, not a check in this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { POST as timings } from "@/app/api/timings/route";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));

const user = vi.mocked(requireUser);

type Insert = { table: string; rows: unknown };

function fakeClient() {
  const inserts: Insert[] = [];
  const client = {
    from: (table: string) => ({
      insert: async (rows: unknown) => { inserts.push({ table, rows }); return { error: null }; },
    }),
  };
  return { client, inserts };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://a.test/api/timings", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1", ...headers },
  });
}

const ROW = {
  run_id: "9f1d2f7a-0c6e-4a1e-9d3b-1c2f5d8a7b10", path: "barcode", step: "decode",
  ms: 120, at: "2026-09-17T12:00:00.000Z", device: "iPhone",
};

beforeEach(() => {
  resetRateLimits();
  user.mockReset();
});

describe("POST /api/timings", () => {
  it("writes one row per step, stamped with the caller's own id", async () => {
    const { client, inserts } = fakeClient();
    user.mockResolvedValue({ userId: "u1", client: client as never });
    const res = await timings(post({ rows: [ROW, { ...ROW, step: "lookup", ms: 280 }] }));
    expect(res.status).toBe(202);
    expect(inserts[0].table).toBe("client_timings");
    expect(inserts[0].rows).toEqual([
      { user_id: "u1", run_id: ROW.run_id, path: "barcode", step: "decode", ms: 120,
        at: ROW.at, device: "iPhone" },
      { user_id: "u1", run_id: ROW.run_id, path: "barcode", step: "lookup", ms: 280,
        at: ROW.at, device: "iPhone" },
    ]);
  });

  it("never takes a user_id from the body", async () => {
    const { client, inserts } = fakeClient();
    user.mockResolvedValue({ userId: "u1", client: client as never });
    await timings(post({ rows: [{ ...ROW, user_id: "u2" }] }));
    expect((inserts[0].rows as { user_id: string }[])[0].user_id).toBe("u1");
  });

  it("401s with no session, before any write", async () => {
    user.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    expect((await timings(post({ rows: [ROW] }))).status).toBe(401);
  });

  it("400s a path or a step outside the spec's vocabulary", async () => {
    const { client } = fakeClient();
    user.mockResolvedValue({ userId: "u1", client: client as never });
    expect((await timings(post({ rows: [{ ...ROW, path: "everything" }] }))).status).toBe(400);
    expect((await timings(post({ rows: [{ ...ROW, step: "vibes" }] }))).status).toBe(400);
  });

  it("400s an empty batch, and refuses a batch past 8 KB before parsing it", async () => {
    const { client } = fakeClient();
    user.mockResolvedValue({ userId: "u1", client: client as never });
    expect((await timings(post({ rows: [] }))).status).toBe(400);
    // The 8 KB body guard is the one that bites first on a firehose — a row of this shape is
    // ~120 bytes, so 201 of them is 24 KB and never reaches the 200-row ceiling behind it.
    expect((await timings(post({ rows: Array(201).fill(ROW) }))).status).toBe(413);
  });

  it("answers 202 even when the insert fails — a lost mark is not her problem", async () => {
    const client = { from: () => ({ insert: async () => ({ error: { message: "boom" } }) }) };
    user.mockResolvedValue({ userId: "u1", client: client as never });
    expect((await timings(post({ rows: [ROW] }))).status).toBe(202);
  });

  it("holds the caller to 60 posts a minute", async () => {
    const { client } = fakeClient();
    user.mockResolvedValue({ userId: "u1", client: client as never });
    let last = 202;
    for (let i = 0; i < 62; i += 1) last = (await timings(post({ rows: [ROW] }))).status;
    expect(last).toBe(429);
  });
});
