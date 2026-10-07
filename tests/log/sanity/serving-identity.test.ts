import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { typicalServingSuggestion } from "@/lib/log/serving-identity";

describe("typical serving", () => {
  it("returns only the catalog default as the typical-serving suggestion", () => {
    expect(typicalServingSuggestion([
      { id: 1, description: "1 tbsp", gramWeight: 15, isDefault: false },
      { id: 2, description: "1 cup", gramWeight: 234, isDefault: true },
    ])).toEqual({ portionId: "2", label: "1 cup", grams: 234 });
    expect(typicalServingSuggestion([
      { id: 1, description: "1 tbsp", gramWeight: 15, isDefault: false },
    ])).toBeNull();
  });

  it("ignores a default with no label or no positive weight", () => {
    expect(typicalServingSuggestion([
      { id: 1, description: " ", gramWeight: 15, isDefault: true },
    ])).toBeNull();
    expect(typicalServingSuggestion([
      { id: 2, description: "1 cup", gramWeight: 0, isDefault: true },
    ])).toBeNull();
  });
});
