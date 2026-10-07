/**
 * t17 gap 1: an item whose mass is unknown stores `grams: null`. Every reader of log_items.grams
 * keeps it unknown — never 0, never NaN — and the contract takes null only for a count of units.
 * The SQL half is tests/log/unknown-mass-local-db.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { ENTRY_ID, fakeClient, ITEM_ID, REF_A, req } from "@/tests/helpers/log-fake-client";
import { logCommitRequestSchema, unknownMassRefIssues } from "@/lib/log/contract";
import { mergedItems } from "@/lib/log/card-items";
import { isCompleteEntryRow } from "@/lib/log/entry-row";
import { amountLabel, entryMass, massOf } from "@/lib/log/mass";
import { mealCard } from "@/lib/log/meal-card";
import { computeUnitSnapshot } from "@/lib/nutrients/snapshot";
import { buildCommitRequest } from "@/lib/log-client";
import { fingerprintSource } from "@/lib/sync/fingerprint";
import { flattenMeals } from "@/lib/server/export-meals";
import type { LoggedFood } from "@/lib/types";

vi.mock("server-only", () => ({}));
const { applyLogEntry } = await import("@/lib/server/log");
const { loggedEntries, toDayContext } = await import("@/lib/server/day-context");

const PER_UNIT = { energy_kcal: 78, protein: 2, carbohydrate: 14, fat_total: 1 };
const unitItem = (over: Record<string, unknown> = {}) => ({ id: ITEM_ID, seq: 1,
  food_ref_id: REF_A, qty: 2, unit: "pouch", grams: null, per_unit: PER_UNIT, ...over });

describe("the commit contract", () => {
  it("takes null grams with a qty and a unit, and per_unit only then", () => {
    expect(logCommitRequestSchema.safeParse(req([unitItem()])).success).toBe(true);
    expect(logCommitRequestSchema.safeParse(req([unitItem({ per_unit: undefined })])).success)
      .toBe(true);
    const withMass = logCommitRequestSchema.safeParse(req([unitItem({ grams: 50 })]));
    expect(withMass.success).toBe(false);
  });

  it("refuses null grams on a catalog revision or portion, in grams, or with no qty", () => {
    for (const over of [{ food_revision_id: 10 }, { portion_id: 3 }, { unit: "g" },
      { qty: 0 }, { per_unit: { protein: -1 } }, { per_unit: { protein: "2" } }]) {
      expect(logCommitRequestSchema.safeParse(req([unitItem(over)])).success, JSON.stringify(over))
        .toBe(false);
    }
  });

  it("is built by buildCommitRequest with per_unit only on an unknown-mass item", () => {
    const built = buildCommitRequest({ entryId: ENTRY_ID, eatenAt: new Date(0), tz: "UTC",
      slot: "meal-1", items: [
        { id: ITEM_ID, foodRefId: REF_A, revision: { revision_id: null }, grams: null, qty: 2,
          unit: "pouch", perUnit: PER_UNIT },
        { id: ITEM_ID, foodRefId: REF_A, revision: { revision_id: null }, grams: 40, qty: 1,
          unit: "g", perUnit: PER_UNIT },
      ] });
    expect(built.items[0]).toMatchObject({ grams: null, per_unit: PER_UNIT });
    expect(built.items[1]).not.toHaveProperty("per_unit");
  });
});

describe("an unknown mass is only for the account's own food (round 3, BLOCK 1)", () => {
  it("the contract helper refuses null grams on a catalog or unknown ref", () => {
    const kinds: Record<string, string> = { [REF_A]: "catalog" };
    expect(unknownMassRefIssues([unitItem()] as never, (id) => kinds[id])).toEqual([
      { path: "items.0.grams", message: expect.stringContaining("own food") }]);
    expect(unknownMassRefIssues([unitItem()] as never, () => undefined)).toHaveLength(1);
    expect(unknownMassRefIssues([unitItem()] as never, () => "user")).toEqual([]);
    expect(unknownMassRefIssues([unitItem({ grams: 40, per_unit: undefined })] as never,
      () => "catalog")).toEqual([]);
  });

  it("the server refuses a catalog ref with null grams and claimed per_unit, and writes nothing", async () => {
    const db = fakeClient({
      tables: { food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: 7 }] },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1",
      req([unitItem({ per_unit: { energy_kcal: 9999 } })]));
    expect(out).toMatchObject({ status: "invalid",
      issues: [{ path: "items.0.grams", message: expect.stringContaining("own food") }] });
    expect(db.rpc.mock.calls.some((c) => c[0] === "apply_sync_op")).toBe(false);
  });
});

describe("the server writer and its reply", () => {
  it("passes per_unit to apply_sync_op and hands back the stored null, not 0", async () => {
    const db = fakeClient({
      tables: {
        food_refs: [{ id: REF_A, kind: "user", user_food_id: "f1", catalog_food_id: null }],
        log_items: [{ id: ITEM_ID, entry_id: ENTRY_ID, seq: 1, food_ref_id: REF_A, qty: 2,
          unit: "pouch", grams: null, portion_id: null, food_revision_id: null,
          was_edited: false, confidence: null, snapshot: {} }],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1", req([unitItem()]));
    const call = db.rpc.mock.calls.find((c) => c[0] === "apply_sync_op");
    const items = (call?.[1] as { p_op: { payload: { items: Record<string, unknown>[] } } })
      .p_op.payload.items;
    expect(items[0]).toMatchObject({ grams: null, per_unit: PER_UNIT, qty: 2, unit: "pouch" });
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { items: { grams: number | null }[] }).items[0].grams).toBeNull();
  });
});

describe("the phone's readers", () => {
  it("computes the per-unit snapshot exactly as compute_unit_snapshot does", () => {
    const s = computeUnitSnapshot({ ...PER_UNIT, nope: 3, fiber_total: Number.NaN }, 2,
      { source: "user", source_version: "per_unit", revision_id: null });
    expect(Object.keys(s).sort()).toEqual(["carbohydrate", "energy_kcal", "fat_total", "protein"]);
    expect(s.energy_kcal).toMatchObject({ amount: 156, basis: "per_unit", unit: "kcal" });
    expect(computeUnitSnapshot(PER_UNIT, 1 / 3, { source: "user", source_version: "x",
      revision_id: null }).protein.amount).toBe(0.6667);
  });

  it("keeps a stored null mass on the merged card item, and the row stays editable", () => {
    const entry = { id: ENTRY_ID, foodId: "meal", name: "x", portionLabel: "1", qty: 1, grams: 0,
      macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, at: "2026-09-11T16:00:00.000Z" };
    const row = { id: ITEM_ID, seq: 1, food_ref_id: REF_A, qty: 2, unit: "pouch", grams: null,
      snapshot: {} };
    const [item] = mergedItems(entry, [row]);
    expect(item.grams).toBeNull();
    expect(item.portionLabel).toBe("2 pouch");
    expect(isCompleteEntryRow({ rev: 1, items: [row] })).toBe(true);
    expect(isCompleteEntryRow({ rev: 1, items: [{ ...row, qty: null }] })).toBe(false);
  });

  it("sums only known masses and says when one is unknown", () => {
    expect(entryMass([{ grams: 40 }, { grams: null }])).toEqual({ grams: 40, massUnknown: true });
    expect(entryMass([{ grams: 40 }])).toEqual({ grams: 40, massUnknown: false });
    expect(massOf(null)).toBeNull();
    expect(massOf("12.5")).toBe(12.5);
    expect(massOf("abc")).toBeNull();
    expect(amountLabel({ grams: null, qty: 2, unit: "pouch" })).toBe("2 pouch");
  });

  it("builds a meal card whose unknown-mass line stays null and whose total says so", () => {
    const pouch: LoggedFood = { id: "p", foodId: "pouch", name: "Pouch", portionLabel: "2 pouch",
      qty: 2, grams: 0, massUnknown: true, macros: { kcal: 156, protein: 4, carbs: 28, fat: 2 },
      at: "2026-09-11T16:00:00.000Z", items: [{ id: "pi", seq: 1, food_ref_id: "local:pouch",
        grams: null, qty: 2, unit: "pouch", snapshot: {}, foodId: "pouch", name: "Pouch",
        portionLabel: "2 pouch", macros: { kcal: 156, protein: 4, carbs: 28, fat: 2 } }] };
    const oats: LoggedFood = { id: "o", foodId: "oats", name: "Oats", portionLabel: "40 g", qty: 1,
      grams: 40, macros: { kcal: 150, protein: 5, carbs: 27, fat: 3 }, at: pouch.at };
    const card = mealCard({ entryId: ENTRY_ID, at: new Date(pouch.at), items: [oats, pouch],
      catalogItems: [], name: "", note: "" });
    expect(card.items?.map((i) => i.grams)).toEqual([40, null]);
    expect(card).toMatchObject({ grams: 40, massUnknown: true });
  });

  it("fingerprints an unknown mass by its count, and a known mass exactly as before", () => {
    const base = { localDate: "2026-09-11", slot: "meal-1", eatenAt: "2026-09-11T16:00:00.000Z" };
    expect(fingerprintSource({ ...base, items: [{ canonicalFoodId: "r", grams: 102 }] }))
      .toMatch(/\|r:100$/);
    expect(fingerprintSource({ ...base, items: [{ canonicalFoodId: "r", grams: null, qty: 2,
      unit: "pouch" }] })).toMatch(/\|r:u2pouch$/);
  });
});

describe("the server's day and export readers", () => {
  function day() {
    const tables: Record<string, Record<string, unknown>[]> = {
      log_entries: [{ id: ENTRY_ID, user_id: "u1", local_date: "2026-09-11",
        eaten_at: "2026-09-11T16:00:00Z", tz: "UTC", slot: "snack", note: null, deleted_at: null,
        log_items: [{ seq: 1, qty: 2, unit: "pouch", grams: null, food_ref_id: REF_A,
          food_revision_id: null, snapshot: {} }] }],
      food_refs: [{ id: REF_A, catalog_food_id: null, user_food_id: "f1",
        user_foods: { name: "Pouch" } }],
    };
    // A filtering stand-in with `.is()`, which the day reader uses (tests/server/energy-readers-parity).
    const from = (table: string) => {
      const keep: ((row: Record<string, unknown>) => boolean)[] = [];
      const b: Record<string, unknown> = {
        select: () => b, order: () => b,
        eq: (c: string, v: unknown) => { keep.push((r) => !(c in r) || r[c] === v); return b; },
        is: (c: string, v: unknown) => { keep.push((r) => !(c in r) || r[c] === v); return b; },
        in: (c: string, vs: unknown[]) => { keep.push((r) => !(c in r) || vs.includes(r[c])); return b; },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({
          data: (tables[table] ?? []).filter((r) => keep.every((k) => k(r))), error: null,
        }).then(resolve),
      };
      return b;
    };
    return { client: { from } as never };
  }

  it("the coach and MCP day: the line is its count, the entry flags the unknown mass", async () => {
    const [{ entry }] = await loggedEntries(day().client, "u1", "2026-09-11");
    expect(entry.items?.[0]).toMatchObject({ grams: null, qty: 2, unit: "pouch",
      portionLabel: "2 pouch" });
    expect(entry).toMatchObject({ grams: 0, massUnknown: true });
    const context = toDayContext({ date: "2026-09-11", dayType: "rest", targets: null,
      slots: [], extras: [entry], consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 } } as never,
    "UTC", [{ entry, slot: "snack" }]);
    // An empty snapshot is unknown nutrition (GPT-6 round 1 WARN 2), never "0 kcal 0P 0C 0F".
    expect(context.entries[0].items[0]).toBe("2 pouch Pouch - nutrition unknown");
    expect(context.entries[0].macros).toBe("nutrition unknown");
    expect(JSON.stringify(context.entries[0])).not.toMatch(/\b0 kcal|\b0 g\b|NaN/);
  });

  it("the entry line follows the energy rule: unknown, or a known sum + N unknown, never 0 (round 3)", async () => {
    const protein = { protein: { amount: 10, unit: "g", basis: "per_unit", source: "user",
      source_version: "per_unit", revision_id: null } };
    const kcal = { energy_kcal: { amount: 100, unit: "kcal", basis: "per_100g", source: "usda",
      source_version: "v", revision_id: 1 } };
    async function lines(items: Record<string, unknown>[]) {
      const tables: Record<string, Record<string, unknown>[]> = {
        log_entries: [{ id: ENTRY_ID, user_id: "u1", local_date: "2026-09-11",
          eaten_at: "2026-09-11T16:00:00Z", tz: "UTC", slot: "snack", note: null,
          deleted_at: null, log_items: items }],
        food_refs: [{ id: REF_A, catalog_food_id: null, user_food_id: "f1",
          user_foods: { name: "Pouch" } }],
      };
      const from = (table: string) => {
        const b: Record<string, unknown> = { select: () => b, order: () => b, eq: () => b,
          is: () => b, in: () => b,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve) };
        return b;
      };
      const [{ entry }] = await loggedEntries({ from } as never, "u1", "2026-09-11");
      return toDayContext({ date: "2026-09-11", dayType: "rest", targets: null, slots: [],
        extras: [entry], consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 } } as never,
      "UTC", [{ entry, slot: "snack" }]).entries[0];
    }
    const partial = { seq: 1, qty: 2, unit: "pouch", grams: null, food_ref_id: REF_A,
      snapshot: protein };
    const one = await lines([partial]);
    expect(one.items[0]).toBe("2 pouch Pouch - ? kcal 10P 0C 0F");
    expect(one.macros).toBe("? kcal 10P 0C 0F");
    const mixed = await lines([{ ...partial, seq: 2 }, { seq: 1, qty: 50, unit: "g", grams: 50,
      food_ref_id: REF_A, snapshot: kcal }]);
    expect(mixed.macros).toBe("100 kcal 10P 0C 0F + 1 unknown");
    expect(JSON.stringify([one, mixed])).not.toMatch(/\b0 kcal/);
  });

  it("the meals export keeps grams null", () => {
    const [row] = flattenMeals([{ id: ENTRY_ID, tz: "UTC", log_items: [{ seq: 1, qty: 2,
      unit: "pouch", grams: null, food_ref_id: REF_A, snapshot: {} }] }]);
    expect(row.grams).toBeNull();
    expect(row.energy_kcal).toBeNull();
  });
});
