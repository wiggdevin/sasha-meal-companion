import { describe, expect, it } from "vitest";
import { buildCandidates, sourceLabel, type CandidateInput } from "@/lib/shopping/build-candidates";

const row = (name: string, source: CandidateInput["source"], ruleMark: CandidateInput["ruleMark"] = null) =>
  ({ name, source, ruleMark });

describe("the Ingredients deck's candidates", () => {
  it("includes the ingredients of saved recipes and favorite meals", () => {
    const { candidates } = buildCandidates({ sources: [row("Lentils", "recipe"), row("Rice", "meal"),
      row("Eggs", "favored")], avoid: [], pantry: [], listed: [] });
    expect(candidates.map((card) => card.name)).toEqual(["Eggs", "Rice", "Lentils"]);
    expect(sourceLabel(candidates[1])).toBe("From a saved meal");
    expect(sourceLabel(candidates[2])).toBe("From a saved recipe");
  });

  it("dedupes by normalized name and keeps every source", () => {
    const { candidates } = buildCandidates({ sources: [row("Eggs, large", "favored"), row("eggs", "starred"),
      row("  EGGS ", "recipe"), row("Crème fraîche", "eaten"), row("Creme fraiche", "meal")],
    avoid: [], pantry: [], listed: [] });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ name: "Eggs, large", sources: ["favored", "starred", "recipe"] });
    expect(candidates[1].sources).toEqual(["eaten", "meal"]);
  });

  it("removes Avoid, pantry and already-listed foods", () => {
    const { candidates, leftOutByRules } = buildCandidates({
      sources: [row("Peanuts", "eaten"), row("Milk", "favored"), row("Oats", "starred"), row("Kale", "favored")],
      avoid: ["Peanuts, roasted"], pantry: ["oats"], listed: ["Milk"] });
    expect(candidates.map((card) => card.name)).toEqual(["Kale"]);
    expect(leftOutByRules).toBe(0);
  });

  it("drops blocked foods with a count and keeps unknown ones with their mark", () => {
    const unknown = { verdict: "unknown" as const, reason: "Tofu could not be checked." };
    const { candidates, leftOutByRules } = buildCandidates({ sources: [
      row("Shrimp", "favored", { verdict: "blocked", reason: "Shellfish allergy." }),
      row("Tofu", "favored", unknown), row("Shrimp", "eaten")], avoid: [], pantry: [], listed: [] });
    expect(leftOutByRules).toBe(1);
    expect(candidates).toEqual([expect.objectContaining({ name: "Tofu", ruleMark: unknown })]);
  });

  it("caps the deck at 30 cards with ids only", () => {
    const sources = Array.from({ length: 40 }, (_, index) => row(`Food ${index}`, "favored"));
    const result = buildCandidates({ sources, avoid: [], pantry: [], listed: [] });
    expect(result.candidates).toHaveLength(30);
    expect(result.total).toBe(40);
    expect(result.candidates[0].id).toBe("c1");
  });
});
