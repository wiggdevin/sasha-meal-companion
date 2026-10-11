import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it, vi } from "vitest";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";
import { __resetStoreCache, addExtra, getDay } from "@/lib/store";
import { saveExtraNote } from "@/lib/log-note-client";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const mocks = vi.hoisted(() => ({ read: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({ from: () => ({
  select: () => ({ eq: () => ({ maybeSingle: mocks.read }) }),
}) }) }));
vi.mock("@/lib/sync/outbox", async (original) => {
  const actual = await original<typeof import("@/lib/sync/outbox")>();
  return { ...actual, enqueueWithRow: (...args: Parameters<typeof actual.enqueueWithRow>) => {
    mocks.enqueue();
    return actual.enqueueWithRow(...args);
  } };
});
const date = "2026-09-15";
const id = "11111111-1111-4111-8111-111111111111";
const items = [{ id: "22222222-2222-4222-8222-222222222222", food_ref_id: id,
  grams: 90, qty: 1, unit: "portion", seq: 1, food_revision_id: 71, snapshot: { iron: { amount: 2 } } }];
const row = { id, rev: 4, note: "old", items, media_ref: "kept", eaten_at: "2026-09-15T12:00:00Z",
  tz: "UTC", local_date: date, slot: "meal-1", method: "search" };
const extra = { id, foodId: "meal", name: "Lunch", portionLabel: "meal", qty: 1, grams: 90,
  macros: { kcal: 100, protein: 10, carbs: 10, fat: 2 }, at: row.eaten_at, note: "old" } satisfies LoggedFood;

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  __resetStoreCache();
  vi.clearAllMocks();
  addExtra(date, extra);
});

it("queues a complete entry and preserves every item and snapshot when clearing a note", async () => {
  await putRow(h, "log_entries", id, row);
  await saveExtraNote(date, id, "  ");
  expect((await allOps(h))[0]).toMatchObject({ kind: "update", base_rev: 4,
    payload: { ...row, note: null } });
  expect(await getRow(h, "log_entries", id)).toEqual({ ...row, rev: 5, note: null });
  expect(getDay(date)?.extras?.[0].note).toBeUndefined();
});

it("queues an offline edit after a pending create without inventing or dropping items", async () => {
  await enqueue(h, { op_id: crypto.randomUUID(), entity: "log_entries", entity_id: id,
    kind: "create", base_rev: null, payload: row, client_ts: row.eaten_at });
  await saveExtraNote(date, id, " felt fine ");
  const ops = await allOps(h);
  expect(ops).toHaveLength(2);
  expect(ops[1]).toMatchObject({ kind: "update", base_rev: 1, payload: { note: "felt fine", items } });
});

it("serializes overlapping saves and skips a duplicate blur/close save", async () => {
  await putRow(h, "log_entries", id, row);
  await Promise.all([saveExtraNote(date, id, "first"), saveExtraNote(date, id, "second"),
    saveExtraNote(date, id, "second")]);
  expect((await allOps(h)).map((op) => [op.base_rev, op.payload.note])).toEqual([[4, "first"], [5, "second"]]);
});

it("records the note each edit replaces, so a conflict can tell her change from theirs", async () => {
  // Audit 2026-10-10 A077: the rebase reads this base; without it, it joined her note to the old one.
  await putRow(h, "log_entries", id, row);
  await saveExtraNote(date, id, "first");
  await saveExtraNote(date, id, "  ");
  expect((await allOps(h)).map((op) => op.note_base)).toEqual(["old", "first"]);
});

it("keeps legacy unbacked extras on their existing persistence path", async () => {
  await saveExtraNote(date, id, "legacy note");
  expect(await allOps(h)).toHaveLength(0);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(getDay(date)?.extras?.[0].note).toBe("legacy note");
});

it("recovers an older backed entry through an authenticated read", async () => {
  addExtra(date, { ...extra, id: "33333333-3333-4333-8333-333333333333", items: [{ ...items[0], snapshot: {},
    foodId: "catalog:71", name: "Food", portionLabel: "portion", macros: extra.macros }] });
  mocks.read.mockResolvedValueOnce({ data: { ...row, id: "33333333-3333-4333-8333-333333333333" }, error: null });
  await saveExtraNote(date, "33333333-3333-4333-8333-333333333333", "recovered");
  expect((await allOps(h))[0].payload.items).toEqual(items);
  expect(mocks.read).toHaveBeenCalledOnce();
});

