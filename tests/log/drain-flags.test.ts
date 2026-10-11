/**
 * W017 (audit 2026-10-10 A033): a commit that went to the outbox gets its policy marks when the
 * drain settles it, the same marks an online commit puts on the card.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markDrainedFlags } from "@/lib/log/drain-flags";
import { handleLogEntryResult } from "@/lib/sync/log-entry-ops";
import type { OutboxOp } from "@/lib/sync/idb";
import { getDay, loadStore, saveStore, upsertExtra } from "@/lib/store";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

const DATE = "2026-09-11";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const CARD: LoggedFood = {
  id: ENTRY_ID, foodId: "f", name: "Toast", portionLabel: "60 g", qty: 1, grams: 60,
  macros: { kcal: 150, protein: 5, carbs: 28, fat: 2 }, at: "2026-09-11T08:00:00.000Z",
};
const FLAG = { path: "items.0", message: "blocked:allergen:gluten" };

let h: AccountHandle;
beforeEach(async () => {
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
  upsertExtra(DATE, CARD);
});

const flagsOn = () => getDay(DATE)?.extras?.find((e) => e.id === ENTRY_ID)?.flags;

describe("marks after a drain (A033)", () => {
  it("puts the drained marks on the card, keeping the ones it had", () => {
    upsertExtra(DATE, { ...CARD, flags: ["avoid_list"] });
    markDrainedFlags(h, ENTRY_ID, DATE, [FLAG, FLAG]);
    expect(flagsOn()).toEqual(["avoid_list", "gluten"]);
  });

  it("finds the card with no date, and changes nothing with no marks", () => {
    markDrainedFlags(h, ENTRY_ID, undefined, []);
    expect(flagsOn()).toBeUndefined();
    markDrainedFlags(h, ENTRY_ID, undefined, [FLAG]);
    expect(flagsOn()).toEqual(["gluten"]);
  });

  it("is what the drain does with an applied log create's marks", async () => {
    const op = { op_id: "op-1", entity: "log_entries", entity_id: ENTRY_ID, kind: "create",
      base_rev: null, payload: { local_date: DATE }, client_ts: "2026-09-11T08:00:00.000Z",
      user_id: h.userId } as unknown as OutboxOp;
    const handled = await handleLogEntryResult(h,
      { op_id: "op-1", status: "applied", rev: 1, seq: 3, flagged: [FLAG] }, op);
    expect(handled).toBe(true);
    expect(flagsOn()).toEqual(["gluten"]);
  });
});
