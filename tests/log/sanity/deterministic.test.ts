import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  deterministicSanity,
  type SanityDraft,
} from "@/lib/log/sanity";

function draft(gramsPerServing: number | null, kcalPerServing: number | null): SanityDraft {
  return {
    itemId: "item-1",
    food: { name: "Rice" },
    amounts: { gramsPerServing, kcalPerServing },
  };
}

describe("deterministic per-serving sanity", () => {
  it("documents and enforces the tiny boundary", () => {
    expect(deterministicSanity(draft(1.99, 10))).toMatchObject({
      sanityStatus: "warn",
      warnings: [{ kind: "portion", level: "tiny" }],
    });
    expect(deterministicSanity(draft(2, 10))).toEqual({
      sanityStatus: "pending",
      warnings: [],
    });
  });

  it("documents and enforces both implausible boundaries", () => {
    expect(deterministicSanity(draft(2_000, 200)).warnings).toContainEqual(expect.objectContaining({
      level: "implausible",
      message: expect.stringContaining("2,000 g"),
    }));
    expect(deterministicSanity(draft(100, 3_000)).warnings).toContainEqual(expect.objectContaining({
      level: "implausible",
      message: expect.stringContaining("3,000 kcal"),
    }));
    expect(deterministicSanity(draft(1_999.99, 2_999.99))).toEqual({
      sanityStatus: "pending",
      warnings: [],
    });
  });

  it("does not invent a result for unavailable or invalid resolved amounts", () => {
    expect(deterministicSanity(draft(null, null))).toEqual({
      sanityStatus: "pending",
      warnings: [],
    });
    expect(deterministicSanity(draft(Number.NaN, Number.POSITIVE_INFINITY))).toEqual({
      sanityStatus: "pending",
      warnings: [],
    });
  });
});
