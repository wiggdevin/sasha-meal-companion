import { describe, expect, it } from "vitest";
import type { CoachTurnResponse } from "@/lib/coach/types";
import { coachTurnRequestSchema, SLOT_IDS } from "@/lib/coach/types";

describe("coachTurnRequestSchema", () => {
  it("accepts only a real meal slot for a structured Plan-sheet request", () => {
    const base = { threadId: null,
      messageId: "3f1b1a2c-0000-4000-8000-000000000010", text: "Suggest meal options" };
    expect(coachTurnRequestSchema.safeParse({ ...base, planningSlot: "meal-4" }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, planningSlot: "coffee" }).success).toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, planningSlot: "meal-7" }).success).toBe(false);
  });
  it("accepts a first turn with a null threadId", () => {
    const parsed = coachTurnRequestSchema.safeParse({
      threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000001", text: "what should I eat",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a deliberate history source but never combines it with Plan or an attachment", () => {
    const base = { threadId: null,
      messageId: "3f1b1a2c-0000-4000-8000-000000000001", text: "What did I say about tofu?",
      historySourceThreadId: "3f1b1a2c-0000-4000-8000-000000000002" };
    expect(coachTurnRequestSchema.safeParse(base).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "plan" }).success).toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, planningSlot: "meal-4" }).success).toBe(false);
  });

  it("marks Plan sheet turns as private plan threads", () => {
    const base = { threadId: null,
      messageId: "3f1b1a2c-0000-4000-8000-000000000001", text: "Suggest options" };
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "plan" }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "weekly_review" }).success).toBe(false);
  });

  it("carries a photo or link's foods only on a Plan sheet turn, bounded in size", () => {
    const base = { threadId: null,
      messageId: "3f1b1a2c-0000-4000-8000-000000000001", text: "Suggest options" };
    const planSource = { title: "Pad thai", ingredients: ["rice noodles", "tofu"] };
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "plan", planSource }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, planSource }).success).toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "plan",
      planSource: { title: null, ingredients: Array(16).fill("rice") } }).success).toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "plan",
      planSource: { title: "x".repeat(61), ingredients: [] } }).success).toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "plan", planSkipped: ["Tofu bowl"] }).success)
      .toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, planSkipped: ["Tofu bowl"] }).success).toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, surface: "plan",
      planSkipped: Array(9).fill("Rice") }).success).toBe(false);
  });

  it("refuses a messageId that is not a uuid", () => {
    const parsed = coachTurnRequestSchema.safeParse({ threadId: null, messageId: "1", text: "hi" });
    expect(parsed.success).toBe(false);
  });

  it("refuses text over 2000 characters", () => {
    const parsed = coachTurnRequestSchema.safeParse({
      threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000001", text: "x".repeat(2001),
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses empty text — an empty turn would still cost a model call", () => {
    const parsed = coachTurnRequestSchema.safeParse({
      threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000001", text: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts six meal ids and historical slot ids for saved entries", () => {
    expect([...SLOT_IDS]).toEqual([
      "coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2", "meal-3",
      "meal-4", "meal-5", "meal-6", "hot-chocolate",
    ]);
  });

  it("requires every turn response to carry an actions array", () => {
    const response: CoachTurnResponse = {
      threadId: "thread-1", suggestions: [], actions: [], messages: [], draft: null,
      deflected: false, toolsUsed: [], model: { provider: "gemini", modelId: "model-1" },
    };
    expect(response.actions).toEqual([]);
  });
});
