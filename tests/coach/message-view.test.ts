import { describe, expect, it } from "vitest";
import { toMessageView } from "@/lib/coach/message-view";

describe("toMessageView", () => {
  it("adds no transport fields to a row without tool_calls", () => {
    const view = toMessageView({
      id: "m3", role: "user", content: "hello", seq: 1,
      created_at: "2026-09-19T16:00:00.000Z",
    });
    expect(view).toEqual({
      id: "m3", role: "user", content: "hello", seq: 1,
      createdAt: "2026-09-19T16:00:00.000Z",
    });
  });
  it("restores bounded saved-history citations for an old assistant message", () => {
    const view = toMessageView({
      id: "reply", role: "assistant", content: "Saved excerpts", seq: 30,
      tool_calls: { historySources: [{ id: "source", threadId: "chat", seq: 2,
        createdAt: "2026-09-20T12:00:00Z", title: "Food ideas" }] },
    });
    expect(view.historySources).toEqual([{ id: "source", threadId: "chat", seq: 2,
      createdAt: "2026-09-20T12:00:00Z", title: "Food ideas" }]);
  });
});
