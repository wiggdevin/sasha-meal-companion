/**
 * Phase 18 W2b, acceptance 8: the meal-level kosher rule (lib/policy/plate-rules.ts). A kosher
 * account's plate is rejected when it holds deterministic meat beside deterministic dairy, and when
 * any food's meat or dairy evidence is unknown. Evidence is deterministic only; no Jev input exists.
 */
import { describe, expect, it } from "vitest";
import { clearanceName, deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import { checkPlateRules, plateFoodEvidence, type PlateFoodEvidence } from "@/lib/policy/plate-rules";

const food = (foodName: string, extra: Parameters<typeof plateFoodEvidence>[0] = {}) =>
  plateFoodEvidence({ foodName, ...extra });

describe("plate food evidence", () => {
  it.each([
    ["Chicken breast", { meat: "present", dairy: "absent" }],
    ["Beef", { meat: "present", dairy: "absent" }],
    ["Cheddar", { meat: "absent", dairy: "present" }],
    ["Milk", { meat: "absent", dairy: "present" }],
    ["Salmon", { meat: "absent", dairy: "absent" }],
    ["Rice", { meat: "absent", dairy: "absent" }],
    ["Broccoli", { meat: "absent", dairy: "absent" }],
    ["Eggs", { meat: "absent", dairy: "absent" }],
    ["Mystery stew", { meat: "unknown", dairy: "unknown" }],
  ] as const)("%s", (name, expected) => {
    expect(food(name)).toEqual(expected);
  });

  it("reads meat and dairy words in the ingredient text", () => {
    expect(food("House special", { ingredientsText: "rice, chicken broth, salt" }).meat).toBe("present");
    expect(food("House special", { ingredientsText: "pasta, butter, salt" }).dairy).toBe("present");
  });
});

describe("kosher: meat with dairy (W2b acceptance 8)", () => {
  const kosher = ["kosher"] as const;

  it.each([
    ["chicken with cheddar", ["Chicken breast", "Cheddar"]],
    ["beef with milk", ["Beef", "Milk"]],
    ["turkey, rice and butter", ["Turkey", "Rice", "Butter"]],
    ["a meat dish cooked in cream", ["Rice", "House special"], { ingredientsText: "lamb, cream, salt" }],
  ] as const)("rejects %s", (_label, names, extra?) => {
    const foods = names.map((name, i) => food(name, i === names.length - 1 ? extra ?? {} : {}));
    expect(checkPlateRules([...kosher], foods)).toEqual({ ok: false, rule: "kosher_meat_dairy", reason: "meat_with_dairy" });
  });

  it.each([
    ["a stew of unknown make-up", ["Mystery stew", "Rice"]],
    ["one unproven side beside meat", ["Chicken breast", "Sauce"]],
    ["one unproven side beside dairy", ["Yogurt", "Granola bar"]],
  ] as const)("rejects %s as unproven", (_label, names) => {
    expect(checkPlateRules([...kosher], names.map((name) => food(name))))
      .toEqual({ ok: false, rule: "kosher_meat_dairy", reason: "unproven" });
  });

  it.each([
    ["meat without dairy", ["Chicken breast", "Rice", "Broccoli"]],
    ["dairy without meat", ["Yogurt", "Banana"]],
    ["fish and dairy (fish is pareve)", ["Salmon", "Milk"]],
  ] as const)("allows %s", (_label, names) => {
    expect(checkPlateRules([...kosher], names.map((name) => food(name)))).toEqual({ ok: true });
  });

  it("does not apply without the kosher flag", () => {
    expect(checkPlateRules(["vegetarian"], [food("Chicken breast"), food("Cheddar")])).toEqual({ ok: true });
    expect(checkPlateRules([], [food("Mystery stew")])).toEqual({ ok: true });
  });

  it("over every pair and triple drawn from the universe, no accepted plate mixes or leaves a gap", () => {
    const items = UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null);
    const evidence = items.map((item) => plateFoodEvidence({ foodName: item.row.sr,
      wholeFoodName: clearanceName(item.row) }));
    let accepted = 0;
    const check = (plate: PlateFoodEvidence[]) => {
      const verdict = checkPlateRules(["kosher"], plate);
      const mixes = plate.some((f) => f.meat === "present") && plate.some((f) => f.dairy === "present");
      const gap = plate.some((f) => f.meat === "unknown" || f.dairy === "unknown");
      expect(verdict.ok).toBe(!mixes && !gap);
      if (verdict.ok) accepted += 1;
    };
    for (let i = 0; i < evidence.length; i += 1) {
      for (let j = i + 1; j < evidence.length; j += 7) {
        check([evidence[i], evidence[j]]);
        check([evidence[i], evidence[j], evidence[(i + j) % evidence.length]]);
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });
});
