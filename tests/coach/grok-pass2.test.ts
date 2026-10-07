import { beforeEach, describe, expect, it, vi } from "vitest";
import { groundActions } from "@/lib/coach/ground";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import { resetTestAccount } from "@/tests/helpers/account";

const ENTRY = "3f1b1a2c-0000-4000-8000-0000000000e1";
const REF = "3f1b1a2c-0000-4000-8000-00000000001a";
const DATE = "2026-09-18";

/** The phone's stores, as thin as the code under test needs them. */
const idb: { rows: Record<string, Record<string, unknown>>; ops: unknown[] } =
  { rows: {}, ops: [] };
const store: { days: Record<string, { date: string; extras: Record<string, unknown>[] }> } =
  { days: {} };

vi.mock("@/lib/sync/idb", () => ({
  getRow: async (_h: unknown, entity: string, id: string) => idb.rows[`${entity}:${id}`],
  putRow: async () => undefined,
  deleteRow: async () => undefined,
  allOps: async () => idb.ops,
  closeAllAccountDbs: async () => undefined,
}));
vi.mock("@/lib/sync/outbox", () => ({ enqueue: async () => undefined,
  enqueueWithRow: async () => undefined }));
vi.mock("@/lib/store", () => ({
  loadStore: () => store,
  getDay: (date: string) => store.days[date],
  addExtra: () => undefined,
  removeExtra: () => undefined,
  updateExtra: () => undefined,
}));
vi.mock("@/lib/log/delete-entry", () => ({ forgetLoggedEntry: async () => undefined }));

const { applyDeleteEntry } = await import("@/lib/coach/apply-entries");

/** A phone extra, exactly as `lib/store.ts` holds one: NO `slot` property anywhere on it. */
function extra(): Record<string, unknown> {
  return {
    id: ENTRY, foodId: "meal", name: "Eggs", qty: 1, grams: 150, portionLabel: "1 item",
    macros: { kcal: 200, protein: 12, carbs: 1, fat: 15 }, at: `${DATE}T15:00:00.000Z`,
    items: [{ id: `${ENTRY}:1`, seq: 1, food_ref_id: REF, grams: 150, qty: 150, unit: "g",
      snapshot: {}, foodId: REF, name: "Eggs", portionLabel: "150 g",
      macros: { kcal: 200, protein: 12, carbs: 1, fat: 15 } }],
  };
}

describe("HIGH 2 — the deleted entry's slot comes off the wire, not off the card", () => {
  beforeEach(async () => {
    idb.rows = {};
    idb.ops = [];
    store.days = { [DATE]: { date: DATE, extras: [extra()] } };
    await resetTestAccount();
  });

  it("reads the slot from the mirrored log_entries row", async () => {
    idb.rows[`log_entries:${ENTRY}`] = { id: ENTRY, slot: "meal-1", rev: 3 };
    const result = await applyDeleteEntry(
      { kind: "delete_entry", actionId: "a1", flagged: [], entryId: ENTRY, what: "Eggs at 09:00" },
      { tz: "America/Denver" });
    expect(result.status).toBe("applied");
    expect(result.status === "applied" && result.token).toMatchObject({
      kind: "delete_entry", slot: "meal-1", eatenAt: `${DATE}T15:00:00.000Z` });
  });

  it("carries each item's ref and catalog revision, so Undo restores them", async () => {
    idb.rows[`log_entries:${ENTRY}`] = { id: ENTRY, slot: "meal-1", rev: 3 };
    store.days[DATE].extras[0].items = [{ ...(extra().items as Record<string, unknown>[])[0],
      food_revision_id: 77 }];
    const result = await applyDeleteEntry(
      { kind: "delete_entry", actionId: "a1", flagged: [], entryId: ENTRY, what: "Eggs" },
      { tz: "UTC" });
    expect(result.status === "applied" && result.token.kind === "delete_entry"
      && result.token.items).toEqual([{ foodRefId: REF, grams: 150, revisionId: 77,
        name: "Eggs" }]);
  });

  it("falls back to the queued create op when the commit has not settled yet", async () => {
    idb.ops = [{ seq: 4, entity: "log_entries", entity_id: ENTRY, kind: "create",
      payload: { slot: "meal-3" }, base_rev: null }];
    const result = await applyDeleteEntry(
      { kind: "delete_entry", actionId: "a1", flagged: [], entryId: ENTRY, what: "Eggs" },
      { tz: "UTC" });
    expect(result.status === "applied" && result.token).toMatchObject({ slot: "meal-3" });
  });

  it("is a snack only when neither the mirror nor the outbox knows a slot", async () => {
    const result = await applyDeleteEntry(
      { kind: "delete_entry", actionId: "a1", flagged: [], entryId: ENTRY, what: "Eggs" },
      { tz: "UTC" });
    expect(result.status === "applied" && result.token).toMatchObject({ slot: "snack" });
  });

  it("never reads a slot off the extra — a phone extra has no such field", async () => {
    store.days[DATE].extras[0].slot = "meal-2";       // even if something put one there
    idb.rows[`log_entries:${ENTRY}`] = { id: ENTRY, slot: "meal-1", rev: 3 };
    const result = await applyDeleteEntry(
      { kind: "delete_entry", actionId: "a1", flagged: [], entryId: ENTRY, what: "Eggs" },
      { tz: "UTC" });
    expect(result.status === "applied" && result.token).toMatchObject({ slot: "meal-1" });
  });
});

describe("MEDIUM 3 — a failed context still knows what the phone carried", () => {
  const ports = (known?: Map<string, string>) => ({
    searchFoods: async () => [],
    newActionId: () => "a1",
    ...(known ? { knownEntries: async () => known } : {}),
  });

  it("grounds an entry action from the client's own list alone", async () => {
    const { actions } = await groundActions("u1",
      [{ kind: "delete_entry", entryId: ENTRY }], DEFAULT_PROFILE,
      ports(new Map([[ENTRY, "Eggs at 09:00"]])));
    expect(actions[0]).toMatchObject({ kind: "delete_entry", what: "Eggs at 09:00" });
  });

  it("says it could not check only when there is no list at all", async () => {
    const { clarifications } = await groundActions("u1",
      [{ kind: "delete_entry", entryId: ENTRY }], DEFAULT_PROFILE, ports());
    expect(clarifications[0]).toContain("could not check");
  });
});
