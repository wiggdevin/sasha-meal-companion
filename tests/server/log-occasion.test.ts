import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { POST as syncOps } from "@/app/api/sync/ops/route";
import { requireUser } from "@/lib/server/auth";
import { stampLogOccasions } from "@/lib/server/log-occasion";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const entry = (id: string, userId: string, slot: string, extra: Row = {}): Row => ({
  id, user_id: userId, slot, local_date: "2026-10-04", eaten_at: "2026-10-04T12:15:00Z", tz: "UTC",
  occasion: null, occasion_source: null, deleted_at: null, ...extra,
});

function db(entries: Row[], planDays: Row[] = []) {
  return fakeDb({
    log_entries: entries,
    user_settings: [{ user_id: A, slot_times: {}, shift_minutes: 0, meals_per_day: 4 },
      { user_id: B, slot_times: { "meal-1": "19:00" }, shift_minutes: 0, meals_per_day: 4 }],
    plan_days: planDays,
    target_profiles: [],
  });
}

describe("log occasion stamp (D1)", () => {
  it("stamps an entry from its slot's clock on the account's schedule", async () => {
    const fake = db([entry("e1", A, "meal-1"), entry("e2", A, "meal-4")]);
    expect(await stampLogOccasions(fake.client, A, { ids: ["e1", "e2"] })).toBe(2);
    expect(fake.tables.log_entries.map((row) => [row.occasion, row.occasion_source]))
      .toEqual([["breakfast", "slot_clock"], ["dinner", "slot_clock"]]);
    // Every read and write names the account explicitly; the write is guarded on slot and date.
    for (const query of fake.queries.filter((q) => q.table === "log_entries")) {
      expect(query.filters).toContain("eq:user_id");
    }
    const update = fake.queries.find((q) => q.op === "update");
    expect(update?.filters).toEqual(expect.arrayContaining(["eq:slot", "eq:local_date", "is:deleted_at"]));
  });

  it("uses that day's time edit for the slot", async () => {
    const fake = db([entry("e1", A, "meal-1")],
      [{ user_id: A, local_date: "2026-10-04", item_overrides: { "meal-1": { time: "13:00" } } }]);
    await stampLogOccasions(fake.client, A, { ids: ["e1"] });
    expect(fake.tables.log_entries[0].occasion).toBe("lunch");
  });

  it("restamps a moved entry (its stamp cleared by the move) and never recomputes an existing stamp", async () => {
    // e1 was moved to meal-4: the migration's trigger cleared its stamp in that write.
    // e2 was stamped breakfast at log time; the schedule changed since. Its stamp stays.
    const fake = db([entry("e1", A, "meal-4"),
      entry("e2", A, "meal-1", { occasion: "breakfast", occasion_source: "slot_clock" })]);
    fake.tables.user_settings[0].slot_times = { "meal-1": "19:00" };
    expect(await stampLogOccasions(fake.client, A, { ids: ["e1", "e2"] })).toBe(1);
    expect(fake.tables.log_entries.map((row) => row.occasion)).toEqual(["dinner", "breakfast"]);
  });

  it("stamps only the ids written: an older pre-migration null row in the same slot stays null (Sol r4 BLOCK 2)", async () => {
    const fake = db([entry("old", A, "meal-1"), entry("new", A, "meal-1")]);
    await stampLogOccasions(fake.client, A, { ids: ["new"] });
    expect(fake.tables.log_entries.map((row) => [row.id, row.occasion])).toEqual([["old", null], ["new", "breakfast"]]);
  });

  it("never touches another account's entry, a deleted entry or the user's own choice", async () => {
    const fake = db([entry("b1", B, "meal-1"), entry("e1", A, "meal-1", { deleted_at: "2026-10-04T13:00:00Z" }),
      entry("e2", A, "meal-1", { occasion: "dinner", occasion_source: "user" })]);
    expect(await stampLogOccasions(fake.client, A, { ids: ["b1", "e1", "e2"] })).toBe(0);
    expect(fake.tables.log_entries.map((row) => row.occasion)).toEqual([null, null, "dinner"]);
  });

  it("never overwrites a user's choice made after the read (BLOCK 1)", async () => {
    const fake = db([entry("e1", A, "meal-1")]);
    // The user's own write lands between the stamp's read and its update.
    const from = fake.client.from.bind(fake.client);
    let reads = 0;
    (fake.client as unknown as { from: unknown }).from = (table: string) => {
      if (table === "log_entries" && (reads += 1) === 2) {
        Object.assign(fake.tables.log_entries[0], { occasion: "dinner", occasion_source: "user" });
      }
      return from(table);
    };
    expect(await stampLogOccasions(fake.client, A, { ids: ["e1"] })).toBe(0);
    expect(fake.tables.log_entries[0]).toMatchObject({ occasion: "dinner", occasion_source: "user" });
    const update = fake.queries.find((q) => q.op === "update");
    expect(update?.filters).toEqual(expect.arrayContaining(["is:occasion_source", "is:occasion"]));
  });

  it("never commits an occasion computed from an eating time edited after the read (Sol r3 BLOCK 2)", async () => {
    const fake = db([entry("s1", A, "snack", { eaten_at: "2026-10-04T08:00:00Z" })]);
    const from = fake.client.from.bind(fake.client);
    let reads = 0;
    (fake.client as unknown as { from: unknown }).from = (table: string) => {
      if (table === "log_entries" && (reads += 1) === 2) fake.tables.log_entries[0].eaten_at = "2026-10-04T20:00:00Z";
      return from(table);
    };
    expect(await stampLogOccasions(fake.client, A, { ids: ["s1"] })).toBe(0);
    expect(fake.tables.log_entries[0].occasion).toBeNull();
    // The edit's own op restamps it from the time it now holds.
    (fake.client as unknown as { from: unknown }).from = from;
    await stampLogOccasions(fake.client, A, { ids: ["s1"] });
    expect(fake.tables.log_entries[0].occasion).toBe("dinner");
    const update = fake.queries.find((q) => q.op === "update");
    expect(update?.filters).toEqual(expect.arrayContaining(["eq:eaten_at", "eq:tz"]));
  });

  it("a past entry's meal count comes from the target in force on its own date (Sol r4 BLOCK 1)", async () => {
    const fake = fakeDb({
      log_entries: [entry("sept", A, "meal-3", { local_date: "2026-09-20" })],
      user_settings: [{ user_id: A, slot_times: {}, shift_minutes: 0, meals_per_day: null }],
      plan_days: [],
      // September: 1,700 kcal → three meals, meal-3 at 18:30 (dinner). October: 3,000 kcal → five.
      target_profiles: [
        { user_id: A, effective_from: "2026-09-01", rev: 1, training_macros: { kcal: 1700 } },
        { user_id: A, effective_from: "2026-10-01", rev: 2, training_macros: { kcal: 3000 } },
      ],
    });
    await stampLogOccasions(fake.client, A, { ids: ["sept"] });
    expect(fake.tables.log_entries[0].occasion).toBe("dinner");
  });

  it("takes the meal count from the active target when the account chose none", async () => {
    const fake = fakeDb({
      log_entries: [entry("e1", A, "meal-3")],
      user_settings: [{ user_id: A, slot_times: {}, shift_minutes: 0, meals_per_day: null }],
      plan_days: [],
      // > 2600 kcal: five meals, meal-3 at 13:30 (three meals would put it at 18:30).
      target_profiles: [{ user_id: A, effective_from: "2026-09-01", rev: 1, training_macros: { kcal: 3000 } }],
    });
    await stampLogOccasions(fake.client, A, { ids: ["e1"] });
    expect(fake.tables.log_entries[0].occasion).toBe("lunch");
  });

  it("the recipe eaten route writes no log entry and stamps nothing", async () => {
    const source = readFileSync(path.join(process.cwd(), "app/api/recipes/consumed/route.ts"), "utf8");
    expect(source).not.toMatch(/stampLogOccasions/);
  });
});

