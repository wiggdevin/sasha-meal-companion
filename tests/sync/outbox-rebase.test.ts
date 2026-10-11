/**
 * Audit 2026-10-10, W011 slice 2: the outbox and the pull must never let one write of this
 * phone, or one pulled row, overwrite another write that is still on its way.
 *
 * - A165: a second op on the same row was aimed at the revision only its own predecessor could
 *   produce. Sent in one batch, a predecessor refused because another device wrote the row let the
 *   successor's compare-and-swap pass against THAT device's revision, and the phone's stale row
 *   went over it.
 * - A138: the answer to an older op wrote its payload over the mirror while a newer op was queued,
 *   so the next tap built on the older count.
 * - A164: a pulled echo of an applied op did the same from the pull side.
 * - A168: a pulled change skipped because an op was queued was lost for good when that op then
 *   settled without reading the row back (`duplicate`).
 *
 * Every case drives the real outbox and pull against tests/helpers/fake-sync-server.ts.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullChanges, pushOutbox } from "@/lib/sync/client";
import { allOps, getRow } from "@/lib/sync/idb";
import { enqueueWithRow } from "@/lib/sync/outbox";
import { addCups } from "@/lib/water-client";
import { saveExtraNote } from "@/lib/log-note-client";
import { savePlanDay } from "@/lib/plan-day-client";
import { addExtra, getDay } from "@/lib/store";
import { resetLiveCommits } from "@/lib/log/live-commits";
import { resetTestAccount } from "@/tests/helpers/account";
import { FakeSyncServer } from "@/tests/helpers/fake-sync-server";
import { device, onDevice } from "@/tests/helpers/sync-devices";
import type { AccountHandle } from "@/lib/device/account";
import type { LoggedFood } from "@/lib/types";

let server: FakeSyncServer;
let h: AccountHandle;

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: (_column: string, id: string) => ({
      maybeSingle: async () => ({ data: server.row("log_entries", id) ?? null, error: null }),
    }) }) }),
  }),
}));

const DAY = "2026-10-09";

/** One sync pass, a couple of minutes after the last: past any op's backoff. */
async function pass(): Promise<void> {
  vi.setSystemTime(Date.now() + 120_000);
  await pullChanges(h, undefined, { fetchFn: server.fetch });
  await pushOutbox(h, { fetchFn: server.fetch });
}

/** Another device's write, straight to the server at its current revision. */
function elsewhere(entity: "water_log" | "plan_days" | "log_entries" | "gut_log", key: string,
  change: Record<string, unknown>): void {
  const row = server.row(entity, key)!;
  const result = server.apply({ op_id: crypto.randomUUID(), entity, entity_id: key,
    kind: "update", base_rev: Number(row.rev), payload: { ...row, ...change },
    client_ts: new Date().toISOString() });
  expect(result.status).toBe("applied");
}

const cups = async () => Number((await getRow(h, "water_log", DAY))?.cups);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  h = await resetTestAccount();
  resetLiveCommits();
  server = new FakeSyncServer();
  await onDevice(device());
});

afterEach(() => { vi.useRealTimers(); });

describe("water taps while a push is on the wire (A138)", () => {
  it("keeps the newer tap when the older one's answer arrives", async () => {
    server.seed("water_log", DAY, { local_date: DAY, cups: 4 });
    await pass();
    await addCups(DAY, 1);
    server.duringPush = async () => { await addCups(DAY, 1); };
    await pass();
    // The first tap's answer must not put 5 back over the 6 the second tap shows.
    expect(await cups()).toBe(6);
    await addCups(DAY, 1);
    await pass();
    await pass();
    expect(server.row("water_log", DAY)?.cups).toBe(7);
    expect(await allOps(h)).toEqual([]);
  });
});

describe("a pulled echo while a later tap is queued (A164)", () => {
  it("never rolls the mirror back past the queued tap", async () => {
    server.seed("water_log", DAY, { local_date: DAY, cups: 3 });
    await pass();
    await addCups(DAY, 1);
    await pass(); // applied as rev 2; its echo is in the feed
    await addCups(DAY, 1); // 5, queued
    server.nextPush = "down";
    await pass(); // the pull meets the echo of 4 while 5 is still queued
    expect(await cups()).toBe(5);
    await addCups(DAY, 1);
    await pass();
    await pass();
    expect(server.row("water_log", DAY)?.cups).toBe(6);
  });
});

