import { describe, expect, it } from "vitest";
import {
  M_DAILY_CAP, mixedDishItems, tasteProfile, tasteWindowStart, type EatenItem,
} from "@/lib/meals/taste";
import {
  familyIdentity, identityOf, universeById, universeByName, universeBySrCode,
} from "@/lib/meals/taste-identity";

const TODAY = "2026-10-06";
const banana = universeById("banana")!;
const dal = familyIdentity("Mom's dal")!;
const at = (localDate: string, slot: string, identity = banana, extra: Partial<EatenItem> = {}): EatenItem =>
  ({ localDate, slot, source: "log", identity, grams: 100, ...extra });
const all = (...keys: string[]) => new Set(keys);

describe("identities (D5)", () => {
  it("map to a universe item by bundled id, SR code or exact name, else to the name family", () => {
    expect(universeById("banana")).toEqual({ key: "u:banana", name: "Banana", match: "universe" });
    expect(universeBySrCode(173944)?.key).toBe("u:banana");
    expect(universeByName("  bananas,   RAW ")?.key).toBe("u:banana");
    expect(identityOf({ name: "Bananas, ripe" })).toEqual({ key: "f:bananas", name: "Bananas, ripe", match: "family" });
    expect(identityOf({ name: "   " })).toBeNull();
  });
});

describe("tasteProfile (pure)", () => {
  it("counts an identity once per episode and keeps the collapsed duplicates in its provenance", () => {
    const result = tasteProfile({ today: TODAY, admitted: all("u:banana"), choices: [], items: [
      at(TODAY, "meal-1", banana, { source: "recipe" }), at(TODAY, "meal-1"), at(TODAY, "meal-1", banana, { source: "tick" }),
    ] });
    expect(result.episodes).toBe(1);
    expect(result.identities[0]).toMatchObject({ key: "u:banana", h: 1, days180: 1, episodes: 1,
      provenance: { collapsed: 2, sources: { log: 1, recipe: 1, tick: 1, mixed_dish: 0 } } });
  });

  it(`caps M at ${M_DAILY_CAP} episodes a day`, () => {
    const items = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"].map((slot) => at(TODAY, slot));
    const result = tasteProfile({ today: TODAY, admitted: all("u:banana"), choices: [], items });
    expect(result.episodes).toBe(4);
    expect(result.m).toBe(4);
  });

  it("weighs a family at half, and admits nothing outside the admitted set (to H, Q or M)", () => {
    const items = [at(TODAY, "meal-1", dal), at(TODAY, "meal-2")];
    const choices = [{ localDate: TODAY, kind: "shopping_manual" as const, identity: banana }];
    const both = tasteProfile({ today: TODAY, admitted: all("u:banana", dal.key), choices, items });
    expect(both.identities.find((row) => row.key === dal.key)?.h).toBe(0.5);
    const held = tasteProfile({ today: TODAY, admitted: all(dal.key), choices, items });
    expect(held.identities.map((row) => row.key)).toEqual([dal.key]);
    expect(held.episodes).toBe(1);
  });

  it("drops items under 10 g and non-countable universe foods; an unknown mass counts", () => {
    const lemon = universeById("lemon")!;
    const result = tasteProfile({ today: TODAY, admitted: all("u:banana", "u:lemon", dal.key), choices: [], items: [
      at(TODAY, "meal-1", banana, { grams: 9.9 }), at(TODAY, "meal-2", lemon), at(TODAY, "meal-3", dal, { grams: null }),
    ] });
    expect(result.identities.map((row) => row.key)).toEqual([dal.key]);
  });

  it("keeps the 180-day window and halves H every 45 days", () => {
    const start = tasteWindowStart(TODAY);
    expect(start).toBe("2026-04-10");
    const result = tasteProfile({ today: TODAY, admitted: all("u:banana"), choices: [], items: [
      at("2026-08-22", "meal-1"), at(start, "meal-1"), at("2026-04-09", "meal-1"), at("2026-10-07", "meal-1"),
    ] });
    expect(result.identities[0].days180).toBe(2);
    expect(result.identities[0].h).toBe(Math.round((0.5 + 0.5 ** (179 / 45)) * 10_000) / 10_000);
  });

  it("expands a mixed dish into estimated half-weight inputs when they are known, else counts the dish", () => {
    const dish = { localDate: TODAY, slot: "meal-3", identity: familyIdentity("Lasagna with meat")!, grams: 300 };
    expect(mixedDishItems(dish, undefined)).toEqual([{ ...dish, source: "mixed_dish" }]);
    const items = mixedDishItems(dish, [{ identity: banana, gramsPerGram: 0.2 }]);
    expect(items).toEqual([{ ...dish, identity: banana, grams: 60, estimated: true, source: "mixed_dish" }]);
    const result = tasteProfile({ today: TODAY, admitted: all("u:banana"), choices: [], items });
    expect(result.identities[0]).toMatchObject({ h: 0.5, provenance: { estimated: true } });
  });

  it("is deterministic whatever the input order", () => {
    const items = [at(TODAY, "meal-1"), at("2026-10-01", "meal-2", dal), at(TODAY, "meal-1", dal, { source: "tick" })];
    const one = tasteProfile({ today: TODAY, admitted: all("u:banana", dal.key), choices: [], items });
    const two = tasteProfile({ today: TODAY, admitted: all("u:banana", dal.key), choices: [], items: [...items].reverse() });
    expect(two).toEqual(one);
  });
});
