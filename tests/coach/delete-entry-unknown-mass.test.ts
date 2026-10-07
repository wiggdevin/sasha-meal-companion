/**
 * t17: the coach's delete_entry Undo for an item whose mass is unknown. The token keeps its count,
 * unit and the EXACT per-unit numbers its snapshot carries (round 4: never an amount divided back
 * by qty), and Undo re-logs it as a count with grams null — never as a 0 g or "g" line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogCommitRequest } from "@/lib/log/contract";
import { resetTestAccount } from "@/tests/helpers/account";

const ENTRY = "3f1b1a2c-0000-4000-8000-0000000000f1";
const REF = "3f1b1a2c-0000-4000-8000-00000000002b";
const DATE = "2026-09-18";

const store: { days: Record<string, { date: string; extras: Record<string, unknown>[] }> } =
  { days: {} };
const commits: LogCommitRequest[] = [];

vi.mock("@/lib/sync/idb", () => ({
  getRow: async () => ({ slot: "meal-2" }), putRow: async () => undefined,
  deleteRow: async () => undefined, allOps: async () => [], closeAllAccountDbs: async () => undefined,
}));
vi.mock("@/lib/sync/outbox", () => ({ enqueue: async () => undefined,
  enqueueWithRow: async () => undefined }));
vi.mock("@/lib/store", () => ({
  loadStore: () => store, getDay: (date: string) => store.days[date],
  addExtra: () => undefined, removeExtra: () => undefined, updateExtra: () => undefined,
}));
vi.mock("@/lib/log/delete-entry", () => ({ forgetLoggedEntry: async () => undefined }));
vi.mock("@/lib/log-commit-client", () => ({
  commitLogEntry: async (req: LogCommitRequest) => { commits.push(req); return { status: "queued" }; },
}));

const { applyDeleteEntry, undoDeleteEntry } = await import("@/lib/coach/apply-entries");

const nv = (amount: number, perUnit: number, unit = "g") => ({ amount, per_unit: perUnit, unit,
  basis: "per_unit", source: "user", source_version: "per_unit", revision_id: null });

beforeEach(async () => {
  commits.length = 0;
  store.days = { [DATE]: { date: DATE, extras: [{
    id: ENTRY, foodId: "pouch", name: "Pouch", qty: 2, grams: 0, massUnknown: true,
    portionLabel: "2 pouch", macros: { kcal: 146, protein: 2, carbs: 28, fat: 2 },
    at: `${DATE}T15:00:00.000Z`,
    // 0.25 of a unit at 1.0001 g protein rounds to 0.25; dividing back would give 1, not 1.0001.
    items: [{ id: `${ENTRY}:1`, seq: 1, food_ref_id: REF, grams: null, qty: 0.25, unit: "pouch",
      snapshot: { protein: nv(0.25, 1.0001), energy_kcal: nv(18.25, 73, "kcal") },
      foodId: "pouch", name: "Pouch", portionLabel: "0.25 pouch",
      macros: { kcal: 18, protein: 0.3, carbs: 0, fat: 0 } }],
  }] } };
  await resetTestAccount();
});

describe("coach delete_entry Undo for an unknown mass", () => {
  it("keeps the count and the exact per-unit numbers, and re-logs it with grams null", async () => {
    const result = await applyDeleteEntry(
      { kind: "delete_entry", actionId: "a1", flagged: [], entryId: ENTRY, what: "Pouch" },
      { tz: "UTC" });
    if (result.status !== "applied" || result.token.kind !== "delete_entry") throw new Error("not applied");
    expect(result.token.items).toEqual([{ foodRefId: REF, grams: null, name: "Pouch",
      revisionId: null, qty: 0.25, unit: "pouch", perUnit: { protein: 1.0001, energy_kcal: 73 } }]);

    await undoDeleteEntry(result.token);
    expect(commits).toHaveLength(1);
    expect(commits[0].items[0]).toMatchObject({ food_ref_id: REF, grams: null, qty: 0.25,
      unit: "pouch", food_revision_id: null, per_unit: { protein: 1.0001, energy_kcal: 73 } });
  });
});
