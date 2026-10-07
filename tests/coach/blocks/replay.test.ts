import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMessageView } from "@/lib/coach/message-view";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const { GET } = await import("@/app/api/coach/threads/[id]/route");

const legacyMeal = {
  wish: "rice bowl", slot: null, items: [],
  totals: { kcal: 300, protein: 20, carbs: 40, fat: 8 },
  target: { kcal: 300, protein: 20, carbs: 40, fat: 8 },
  flagged: [], fitsTarget: true,
};

describe("toMessageView replay", () => {
  it("drops an unknown block but keeps the readable text", () => {
    const view = toMessageView({
      id: "m1", role: "assistant", content: "Still readable", seq: 2,
      created_at: "2026-09-19T16:00:00.000Z",
      tool_calls: { blocks: [
        { kind: "unknown", v: 1, id: "bad" },
        { kind: "quick_replies", v: 1, id: "good", options: ["Yes", "No"] },
      ] },
    });
    expect(view.content).toBe("Still readable");
    // Only a model's quick_replies tool call makes these chips, so they read back as AI (C8).
    expect(view.blocks).toEqual([{ kind: "quick_replies", v: 1, id: "good",
      options: ["Yes", "No"], provenance: { ai: true, source: "model" } }]);
  });

  it("adapts a legacy single composed card", () => {
    const view = toMessageView({
      id: "m2", role: "assistant", content: "Here it is", seq: 4,
      created_at: "2026-09-19T16:00:00.000Z", tool_calls: { composed: legacyMeal },
    });
    expect(view.composed).toEqual([legacyMeal]);
  });
});

function routeClient() {
  const data: Record<string, Record<string, unknown>[]> = {
    coach_threads: [{ id: "thread-1", user_id: "u1", title: "Chat", kind: "chat",
      last_message_at: "2026-09-19T16:00:00.000Z", deleted_at: null }],
    coach_messages: [{
      id: "m1", thread_id: "thread-1", role: "assistant", content: "Readable", seq: 1,
      created_at: "2026-09-19T16:00:00.000Z",
      tool_calls: { blocks: [{ kind: "future", v: 9, id: "nope" }], composed: legacyMeal },
    }],
  };
  const from = (table: string) => {
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const rows = () => (data[table] ?? []).filter((row) => filters.every((pick) => pick(row)));
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value); return chain;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value); return chain;
      },
      lt: (column: string, value: number) => {
        filters.push((row) => Number(row[column]) < value); return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve),
    });
    return chain;
  };
  return { from } as never;
}

describe("GET /api/coach/threads/[id] replay", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("COACH_ENABLED", "1");
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: routeClient() });
  });

  it("returns CoachMessageView rows, omits unknown blocks, and adapts legacy composed cards", async () => {
    const response = await GET(new Request("https://app.test/api/coach/threads/thread-1"),
      { params: Promise.resolve({ id: "thread-1" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toEqual([{
      id: "m1", role: "assistant", content: "Readable", seq: 1,
      createdAt: "2026-09-19T16:00:00.000Z", composed: [legacyMeal],
    }]);
  });
});
