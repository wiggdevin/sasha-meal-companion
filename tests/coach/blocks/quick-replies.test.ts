import { describe, expect, it } from "vitest";
import { hydrateQuickReplies } from "@/lib/coach/blocks/quick-replies";

describe("quick reply block hydration", () => {
  it("trims, clips, de-duplicates, and removes links and newlines", () => {
    expect(hydrateQuickReplies("quick-1", [
      "  Show me today  ",
      "Show\nme today",
      "https://example.test",
      "Plan tomorrow with a deliberately very long answer suffix",
      "No thanks",
    ])).toEqual({
      kind: "quick_replies",
      v: 1,
      id: "quick-1",
      options: ["Show me today", "Plan tomorrow with a deliberately very l", "No thanks"],
    });
  });

  it("returns no block when sanitising leaves fewer than two choices", () => {
    expect(hydrateQuickReplies("quick-1", ["Same", " same ", "www.example.test"]))
      .toBeNull();
  });
});
