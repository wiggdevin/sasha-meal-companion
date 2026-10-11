import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

const removed: string[] = [];
vi.mock("@/lib/server/media", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/media")>()),
  deleteMedia: vi.fn(async (_admin: unknown, path: string) => { removed.push(path); }),
}));
const OLD = "media/u1/11111111-1111-4111-8111-111111111111.jpg";
const rows = vi.hoisted(() => [] as { path: string; user_id: string }[]);
const nullFilters = vi.hoisted(() => new Set<string>());
const selects = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({
  from: () => ({ select: (columns: string) => {
    selects.push(columns);
    let after: string | null = null;
    const chain = {
      is: (column: string, value: unknown) => {
        if (value === null) nullFilters.add(column);
        return chain;
      },
      lt: () => chain, order: () => chain,
      gt: (_key: string, value: string) => { after = value; return chain; },
      range: async (start: number, end: number) => ({
        data: rows.filter((r) => after === null || r.path > after).slice(start, end + 1),
        error: null }),
    };
    return chain;
  } }),
  rpc: async () => ({ error: null }),
}) }));

import { GET, POST } from "@/app/api/jobs/media-sweep/route";

function req(method: "GET" | "POST", token?: string): Request {
  return new Request("https://a.test/api/jobs/media-sweep", {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  resetRateLimits(); removed.length = 0; vi.stubEnv("CRON_SECRET", "s3cret");
  rows.splice(0, rows.length, { path: OLD, user_id: "u1" });
});

describe("GET /api/jobs/media-sweep", () => {
  it.each([undefined, "wrong"])("401s on a missing or wrong bearer (%s) and sweeps nothing", async (token) => {
    expect((await GET(req("GET", token))).status).toBe(401);
    expect(removed).toEqual([]);
  });

  it("runs the same sweep and returns the same response as POST", async () => {
    const post = await POST(req("POST", "s3cret"));
    const postBody = await post.json();
    removed.length = 0;

    const get = await GET(req("GET", "s3cret"));
    expect(get.status).toBe(post.status);
    expect(await get.json()).toEqual(postBody);
    expect(removed).toEqual([OLD]);
  });

  it("lists only unattached, untombstoned drafts: never a row linked to a log entry", async () => {
    nullFilters.clear();
    await POST(req("POST", "s3cret"));
    expect([...nullFilters].sort()).toEqual(["deleted_at", "entry_id"]);
  });

  it("keeps going past the old 500-object cap, page after page, in one run (S3)", async () => {
    const many = Array.from({ length: 2_345 }, (_, i) => ({
      path: `media/u1/00000000-0000-4000-8000-${String(i).padStart(12, "0")}.jpg`, user_id: "u1" }));
    rows.splice(0, rows.length, ...many);
    try {
      const res = await POST(req("POST", "s3cret"));
      expect(await res.json()).toEqual({ swept: 2_345, failed: 0 });
      expect([...removed].sort()).toEqual(many.map((r) => r.path));
    } finally {
      rows.splice(0, rows.length, { path: OLD, user_id: "u1" });
    }
  });

  it("never deletes a path outside the row owner's own folder (P08)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const foreign = [
      { path: "media/u2/22222222-2222-4222-8222-222222222222.jpg", user_id: "u1" },
      { path: "media/u1/../u2/22222222-2222-4222-8222-222222222222.jpg", user_id: "u1" },
      { path: "u2/22222222-2222-4222-8222-222222222222.jpg", user_id: "u2" },
    ];
    rows.push(...foreign);
    try {
      const res = await POST(req("POST", "s3cret"));
      expect(await res.json()).toEqual({ swept: 1, failed: 0, skipped: 3 });
      expect(removed).toEqual([OLD]);
      expect(selects.at(-1)?.split(",").map((c) => c.trim())).toEqual(["path", "user_id"]);
      expect(spy).toHaveBeenCalledWith("media sweep skipped a path outside its owner's folder",
        expect.objectContaining({ userId: "u1" }));
    } finally {
      spy.mockRestore();
    }
  });
});