describe("a change skipped for a queued op, then a lost answer (A168)", () => {
  it("re-reads another device's change to the day once the op settles as a duplicate", async () => {
    server.seed("plan_days", DAY, { local_date: DAY, day_type_override: null, floor_day: false,
      swaps: {}, slot_notes: {}, item_overrides: {}, eaten_slots: {} });
    await pass();
    await savePlanDay(DAY, { floorDay: true });
    server.nextPush = "lost"; // committed as rev 2; the phone never hears
    await pass();
    elsewhere("plan_days", DAY, { swaps: { "meal-1": "oats" } }); // the tablet, rev 3
    await pass(); // pull skips both (op queued); the re-push answers duplicate
    await pass(); // the skipped change is read again
    expect(await allOps(h)).toEqual([]);
    expect(await getRow(h, "plan_days", DAY)).toMatchObject({ rev: 3, floor_day: true,
      swaps: { "meal-1": "oats" } });
    expect(getDay(DAY)?.swaps?.["meal-1"]).toBe("oats");
  });

  it("does the same for an entity with no plan projection", async () => {
    server.seed("water_log", DAY, { local_date: DAY, cups: 3 });
    await pass();
    await addCups(DAY, 1);
    server.nextPush = "lost";
    await pass();
    elsewhere("water_log", DAY, { cups: 9 });
    await pass();
    await pass();
    expect(await getRow(h, "water_log", DAY)).toMatchObject({ rev: 3, cups: 9 });
  });
});

describe("two queued writes to one row, and another device in between (A165)", () => {
  const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
  const ITEM = { id: "bbbbbbbb-2222-4222-8222-222222222222", entry_id: ENTRY_ID, seq: 1,
    food_ref_id: "cccccccc-3333-4333-8333-333333333333", qty: 1, unit: "g", grams: 150,
    snapshot: {} };
  const CARD: LoggedFood = { id: ENTRY_ID, foodId: "rice", name: "Rice", portionLabel: "150 g",
    qty: 1, grams: 150, macros: { kcal: 195, protein: 4, carbs: 42, fat: 0.4 },
    at: "2026-10-09T17:00:00.000Z" };

  it("never lets the second note edit undo another device's move", async () => {
    server.seed("log_entries", ENTRY_ID, { id: ENTRY_ID, local_date: DAY, tz: "UTC",
      slot: "meal-2", method: "search", eaten_at: CARD.at, note: null, items: [ITEM] });
    addExtra(DAY, CARD);
    await pass();
    // Offline: two edits of her note.
    await saveExtraNote(DAY, ENTRY_ID, "felt fine");
    await saveExtraNote(DAY, ENTRY_ID, "felt fine, then good");
    // The coach on the tablet moves the meal to lunch the next day.
    elsewhere("log_entries", ENTRY_ID, { local_date: "2026-10-10", slot: "meal-1",
      eaten_at: "2026-10-10T12:00:00.000Z" });
    for (let i = 0; i < 4; i += 1) await pass();

    expect(await allOps(h)).toEqual([]);
    expect(server.row("log_entries", ENTRY_ID)).toMatchObject({ local_date: "2026-10-10",
      slot: "meal-1", eaten_at: "2026-10-10T12:00:00.000Z", note: "felt fine, then good" });
  });

  it("sends one op per row per push, the oldest first", async () => {
    server.seed("water_log", DAY, { local_date: DAY, cups: 1 });
    await pass();
    await addCups(DAY, 1);
    await addCups(DAY, 1);
    await pass();
    expect(server.received.map((op) => op.base_rev)).toEqual([1]);
    await pass();
    expect(server.received.map((op) => op.base_rev)).toEqual([1, 2]);
    expect(server.row("water_log", DAY)?.cups).toBe(3);
  });

  it("folds every queued edit of the row into one rebase, so the older never lands last", async () => {
    const ID = "dddddddd-4444-4444-8444-444444444444";
    server.seed("gut_log", ID, { id: ID, local_date: DAY, state: "fine", note: null });
    await pass();
    const row = (await getRow(h, "gut_log", ID))!;
    elsewhere("gut_log", ID, { note: "after the gym" }); // rev 2, before the phone's edits land
    vi.setSystemTime(Date.now() + 1_000);
    await enqueueWithRow(h, { ...row, state: "iffy", rev: 2 }, { op_id: crypto.randomUUID(),
      entity: "gut_log", entity_id: ID, kind: "update", base_rev: 1,
      payload: { id: ID, local_date: DAY, state: "iffy" }, client_ts: new Date().toISOString() });
    vi.setSystemTime(Date.now() + 1_000);
    await enqueueWithRow(h, { ...row, state: "flare", rev: 3 }, { op_id: crypto.randomUUID(),
      entity: "gut_log", entity_id: ID, kind: "update", base_rev: 2,
      payload: { id: ID, local_date: DAY, state: "flare" }, client_ts: new Date().toISOString() });

    await pass();
    // Refused once, and re-aimed as ONE op carrying her latest edit, ahead of nothing older.
    const queued = await allOps(h);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ base_rev: 2, payload: { state: "flare", note: "after the gym" } });
    await pass();

    expect(await allOps(h)).toEqual([]);
    expect(server.row("gut_log", ID)).toMatchObject({ state: "flare", note: "after the gym" });
  });
});
