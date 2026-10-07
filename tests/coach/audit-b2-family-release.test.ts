/**
 * 2026-10-03 audit (b2, minor): a card build that throws after its anchor family was claimed must
 * release the family, or every other food of that family is skipped for the rest of the build.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));
const first = vi.hoisted(() => ({ thrown: false }));
vi.mock("@/lib/coach/compose-template", async (orig) => {
  const real = await orig<typeof import("@/lib/coach/compose-template")>();
  return { ...real, composeTemplateMeal: vi.fn(async (...args: Parameters<typeof real.composeTemplateMeal>) => {
    if (!first.thrown) {
      first.thrown = true;
      throw Object.assign(new Error("a port gave up"), { name: "AbortError" });
    }
    return real.composeTemplateMeal(...args);
  }) };
});

import { buildCandidates } from "@/lib/coach/suggest-candidates";
import { F, FIVE_MEAL, suggestPorts } from "@/tests/coach/meal-template-fixtures";

describe("a throw releases the anchor family", () => {
  it("builds a scallop card from the second scallop row after the first one threw", async () => {
    // Four workers take the first four anchors at once; the bay row comes after the throw.
    const ports = suggestPorts({ anchors: [F.scallopsSea, F.chicken, F.salmon, F.cod, F.steak,
      F.scallopsBay], target: FIVE_MEAL, clock: "19:00" });
    const built = await buildCandidates({ kind: "meal", count: 3, slot: "meal-3" }, ports,
      new AbortController().signal, (promise) => promise,
      (error) => error instanceof Error && error.name === "AbortError");
    if (typeof built === "string") throw new Error(built);
    expect(first.thrown).toBe(true);
    const anchors = built.candidates.map((card) => card.meal.items[0].name);
    expect(anchors).toContain(F.scallopsBay.name);
    expect(anchors).not.toContain(F.scallopsSea.name);
  });
});
