import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()), requireUser: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const { POST } = await import("@/app/api/coach/history-sources/route");
const OWN = "3f1b1a2c-0000-4000-8000-000000000001";
const FOREIGN = "3f1b1a2c-0000-4000-8000-000000000002";
const MSG = "3f1b1a2c-0000-4000-8000-000000000003";
const request = (sources: unknown) => new Request("https://app.test/api/coach/history-sources", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ sources }),
});

function client(content = "I enjoy tofu.") {
  const filters: { table: string; name: string; value: unknown }[] = [];
  const from = (table: string) => {
    const chain = {
      select: () => chain,
      eq: (name: string, value: unknown) => { filters.push({ table, name, value }); return chain; },
      is: (name: string, value: unknown) => { filters.push({ table, name, value }); return chain; },
      in: (name: string, value: unknown) => { filters.push({ table, name, value }); return chain; },
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => Promise.resolve({
        data: table === "coach_threads" ? [{ id: OWN, title: "Food ideas" }] : [{
          id: MSG, thread_id: OWN, seq: 5, role: "user", content,
          created_at: "2026-09-25T14:00:00Z",
        }], error: null,
      }).then(resolve),
    };
    return chain;
  };
  return { value: { from } as never, filters };
}

describe("history citation resolution", () => {
  beforeEach(() => { resetRateLimits(); vi.stubEnv("COACH_ENABLED", "1"); });

  it("returns only an owned chat's saved message with a bounded quote", async () => {
    const db = client();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db.value });
    const response = await POST(request([
      { threadId: OWN, messageId: MSG }, { threadId: FOREIGN, messageId: MSG },
    ]));
    expect(response.status).toBe(200);
    expect((await response.json()).sources).toEqual([{ id: MSG, threadId: OWN, seq: 5,
      role: "user", excerpt: "I enjoy tofu.", createdAt: "2026-09-25T14:00:00Z",
      title: "Food ideas" }]);
    expect(db.filters).toContainEqual({ table: "coach_threads", name: "user_id", value: "u1" });
    expect(db.filters).toContainEqual({ table: "coach_messages", name: "user_id", value: "u1" });
  });

  it("rejects oversized and malformed citation requests", async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: client().value });
    expect((await POST(request([{ threadId: "not-a-uuid", messageId: MSG }]))).status).toBe(400);
    expect((await POST(request(Array.from({ length: 5 }, () => ({
      threadId: OWN, messageId: MSG,
    }))))).status).toBe(400);
  });

  it("shows the exact matched window of a long cited message", async () => {
    const db = client(`avocado ${"unrelated ".repeat(80)}tofu for breakfast`);
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db.value });
    const response = await POST(request([{ threadId: OWN, messageId: MSG,
      matchTerms: ["tofu"] }]));
    const [{ excerpt }] = (await response.json()).sources as { excerpt: string }[];
    expect(excerpt).toContain("tofu for breakfast");
    expect(excerpt).not.toContain("avocado");
  });
});
