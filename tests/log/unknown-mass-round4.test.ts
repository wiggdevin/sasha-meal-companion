/**
 * t17 round 4 (GPT-6 review of round 3):
 *   BLOCK 1 — a per-unit snapshot keeps the exact per-unit number; amounts are per_unit × count,
 *             rounded once (the SQL half is tests/log/unknown-mass-local-db.test.ts).
 *   WARN 2  — a retry carries a portion over only when its words AND its weight still match.
 *   WARN 3  — a reconcile that makes an item's mass unknown moves the card's mass and label too.
 */
import { describe, expect, it } from "vitest";
import type { AccountHandle } from "@/lib/device/account";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { catalogCard } from "@/lib/log/catalog-card";
import { refreshCatalogPicks } from "@/lib/log/deferred-refresh";
import type { LogPick } from "@/lib/log/picked-commit";
import { reconcileEntry, reconcileFromEntity } from "@/lib/log-commit-settle";
import type { LogCommitResponse } from "@/lib/log/contract";
import { computeUnitSnapshot } from "@/lib/nutrients/snapshot";
import type { LoggedFood, LoggedItem } from "@/lib/types";

const META = { source: "user", source_version: "per_unit", revision_id: null };

describe("BLOCK 1: per-unit × count, rounded once, from the exact per-unit number", () => {
  it("keeps 1.0001 g per unit: 0.25 → 0.25, then 0.5 → 0.5001 (never a rescaled 0.5000)", () => {
    const quarter = computeUnitSnapshot({ protein: 1.0001 }, 0.25, META).protein;
    expect(quarter).toMatchObject({ amount: 0.25, per_unit: 1.0001, basis: "per_unit" });
    const half = computeUnitSnapshot({ protein: quarter.per_unit as number }, 0.5, META).protein;
    expect(half).toMatchObject({ amount: 0.5001, per_unit: 1.0001 });
    expect(computeUnitSnapshot({ protein: 1.0001 }, 3, META).protein.amount).toBe(3.0003);
  });
});

const REV = (id: number, grams: number) => ({
  revision_id: id, catalog_food_id: 7, description: "Rice", brand: null, source: "fdc",
  version_label: "v", per_100g: { energy_kcal: 130 },
  portions: [{ id: id * 10, description: "1 cup", gramWeight: grams, isDefault: true }],
  cached_at: "2026-11-02T00:00:00.000Z",
}) as unknown as CachedRevision;

function cupPick(): LogPick {
  const revision = REV(910, 100);
  const card = catalogCard({ revision, entryId: "e", itemId: "i", foodRefId: "ref", grams: 100,
    qty: 1, portion: revision.portions[0], at: new Date("2026-11-02T12:00:00Z") });
  return { source: "catalog", card, itemId: "i", foodRefId: "ref", revision, grams: 100, qty: 1,
    unit: "portion", portionId: 9100 };
}

describe("WARN 2: a retry re-pins a portion only when words and weight both match", () => {
  const h = { userId: "u" } as AccountHandle;

  it("states the line in grams when '1 cup' now weighs 120 g", async () => {
    const out = await refreshCatalogPicks([cupPick()], h, async () => REV(911, 120));
    if (out.status !== "ok") throw new Error(out.status);
    expect(out.picks[0]).toMatchObject({ grams: 100, qty: 100, unit: "g", portionId: null,
      card: { portionLabel: "100 g", grams: 100 } });
    expect((out.picks[0] as Extract<LogPick, { source: "catalog" }>).revision.revision_id).toBe(911);
  });

  it("keeps the portion when '1 cup' still weighs 100 g", async () => {
    const out = await refreshCatalogPicks([cupPick()], h, async () => REV(911, 100));
    if (out.status !== "ok") throw new Error(out.status);
    expect(out.picks[0]).toMatchObject({ grams: 100, qty: 1, unit: "portion", portionId: 9110 });
  });
});

