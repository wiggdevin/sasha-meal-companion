import { describe, expect, it } from "vitest";
import { historySearchTerms, historyExcerpt, historyAnswer, isPastThreadQuestion }
  from "@/lib/coach/history-recall";

describe("explicit history recall", () => {
  it("recognizes a past-chat question without diverting meal planning or edits", () => {
    expect(isPastThreadQuestion("What was my breakfast idea?")).toBe(true);
    expect(isPastThreadQuestion("What did I say about breakfast earlier?")).toBe(true);
    expect(isPastThreadQuestion("What should I eat for breakfast?")).toBe(false);
    expect(isPastThreadQuestion("What was my breakfast plan?")).toBe(false);
    expect(isPastThreadQuestion("Please change my breakfast plan")).toBe(false);
    expect(isPastThreadQuestion("What did I say about breakfast? Change my plan to toast."))
      .toBe(false);
    expect(isPastThreadQuestion("What was my breakfast idea, and log it today?"))
      .toBe(false);
    expect(isPastThreadQuestion("What did I say about breakfast and mark it eaten?"))
      .toBe(false);
    expect(isPastThreadQuestion("What did I say about lunch and swap it?"))
      .toBe(false);
  });
  it("removes question filler and searches useful terms across old messages", () => {
    expect(historySearchTerms("What did I discuss about tofu for breakfast in the other chat?"))
      .toBe("tofu OR breakfast");
    expect(historySearchTerms("What did we talk about? ")).toBeNull();
    expect(historySearchTerms("x".repeat(41))).toBeNull();
  });

  it("bounds a saved quote without manufacturing a synthesis", () => {
    const long = "protein ".repeat(150);
    expect(historyExcerpt(long).length).toBeLessThanOrEqual(303);
    expect(historyExcerpt(long)).toMatch(/…$/);
    const deep = `${"unrelated ".repeat(80)}tofu is my choice for breakfast.`;
    expect(historyExcerpt(deep, ["tofu"])).toContain("tofu is my choice");
    const answer = historyAnswer("Food ideas", [{
      id: "m1", threadId: "t1", seq: 91, role: "user", content: "I prefer tofu at lunch.",
      createdAt: "2026-09-25T14:00:00Z",
    }]);
    expect(answer).toContain("Food ideas");
    expect(answer).toContain("I prefer tofu at lunch.");
    expect(answer).toContain("Sep 25, 2026");
    expect(answer).toContain("saved excerpts");
  });
});
