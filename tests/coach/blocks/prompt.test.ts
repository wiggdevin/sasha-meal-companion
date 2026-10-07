import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/lib/coach/prompt";

const prompt = buildSystemPrompt({
  constraints: {
    avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
    banned_categories: [], conditions: [], notes: null,
  },
  today: "2026-09-19",
});

describe("coach UI block guidance", () => {
  it("keeps block use narrow, server-hydrated, and honest when empty", () => {
    expect(prompt).toContain("never more than one block kind");
    expect(prompt).toContain("No weigh-ins yet");
    expect(prompt).toContain("search_foods");
    expect(prompt).toContain("quick_replies");
    expect(prompt).toContain("suggest_options");
    expect(prompt).toContain("server hydrates");
  });

  it("does not displace the medical boundary", () => {
    expect(prompt).toContain("not a clinician");
    expect(prompt).toContain("never read symptoms, medication or test results");
  });
});