describe("every log path stamps after the write, with no client change", () => {
  it("POST /api/sync/ops stamps an applied log_entries op (an old client's offline log)", async () => {
    resetRateLimits();
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const fake = db([]);
    const applied = fakeDb(fake.tables, (_name, args) => {
      const op = args.p_op as { entity_id: string; payload: Row };
      fake.tables.log_entries.push(entry(op.entity_id, A, op.payload.slot as string));
      return { op_id: (args.p_op as { op_id: string }).op_id, status: "applied", rev: 1, seq: 1 };
    });
    vi.mocked(requireUser).mockResolvedValue({ userId: A, client: applied.client } as Awaited<ReturnType<typeof requireUser>>);
    const op = { op_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", entity: "log_entries", entity_id: id, kind: "create",
      base_rev: null, client_ts: "2026-10-04T12:15:00Z", user_id: A,
      payload: { slot: "meal-2", local_date: "2026-10-04", eaten_at: "2026-10-04T12:15:00Z", tz: "UTC", method: "search",
        items: [] } };
    const res = await syncOps(new Request("http://x/api/sync/ops", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ops: [op] }) }));
    expect((await res.json()).results[0].status).toBe("applied");
    expect(fake.tables.log_entries[0]).toMatchObject({ id, occasion: "lunch", occasion_source: "slot_clock" });
  });

  for (const [name, outcome] of [["conflicted", "conflict"], ["replayed", "duplicate"], ["errored", "throw"]] as const) {
    it(`a ${name} log op writes nothing here, so an old unstamped row with its id stays null (Sol r5 BLOCK 1)`, async () => {
      resetRateLimits();
      const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
      const fake = db([entry(id, A, "meal-4")]);
      const client = fakeDb(fake.tables, (_name, args) => {
        if (outcome === "throw") throw new Error("connection reset");
        return { op_id: (args.p_op as { op_id: string }).op_id, status: outcome, entity: "log_entries",
          current_rev: 3, current: {} };
      });
      vi.mocked(requireUser).mockResolvedValue({ userId: A, client: client.client } as Awaited<ReturnType<typeof requireUser>>);
      const op = { op_id: "ffffffff-ffff-4fff-8fff-fffffffffff1", entity: "log_entries", entity_id: id, kind: "update",
        base_rev: 1, client_ts: "2026-10-04T12:15:00Z", user_id: A,
        payload: { slot: "meal-4", local_date: "2026-10-04", eaten_at: "2026-10-04T12:15:00Z", tz: "UTC", method: "search",
          items: [] } };
      await syncOps(new Request("http://x/api/sync/ops", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ ops: [op] }) }));
      expect(fake.tables.log_entries[0].occasion).toBeNull();
    });
  }
});
