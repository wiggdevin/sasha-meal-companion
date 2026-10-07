import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readFacets: vi.fn(),
  systemOne: vi.fn(),
}));

vi.mock("@/lib/foods/facets", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/foods/facets")>(),
  readFacets: mocks.readFacets,
}));

vi.mock("@/lib/ai/typesafe", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ai/typesafe")>(),
  systemOne: (p: { state: unknown; questions: unknown; purpose: string }, o?: object) =>
    mocks.systemOne(p.state, p.questions, { ...o, purpose: p.purpose }),
}));

import { facetCacheKey, type FacetReadResult } from "@/lib/foods/facets";
import { checkSanity, type SanityDraft } from "@/lib/log/sanity";
import {
  FACET_THRESHOLDS,
  PORTION_LEVEL_THRESHOLDS,
} from "@/lib/foods/facet-thresholds";

const KEY = { foodKey: "catalog_revision:7", inputHash: "\\xabc" };
// Inside the frozen mark band: the cached judgment is unknown, so the direct rubric must run.
const UNKNOWN_HUMAN_FOOD_P =
  (FACET_THRESHOLDS.human_food.mark.absent + FACET_THRESHOLDS.human_food.mark.present) / 2;
const UNKNOWN_LARGE_PORTION_P =
  (PORTION_LEVEL_THRESHOLDS.large.warn.absent
    + PORTION_LEVEL_THRESHOLDS.large.warn.present) / 2;

function draft(overrides: Partial<SanityDraft> = {}): SanityDraft {
  return {
    itemId: "item-7",
    food: {
      name: "Cooked rice",
      brand: "Plain Foods",
      description: "Long grain",
      preparation: "cooked",
      ingredientsText: "rice, water",
    },
    amounts: { gramsPerServing: 180, kcalPerServing: 230 },
    facetKey: KEY,
    ...overrides,
  };
}