it("does not pretend a failed durable queue saved the note", async () => {
  await putRow(h, "log_entries", id, row);
  mocks.enqueue.mockImplementationOnce(() => { throw new Error("disk full"); });
  await expect(saveExtraNote(date, id, "lost?")).rejects.toThrow("disk full");
  expect(getDay(date)?.extras?.[0].note).toBe("old");
  expect(await allOps(h)).toHaveLength(0);
});

it("can edit an online commit immediately offline, before any sync pull", async () => {
  const { commitLogEntry } = await import("@/lib/log-commit-client");
  const request = { entry_id: id, eaten_at: row.eaten_at, tz: row.tz, local_date: date,
    slot: "meal-1" as const, method: "search" as const, items, note: "old" };
  mocks.read.mockResolvedValueOnce({ data: { ...row, rev: 1 }, error: null });
  await commitLogEntry(request, { fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
    status: "ok", entry_id: id, rev: 1, items: items.map((item) => ({
      id: item.id, grams: item.grams, snapshot: item.snapshot,
    })), totals: {},
  }))) });
  await saveExtraNote(date, id, "offline edit");
  expect((await allOps(h))[0]).toMatchObject({ base_rev: 1, payload: { note: "offline edit", items } });
  expect(mocks.read).toHaveBeenCalledOnce();
});


it("caches the authoritative newer entry on an idempotent replay, preserving other-device edits", async () => {
  const { commitLogEntry } = await import("@/lib/log-commit-client");
  const newerItems = [{ ...items[0], grams: 180, qty: 2, snapshot: { iron: { amount: 4 } } }];
  const current = { ...row, rev: 8, note: "other device", items: newerItems };
  mocks.read.mockResolvedValueOnce({ data: current, error: null });
  await commitLogEntry({ entry_id: id, eaten_at: row.eaten_at, tz: row.tz, local_date: date,
    slot: "meal-1", method: "search", items, note: "original create" }, {
    fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "ok", entry_id: id, rev: 8, items: newerItems, totals: {},
    }))),
  });
  expect(await getRow(h, "log_entries", id)).toEqual(current);
  await saveExtraNote(date, id, "new note");
  expect((await allOps(h))[0]).toMatchObject({ base_rev: 8,
    payload: { note: "new note", items: newerItems } });
});

it("keeps a successful commit successful when its authoritative cache read fails", async () => {
  // T0 §3 changed what "successful" leaves behind. The commit is local-first, so the mirror
  // already holds this entry; a failed authoritative read now leaves it reconciled with the
  // server's own revision instead of leaving nothing at all.
  const { commitLogEntry } = await import("@/lib/log-commit-client");
  mocks.read.mockResolvedValueOnce({ data: null, error: new Error("offline") });
  const result = await commitLogEntry({ entry_id: id, eaten_at: row.eaten_at, tz: row.tz,
    local_date: date, slot: "meal-1", method: "search", items }, {
    fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "ok", entry_id: id, rev: 8, items, totals: {},
    }))),
  });
  expect(result.status).toBe("ok");
  expect(await getRow(h, "log_entries", id)).toMatchObject({ id, rev: 8 });
  expect(await allOps(h)).toHaveLength(0);
});

it("mirrors the server's own items when a reply describes ones we never sent", async () => {
  // A replay can answer with a revision another device produced. Its items are authoritative and
  // ours are not, so the mirror takes THEIRS beside THAT revision (panel round 7, item 3) — never
  // our items under their rev, which is what would let the next offline note edit overwrite that
  // device's work without a conflict.
  //
  // Whole items, since panel round 10 item 3: a revision stamped over items too thin to edit from
  // makes a row that looks editable and is not, so that answer leaves ours in place instead. The
  // case below is the one this test was always about — the server describing real items of its
  // own — and `refuses a revision over items too thin to edit from` owns the other.
  const { commitLogEntry } = await import("@/lib/log-commit-client");
  mocks.read.mockResolvedValueOnce({ data: null, error: new Error("offline") });
  const theirs = [{ id: "99999999-9999-4999-8999-999999999999", food_ref_id: id, seq: 1,
    grams: 400, qty: 2, unit: "portion", snapshot: { iron: { amount: 4 } } }];
  const result = await commitLogEntry({ entry_id: id, eaten_at: row.eaten_at, tz: row.tz,
    local_date: date, slot: "meal-1", method: "search", items }, {
    fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "ok", entry_id: id, rev: 12, items: theirs, totals: {},
    }))),
  });
  expect(result.status).toBe("ok");
  const mirrored = await getRow(h, "log_entries", id) as Record<string, unknown>;
  expect(mirrored.rev).toBe(12);
  expect(mirrored.items).toEqual(theirs);
});
