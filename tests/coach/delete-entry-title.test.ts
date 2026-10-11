/**
 * Audit 2026-10-10 A028/A037: the coach's delete_entry Undo puts the entry back with its stored
 * title and each item's own amount and portion — not untitled, and not "2 eggs" rewritten as
 * "100 g".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogCommitRequest } from "@/lib/log/contract";
import { resetTestAccount } from "@/tests/helpers/account";

const ENTRY = "3f1b1a2c-0000-4000-8000-0000000000e1";
const ITEM = `${ENTRY}:1`;
const REF = "3f1b1a2c-0000-4000-8000-00000000003c";
const DATE = "2026-09-18";

const store: { days: Record<string, { date: string; extras: Record<string, unknown>[] }> } =
  { days: {} };
const commits: LogCommitRequest[] = [];
const mirror = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined,
  ops: [] as unknown[] }));

vi.mock("@/lib/sync/idb", () => ({
  getRow: async () => mirror.row, putRow: async () => undefined,
  deleteRow: async () => undefined, allOps: async () => mirror.ops,
  closeAllAccountDbs: async () => undefined,
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

async function deleteAndUndo() {
  const result = await applyDeleteEntry(
    { kind: "delete_entry", actionId: "a1", flagged: [], entryId: ENTRY, what: "Post-gym lunch" },
    { tz: "UTC" });
  if (result.status !== "applied" || result.token.kind !== "delete_entry") throw new Error("not applied");
  await undoDeleteEntry(result.token);
  return commits[0];
}

beforeEach(async () => {
  commits.length = 0;
  mirror.ops = [];
  mirror.row = { id: ENTRY, slot: "meal-2", title: "Post-gym lunch",
    items: [{ id: ITEM, portion_id: 41, was_edited: true }] };
  store.days = { [DATE]: { date: DATE, extras: [{
    id: ENTRY, foodId: "eggs", name: "Post-gym lunch", qty: 1, grams: 100,
    portionLabel: "2 large", macros: { kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5 },
    at: `${DATE}T15:00:00.000Z`,
    items: [{ id: ITEM, seq: 1, food_ref_id: REF, grams: 100, qty: 2, unit: "large",
      food_revision_id: 9, snapshot: {}, foodId: "eggs", name: "Eggs", portionLabel: "2 large",
      macros: { kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5 } }],
  }] } };
  await resetTestAccount();
});

describe("coach delete_entry Undo keeps the title and the amounts", () => {
  it("restores the stored title, qty, unit and portion", async () => {
    const commit = await deleteAndUndo();
    expect(commit.title).toBe("Post-gym lunch");
    expect(commit.slot).toBe("meal-2");
    expect(commit.items[0]).toMatchObject({ food_ref_id: REF, grams: 100, qty: 2, unit: "large",
      portion_id: 41, was_edited: true, food_revision_id: 9 });
  });

  it("a queued create's title wins over an older mirror", async () => {
    mirror.ops = [{ entity: "log_entries", entity_id: ENTRY, kind: "create", seq: 3,
      payload: { slot: "meal-3", title: "Late lunch", items: [] } }];
    const commit = await deleteAndUndo();
    expect(commit.title).toBe("Late lunch");
    expect(commit.slot).toBe("meal-3");
  });

  it("an untitled row stays untitled", async () => {
    mirror.row = { id: ENTRY, slot: "meal-2", title: null };
    const commit = await deleteAndUndo();
    expect(commit.title).toBeNull();
  });

  it("with no row and no queued op, keeps the name the card showed", async () => {
    mirror.row = undefined;
    const commit = await deleteAndUndo();
    expect(commit.title).toBe("Post-gym lunch");
    expect(commit.slot).toBe("snack");
  });
});