function facets(humanFoodP?: number): FacetReadResult {
  const map = new Map();
  if (humanFoodP !== undefined) {
    map.set(facetCacheKey(KEY), {
      human_food: { p: humanFoodP, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00Z" },
    });
  }
  return Object.assign(map, { errors: 0 }) as FacetReadResult;
}

function portionAnswer(index: number, probability = 0.99) {
  const probabilities = Object.fromEntries([0, 1, 2, 3, 4].map((key) =>
    [String(key), key === index ? probability : (1 - probability) / 4]));
  return {
    type: "score",
    score: index,
    legend: {
      "0": "Far too small to be a plausible serving of this food in the stated context.",
      "1": "Small but still a plausible serving of this food in the stated context.",
      "2": "A typical plausible serving of this food in the stated context.",
      "3": "Large but still a plausible serving of this food in the stated context.",
      "4": "Far too large to be a plausible serving of this food in the stated context.",
    },
    probabilities,
    confidence: probability,
  };
}

beforeEach(() => {
  mocks.readFacets.mockReset();
  mocks.systemOne.mockReset();
});

describe("async sanity contract", () => {
  it("returns a deterministic warning immediately without reading cache or Jev", async () => {
    await expect(checkSanity(draft({
      amounts: { gramsPerServing: 2_000, kcalPerServing: 250 },
    }), {})).resolves.toMatchObject({ sanityStatus: "warn" });
    expect(mocks.readFacets).not.toHaveBeenCalled();
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });

  it("uses cached human-food evidence before asking only the atomic portion question", async () => {
    mocks.readFacets.mockResolvedValue(facets(0.99));
    mocks.systemOne.mockResolvedValue({ portion_level: portionAnswer(2) });

    await expect(checkSanity(draft(), {})).resolves.toEqual({
      sanityStatus: "ok",
      warnings: [],
    });
    const questions = mocks.systemOne.mock.calls[0][1];
    expect(Object.keys(questions)).toEqual(["portion_level"]);
  });

  it("keeps a draft unknown when no per-serving amount is available", async () => {
    mocks.readFacets.mockResolvedValue(facets(0.99));

    await expect(checkSanity(draft({
      amounts: { gramsPerServing: null, kcalPerServing: null },
    }), {})).resolves.toEqual({ sanityStatus: "unknown", warnings: [] });
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });

  it("warns from a cached not-human judgment without a provider call", async () => {
    mocks.readFacets.mockResolvedValue(facets(0.01));

    await expect(checkSanity(draft(), {})).resolves.toMatchObject({
      sanityStatus: "warn",
      warnings: [{ itemId: "item-7", kind: "not_food", level: "not_food" }],
    });
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });

  it("abstains with the cached human-food band before using the direct rubric", async () => {
    mocks.readFacets.mockResolvedValue(facets(UNKNOWN_HUMAN_FOOD_P));
    mocks.systemOne.mockResolvedValue({
      not_human_food: { type: "noul", noul: 0 },
      portion_level: portionAnswer(2),
    });

    await expect(checkSanity(draft(), {})).resolves.toMatchObject({ sanityStatus: "ok" });
    expect(mocks.systemOne.mock.calls[0][1]).toHaveProperty("not_human_food");
  });

  it.each([
    ["an empty answer", {}],
    ["the asked portion answer missing", { not_human_food: { noul: 0 } }],
    ["a malformed not-food answer", {
      not_human_food: { noul: 0 },
      portion_level: portionAnswer(2),
    }],
  ])("keeps the draft unknown when Jev returns %s", async (_label, answers) => {
    mocks.readFacets.mockResolvedValue(facets());
    mocks.systemOne.mockResolvedValue(answers);

    await expect(checkSanity(draft(), {})).resolves.toEqual({
      sanityStatus: "unknown",
      warnings: [],
    });
  });

  it("keeps the draft unknown when the portion distribution is malformed", async () => {
    mocks.readFacets.mockResolvedValue(facets());
    mocks.systemOne.mockResolvedValue({
      not_human_food: { type: "noul", noul: 0 },
      portion_level: {
        ...portionAnswer(2),
        probabilities: { "2": 0.99 },
      },
    });

    await expect(checkSanity(draft(), {})).resolves.toEqual({
      sanityStatus: "unknown",
      warnings: [],
    });
  });

  it("abstains when the winning portion probability is inside its frozen warn gap", async () => {
    mocks.readFacets.mockResolvedValue(facets(0.99));
    mocks.systemOne.mockResolvedValue({
      portion_level: portionAnswer(3, UNKNOWN_LARGE_PORTION_P),
    });

    await expect(checkSanity(draft(), {})).resolves.toEqual({
      sanityStatus: "unknown",
      warnings: [],
    });
  });

  it("does not call Jev for an already-aborted check", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.readFacets.mockResolvedValue(facets());

    await expect(checkSanity(draft(), { signal: controller.signal })).resolves.toEqual({
      sanityStatus: "unknown",
      warnings: [],
    });
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });

  it("uses frozen level probabilities and warns on a semantic portion outlier", async () => {
    mocks.readFacets.mockResolvedValue(facets());
    mocks.systemOne.mockResolvedValue({
      not_human_food: { type: "noul", noul: 0 },
      portion_level: portionAnswer(4),
    });

    await expect(checkSanity(draft(), {})).resolves.toMatchObject({
      sanityStatus: "warn",
      warnings: [{ kind: "portion", level: "far_too_large" }],
    });
  });

  it("sends food fields and resolved amounts only", async () => {
    mocks.readFacets.mockResolvedValue(facets());
    mocks.systemOne.mockResolvedValue({
      not_human_food: { type: "noul", noul: 0 },
      portion_level: portionAnswer(2),
    });
    const privateDraft = {
      ...draft(),
      condition: "private-condition",
      note: "private-note",
      weight: 123,
      preferenceFlags: ["private-flag"],
    };

    await checkSanity(privateDraft, {});

    expect(mocks.systemOne.mock.calls[0][0]).toEqual({
      food: {
        name: "Cooked rice",
        brand: "Plain Foods",
        description: "Long grain",
        preparation: "cooked",
        ingredientsText: "rice, water",
      },
      amounts: { gramsPerServing: 180, kcalPerServing: 230 },
    });
    expect(JSON.stringify(mocks.systemOne.mock.calls[0][0])).not.toMatch(/private/i);
  });

  it.each(["provider null", "provider throw"])("maps %s to unknown and never throws", async (kind) => {
    mocks.readFacets.mockResolvedValue(facets());
    if (kind === "provider null") mocks.systemOne.mockResolvedValue(null);
    else mocks.systemOne.mockRejectedValue(new Error("cap or provider failure"));

    await expect(checkSanity(draft(), {})).resolves.toEqual({
      sanityStatus: "unknown",
      warnings: [],
    });
  });
});
