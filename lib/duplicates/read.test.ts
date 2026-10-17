import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { putRow } from "@/lib/sync/idb";
import { entryFingerprint } from "@/lib/sync/fingerprint";
import { bindAccount, type AccountHandle } from "@/lib/device/account";
import { resetTestAccount } from "@/tests/helpers/account";
import type { LoggedFood, LoggedItem } from "@/lib/types";
import { openGroupsFor, parseGroupRow, readOpenDuplicateGroups } from "./read";

const DATE = "2026-10-08";
const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const E1 = "e1111111-1111-4111-8111-111111111111";
const E2 = "e2222222-2222-4222-8222-222222222222";
const E3 = "e3333333-3333-4333-8333-333333333333";
const REF = "f0000000-0000-4000-8000-000000000001";

function entryRow(id: string, eatenAt: string, over: Record<string, unknown> = {}) {
  return {
    id, user_id: "u", local_date: DATE, slot: "meal-2", eaten_at: eatenAt, tz: "UTC", rev: 1,
    deleted_at: null,
    items: [{ id: `${id.slice(0, 8)}-item`, seq: 1, food_ref_id: REF, grams: 142, qty: 1, unit: "g",
      snapshot: { energy_kcal: { amount: 300, unit: "kcal" } } }],
    ...over,
  };
}

function card(id: string, at: string, kcal = 300): LoggedFood {
  return {
    id, foodId: "f", name: "Chicken thigh", portionLabel: "g", qty: 1, grams: 142, at,
    macros: { kcal, protein: 30, carbs: 0, fat: 10 },
    items: [{ id: "i", seq: 1, food_ref_id: REF, grams: 142, qty: 1, unit: "g", snapshot: { energy_kcal: { amount: kcal, unit: "kcal" } } as LoggedItem["snapshot"],
      foodId: "f", name: "Chicken thigh", portionLabel: "g", macros: { kcal, protein: 30, carbs: 0, fat: 10 } }],
  };
}

async function fingerprint(eatenAt: string): Promise<string> {
  return entryFingerprint({ localDate: DATE, slot: "meal-2", eatenAt,
    items: [{ canonicalFoodId: REF, grams: 142, qty: 1, unit: "g" }] });
}

async function groupRow(over: Record<string, unknown> = {}) {
  return { id: GROUP_ID, user_id: "u", local_date: DATE, slot: "meal-2", state: "open", rev: 1,
    fingerprint: await fingerprint("2026-10-08T12:30:00Z"), merged_into_entry_id: null, ...over };
}

let h: AccountHandle;
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  h = await resetTestAccount();
});

describe("parseGroupRow", () => {
  it("reads a change-feed row and refuses a malformed one", async () => {
    expect(parseGroupRow(await groupRow())).toMatchObject({ id: GROUP_ID, state: "open", rev: 1 });
    expect(parseGroupRow(await groupRow({ fingerprint: "\\x00" }))).toBeNull();
    expect(parseGroupRow(await groupRow({ state: "weird" }))).toBeNull();
    expect(parseGroupRow(await groupRow({ rev: "1" }))).toBeNull();
  });
});

describe("openGroupsFor", () => {
  it("finds the members by the server's fingerprint, oldest first", async () => {
    const out = await openGroupsFor(DATE, [await groupRow()],
      [entryRow(E2, "2026-10-08T12:40:00Z"), entryRow(E1, "2026-10-08T12:31:00Z")],
      [card(E1, "2026-10-08T12:31:00Z"), card(E2, "2026-10-08T12:40:00Z", 310)]);
    expect(out).toHaveLength(1);
    expect(out[0].members.map((m) => m.entryId)).toEqual([E1, E2]);
    expect(out[0].members[0]).toMatchObject({ itemNames: ["Chicken thigh"], kcal: 300 });
  });

  it("leaves out an entry in another 15-minute bucket, slot or day", async () => {
    const out = await openGroupsFor(DATE, [await groupRow()], [
      entryRow(E1, "2026-10-08T12:31:00Z"),
      entryRow(E2, "2026-10-08T12:50:00Z"),
      entryRow(E3, "2026-10-08T12:32:00Z", { slot: "meal-3" }),
    ], [card(E1, "2026-10-08T12:31:00Z"), card(E2, "2026-10-08T12:50:00Z"), card(E3, "2026-10-08T12:32:00Z")]);
    expect(out).toEqual([]);
  });

  it("shows nothing for a dismissed or merged group, another day, or a group with one live member", async () => {
    const rows = [entryRow(E1, "2026-10-08T12:31:00Z"), entryRow(E2, "2026-10-08T12:33:00Z")];
    const cards = [card(E1, "2026-10-08T12:31:00Z"), card(E2, "2026-10-08T12:33:00Z")];
    expect(await openGroupsFor(DATE, [await groupRow({ state: "dismissed" })], rows, cards)).toEqual([]);
    expect(await openGroupsFor(DATE, [await groupRow({ state: "merged" })], rows, cards)).toEqual([]);
    expect(await openGroupsFor("2026-10-09", [await groupRow()], rows, cards)).toEqual([]);
    const deleted = [rows[0], { ...rows[1], deleted_at: "2026-10-08T13:00:00Z" }];
    expect(await openGroupsFor(DATE, [await groupRow()], deleted, cards)).toEqual([]);
    // A mirrored entry no longer on the day's cards (deleted on this phone) is not a member either.
    expect(await openGroupsFor(DATE, [await groupRow()], rows, [cards[0]])).toEqual([]);
  });

  it("says kcal pending for an entry whose items carry no snapshot yet", async () => {
    const pending = { ...card(E2, "2026-10-08T12:33:00Z"),
      items: card(E2, "2026-10-08T12:33:00Z").items!.map((i) => ({ ...i, snapshot: {} })) };
    const measured = card(E1, "2026-10-08T12:31:00Z");
    const out = await openGroupsFor(DATE, [await groupRow()],
      [entryRow(E1, "2026-10-08T12:31:00Z"), entryRow(E2, "2026-10-08T12:33:00Z")], [measured, pending]);
    expect(out[0].members[1].kcal).toBeNull();
  });
});

describe("readOpenDuplicateGroups", () => {
  it("reads the bound account's own mirror and never another account's", async () => {
    await putRow(h, "duplicate_groups", GROUP_ID, await groupRow());
    await putRow(h, "log_entries", E1, entryRow(E1, "2026-10-08T12:31:00Z"));
    await putRow(h, "log_entries", E2, entryRow(E2, "2026-10-08T12:33:00Z"));
    const cards = [card(E1, "2026-10-08T12:31:00Z"), card(E2, "2026-10-08T12:33:00Z")];
    expect(await readOpenDuplicateGroups(h, DATE, cards)).toHaveLength(1);

    const other = bindAccount("22222222-2222-4222-8222-222222222222");
    expect(await readOpenDuplicateGroups(other, DATE, cards)).toEqual([]);
  });
});