const item = (over: Partial<LoggedItem> = {}): LoggedItem => ({ id: "i1", seq: 1,
  food_ref_id: "r1", grams: 100, qty: 1, unit: "portion", snapshot: {}, foodId: "f",
  name: "Pouch", portionLabel: "100 g", macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, ...over });

const card = (over: Partial<LoggedFood> = {}): LoggedFood => ({ id: "e1", foodId: "f",
  name: "Pouch", portionLabel: "100 g", qty: 1, grams: 100,
  macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, at: "2026-11-02T12:00:00Z",
  items: [item()], ...over });

const reply = (items: Partial<LogCommitResponse["items"][number]>[]) => ({ status: "ok",
  entry_id: "e1", rev: 2, totals: { local_date: "2026-11-02", nutrients: [], micro_coverage_pct: 0 },
  items: items.map((i) => ({ id: "i1", entry_id: "e1", seq: 1, food_ref_id: "r1", qty: 2,
    unit: "pouch", grams: null, portion_id: null, food_revision_id: null, was_edited: false,
    confidence: null, snapshot: {}, ...i })) }) as unknown as LogCommitResponse;

describe("WARN 3: a reconcile moves the card's mass and label with its items", () => {
  it("a server reply that makes the one item's mass unknown: no 100 g left on the card", () => {
    const patch = reconcileEntry(card(), reply([{}]));
    expect(patch.items?.[0]).toMatchObject({ grams: null, portionLabel: "2 pouch" });
    expect(patch).toMatchObject({ grams: 0, massUnknown: true, portionLabel: "2 pouch" });
  });

  it("an entity row does the same, and a mass coming back takes the mark off", () => {
    const lost = reconcileFromEntity(card(), { rev: 2, items: [{ id: "i1", seq: 1,
      food_ref_id: "r1", qty: 2, unit: "pouch", grams: null, snapshot: {} }] });
    expect(lost).toMatchObject({ grams: 0, massUnknown: true, portionLabel: "2 pouch" });
    const back = reconcileFromEntity({ ...card(), ...lost } as LoggedFood, { rev: 3, items: [{
      id: "i1", seq: 1, food_ref_id: "r1", qty: 1, unit: "portion", grams: 140, snapshot: {} }] });
    expect(back).toMatchObject({ grams: 140, portionLabel: "140 g" });
    expect("massUnknown" in back && back.massUnknown).toBeFalsy();
  });

  it("a meal keeps its words and sums only the known masses", () => {
    const meal = card({ foodId: "meal", portionLabel: "2 items", grams: 140,
      items: [item(), item({ id: "i2", seq: 2, grams: 40, portionLabel: "40 g" })] });
    const patch = reconcileFromEntity(meal, { rev: 2, items: [
      { id: "i1", seq: 1, food_ref_id: "r1", qty: 2, unit: "pouch", grams: null, snapshot: {} },
      { id: "i2", seq: 2, food_ref_id: "r1", qty: 40, unit: "g", grams: 40, snapshot: {} }] });
    expect(patch).toMatchObject({ grams: 40, massUnknown: true });
    expect(patch.portionLabel).toBeUndefined();
  });

  it("a card that was already a count keeps the sheet's own label", () => {
    const counted = card({ grams: 0, massUnknown: true, portionLabel: "1 pouch", qty: 2,
      items: [item({ grams: null, qty: 2, unit: "pouch", portionLabel: "1 pouch" })] });
    const patch = reconcileEntry(counted, reply([{}]));
    expect(patch).toMatchObject({ grams: 0, massUnknown: true });
    expect(patch).not.toHaveProperty("portionLabel");
    expect(patch.items?.[0].portionLabel).toBe("1 pouch");
  });

  it("a card whose items were and stay known is left exactly as before", () => {
    const patch = reconcileEntry(card(), reply([{ grams: 100, qty: 1, unit: "portion" }]));
    expect(patch).not.toHaveProperty("grams");
    expect(patch).not.toHaveProperty("massUnknown");
    expect(patch).not.toHaveProperty("portionLabel");
  });
});
